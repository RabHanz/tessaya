//! Baton's native dictation: Handy's engine stack (transcribe.cpp, handy-recorder, handy-keys) and
//! its Windows paste, behind JSON lines on stdin/stdout, so Electron stays out of the audio path.
//! See docs/baton/VOICE.md. Run with no arguments it serves; the subcommands are for voice-lab.
#[cfg(unix)]
mod desktop_unix;
mod keys;
#[cfg_attr(not(windows), allow(dead_code))]
mod mouse;
#[cfg(windows)]
mod mouse_windows;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod changes;
#[cfg(windows)]
mod input_windows;
mod live;
#[cfg(windows)]
mod paste_windows;
#[cfg(any(windows, test))]
mod paste_tx;

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use enigo::Enigo;
#[cfg(not(target_os = "linux"))]
use enigo::Settings;
use handy_keys::{Hotkey, HotkeyManager, HotkeyState};
use handy_recorder::{
    list_input_devices, AudioChunk, Channels, Recorder, RecorderConfig, Sink,
};
use keys::PasteMethod;
use live::{lift_gain, words_after, ChunkParams, Chunker, Piece};
use serde::Deserialize;
use serde_json::{json, Value};
use transcribe_cpp::{
    init_backends_with, BackendMask, Feature, Model, RunOptions, Session, SessionOptions, TimestampKind,
};

const IDLE_UNLOAD: Duration = Duration::from_secs(600);
/// The caret's place is read as a dictation starts; past this the words go in the pill instead.
const CARET_AT_DEADLINE: Duration = Duration::from_millis(300);
/// How often an idle engine looks for a model slot it can let go.
const IDLE_TICK: Duration = Duration::from_secs(60);
const MIN_SAMPLES: usize = 16_000 / 4;
/// A tap of the remote's button must not listen forever. What was said is kept, never pasted.
const MAX_RECORDING: Duration = Duration::from_secs(3600);
/// Parakeet clips the last word without a little trailing silence.
const TAIL_SAMPLES: usize = 16_000 / 5;

fn emit(event: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{event}");
    let _ = out.flush();
}

/// A hotkey setting as a list: null, one string, or an array of strings.
fn keys_list<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Keys {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<Keys>::deserialize(deserializer)? {
        None => Vec::new(),
        Some(Keys::One(key)) => vec![key],
        Some(Keys::Many(keys)) => keys,
    })
}

#[derive(Deserialize, Default, Clone)]
struct Config {
    model: Option<PathBuf>,
    /// One key or several: any of them holds. The desktop sends a list; an older one sent a string.
    #[serde(default, deserialize_with = "keys_list")]
    hold: Vec<String>,
    #[serde(default, deserialize_with = "keys_list")]
    toggle: Vec<String>,
    device: Option<String>,
    /// One input of a multi-input interface: the AT2020 is input 1 of the Scarlett.
    channel: Option<u16>,
    #[serde(default)]
    paste: PasteMethod,
    language: Option<String>,
    /// `input-bindings.json`: the mouse buttons Baton listens for. Absent or empty: no hook at all.
    #[serde(default)]
    mouse: Option<PathBuf>,
    /// The desktop cleans the text up first, then pastes it with `target`.
    #[serde(default)]
    cleanup: bool,
    /// Two quick taps of the hold key keep the microphone open until the next press.
    #[serde(default)]
    latch: bool,
    /// He chose cloud recognition: each recording is written as a WAV into this private folder (the desktop's, 0700) and
    /// handed back, not run through the local model.
    #[serde(default)]
    external: Option<PathBuf>,
    /// The desktop says this machine has the memory to keep the dictation model loaded between dictations.
    #[serde(default, rename = "keepLoaded")]
    keep_loaded: bool,
}

enum Msg {
    Line(String),
    Key { hold: bool, pressed: bool },
    MicFailed(String),
    /// A fake microphone ran out of file, which stands in for releasing the key.
    FakeEnded,
    Finished { id: Option<u64>, dictated: bool, target: Option<isize>, result: Result<Done, String> },
}

struct Done {
    text: String,
    audio_ms: u64,
    infer_ms: u64,
    load_ms: u64,
    /// From key release to text; None for a clip that was never live.
    release_ms: Option<u64>,
    pieces: u64,
    /// The recording as a WAV for the desktop to recognise (cloud); the text is then empty.
    wav: Option<String>,
    /// The model file a clip sent to `transcribe` was recognised with, for the turn log; None for a live recording.
    model: Option<String>,
    /// A dictation's stage times from its key press, for the desktop's `dictation_timing`; None for a clip.
    timing: Option<Value>,
}

struct Job {
    id: Option<u64>,
    dictated: bool,
    /// The window to paste back into; None never pastes.
    target: Option<isize>,
    pcm: Vec<f32>,
    model: PathBuf,
    language: Option<String>,
    /// Sent by the wake path with a model of its own: it lives in the engine's second slot.
    wake: bool,
}

// The timings and the table are docs/baton/fixtures/double-tap.json; the sidecar is the only implementation.
const SHORT_TAP_MS: f64 = 200.0;
const FIRST_PRESS_MS: f64 = 350.0;
const GAP_MS: f64 = 350.0;
const HOLD_MS: f64 = 600.0;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Idle,
    Tapped { up_at: f64 },
    Holding { down_at: f64, after_tap: bool },
    Latched,
    LatchedDown,
}

/// What the hold key asks of the recorder. Latch and Unlatch change nothing the recorder sees.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Out {
    Start,
    Stop,
    Cancel,
    Latch,
    Unlatch,
}

/// Hold to talk, or tap twice to keep talking: a short tap is cancelled, a second quick tap latches the microphone open, and
/// the next press ends it. Times are milliseconds from any start; events out of order or out of place are ignored.
#[derive(Debug)]
struct PushToTalk {
    phase: Phase,
    last_at: f64,
}

impl Default for PushToTalk {
    fn default() -> Self {
        PushToTalk { phase: Phase::Idle, last_at: f64::NEG_INFINITY }
    }
}

impl PushToTalk {
    fn step(&mut self, down: bool, at: f64, double_tap: bool) -> Vec<Out> {
        if !at.is_finite() || at < self.last_at {
            return vec![];
        }
        if down {
            return match self.phase {
                Phase::Idle | Phase::Tapped { .. } => {
                    let after_tap = double_tap && matches!(self.phase, Phase::Tapped { up_at } if at - up_at <= GAP_MS);
                    self.phase = Phase::Holding { down_at: at, after_tap };
                    self.last_at = at;
                    vec![Out::Start]
                }
                Phase::Latched => {
                    self.phase = Phase::LatchedDown;
                    self.last_at = at;
                    vec![]
                }
                _ => vec![],
            };
        }
        match self.phase {
            Phase::Holding { down_at, after_tap } => {
                self.last_at = at;
                if !double_tap {
                    self.phase = Phase::Idle;
                    return vec![Out::Stop];
                }
                let held = at - down_at;
                if after_tap && held <= HOLD_MS {
                    self.phase = Phase::Latched;
                    return vec![Out::Latch];
                }
                let out = if held < SHORT_TAP_MS { Out::Cancel } else { Out::Stop };
                self.phase = if !after_tap && held < FIRST_PRESS_MS { Phase::Tapped { up_at: at } } else { Phase::Idle };
                vec![out]
            }
            Phase::LatchedDown => {
                self.phase = Phase::Idle;
                self.last_at = at;
                vec![Out::Unlatch, Out::Stop]
            }
            _ => vec![],
        }
    }

    fn name(&self) -> &'static str {
        match self.phase {
            Phase::Idle => "idle",
            Phase::Tapped { .. } => "tapped",
            Phase::Holding { .. } => "holding",
            Phase::Latched => "latched",
            Phase::LatchedDown => "latchedDown",
        }
    }
}

enum Work {
    Clip(Job),
    /// Load the model now, so the first real phrase does not wait behind it.
    Load { id: Option<u64>, model: PathBuf },
    Begin { model: PathBuf, language: Option<String>, external: Option<PathBuf> },
    Audio(Vec<f32>),
    End { target: Option<isize>, released: Instant, timing: Value },
    Abort,
    /// Dictation is bound to a key and heard here: the dictation model stays loaded, so a press never waits on a reload.
    Keep(bool),
}

/// The cores this process may run on. std's count ignores a Windows affinity mask, so a process pinned to one core (a
/// one-core job, a limited VM, the starved-start proof) would still be given threads for four.
fn usable_cores() -> usize {
    let std_cores = thread::available_parallelism().map_or(4, |n| n.get());
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessAffinityMask};
        let (mut process, mut system) = (0usize, 0usize);
        // SAFETY: both out-pointers are valid for the duration of the call.
        if unsafe { GetProcessAffinityMask(GetCurrentProcess(), &mut process, &mut system) }.is_ok() && process != 0 {
            return (process.count_ones() as usize).min(std_cores.max(1));
        }
    }
    std_cores
}

/// Half the cores, at least two, but never more threads than cores: ggml's threads wait for each other by spinning, so two
/// threads on one core (a one-core machine, or the app pinned to one) can crawl for minutes instead of seconds.
fn default_threads(cores: usize) -> i32 {
    (cores / 2).max(2).min(cores.max(1)) as i32
}

fn load(model: &Path) -> Result<(Session, u64), String> {
    let started = Instant::now();
    // ggml loses more than it gains on hyperthreads; BATON_THREADS is for measuring that.
    let n_threads = std::env::var("BATON_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| default_threads(usable_cores()));
    let session = Model::load(model)
        .and_then(|m| m.session_with(&SessionOptions { n_threads, ..Default::default() }))
        .map_err(|e| format!("could not load {}: {e}", model.display()))?;
    Ok((session, started.elapsed().as_millis() as u64))
}

fn infer(session: &mut Session, pcm: &mut Vec<f32>, language: Option<String>) -> Result<(String, u64, u64), String> {
    let audio_ms = pcm.len() as u64 / 16;
    lift_gain(pcm);
    pcm.resize(pcm.len() + TAIL_SAMPLES, 0.0);
    let started = Instant::now();
    let options = RunOptions { language, ..Default::default() };
    let result = session.run(pcm, &options).map_err(|e| format!("transcribe: {e}"))?;
    Ok((result.text.trim().to_string(), audio_ms, started.elapsed().as_millis() as u64))
}

/// The new words of one piece; the context before them only helps the model hear them.
fn decode_piece(session: &mut Session, piece: Piece, language: Option<String>) -> Result<String, String> {
    let Piece { mut pcm, context, .. } = piece;
    lift_gain(&mut pcm);
    pcm.resize(pcm.len() + TAIL_SAMPLES, 0.0);
    let options = RunOptions { language, timestamps: TimestampKind::Word, ..Default::default() };
    let result = session.run(&pcm, &options).map_err(|e| format!("transcribe: {e}"))?;
    if context == 0 || result.words.is_empty() {
        return Ok(result.text.trim().to_string());
    }
    Ok(words_after(result.words.iter().map(|w| (w.t0_ms, w.text.as_str())), context as i64 / 16))
}

/// One recording on its way through the model.
struct Live {
    chunker: Chunker,
    /// Everything heard: a piece that fails falls back to the whole recording.
    heard: Vec<f32>,
    language: Option<String>,
    text: Vec<String>,
    load_ms: u64,
    infer_ms: u64,
    pieces: u64,
    failed: Option<String>,
    /// Kept whole for the desktop's recogniser in this folder; nothing is decoded here.
    external: Option<PathBuf>,
}

impl Live {
    fn new(language: Option<String>, load_ms: u64, failed: Option<String>) -> Self {
        Self {
            external: None,
            chunker: Chunker::new(ChunkParams::from_env()),
            heard: Vec::new(),
            language,
            text: Vec::new(),
            load_ms,
            infer_ms: 0,
            pieces: 0,
            failed,
        }
    }

    fn decode(&mut self, session: &mut Session, piece: Piece) {
        let started = Instant::now();
        let at_pause = piece.at_pause;
        match decode_piece(session, piece, self.language.clone()) {
            Ok(text) if text.is_empty() => {}
            Ok(text) => {
                self.text.push(text);
                // The words so far, for the pill to show as he speaks. At a pause they may be all of it: the desktop
                // starts their cleanup then, so a release right after finds it done.
                emit(json!({"ev": "partial", "text": self.text.join(" "), "pause": at_pause}));
            }
            Err(e) => self.failed = Some(e),
        }
        self.infer_ms += started.elapsed().as_millis() as u64;
        self.pieces += 1;
    }

    fn finish(mut self, session: Option<&mut Session>, released: Instant) -> Result<Done, String> {
        let audio_ms = self.heard.len() as u64 / 16;
        if let Some(dir) = &self.external {
            let wav = write_wav(dir, &self.heard)?;
            return Ok(Done {
                text: String::new(),
                audio_ms,
                infer_ms: 0,
                load_ms: 0,
                release_ms: Some(released.elapsed().as_millis() as u64),
                pieces: 0,
                wav: Some(wav),
                model: None,
                timing: None,
            });
        }
        let session = session.ok_or_else(|| self.failed.clone().unwrap_or_else(|| "no model".to_string()))?;
        if self.failed.is_none() && !self.chunker.pending_is_quiet(&self.heard) {
            if let Some(piece) = self.chunker.finish() {
                self.decode(session, piece);
            }
        }
        let text = if self.failed.is_some() {
            infer(session, &mut self.heard, self.language.clone())?.0
        } else {
            self.text.join(" ")
        };
        Ok(Done {
            text,
            audio_ms,
            infer_ms: self.infer_ms,
            load_ms: self.load_ms,
            release_ms: Some(released.elapsed().as_millis() as u64),
            pieces: self.pieces,
            wav: None,
            model: None,
            timing: None,
        })
    }
}

/// A recording as 16 kHz mono 16-bit WAV in the desktop's private folder; the desktop deletes it once it has the words,
/// and a file that failed half-way is removed here.
fn write_wav(dir: &Path, pcm: &[f32]) -> Result<String, String> {
    let path = dir.join(format!(
        "tessaya-dictation-{}-{}.wav",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos())
    ));
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let written = (|| {
        let mut writer = hound::WavWriter::create(&path, spec)?;
        for &sample in pcm {
            writer.write_sample((sample.clamp(-1.0, 1.0) * 32767.0) as i16)?;
        }
        writer.finalize()
    })();
    match written {
        Ok(()) => Ok(path.to_string_lossy().into_owned()),
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(format!("{}: {e}", path.display()))
        }
    }
}

fn ensure_loaded(loaded: &mut Option<(PathBuf, Session)>, model: &Path) -> Result<u64, String> {
    if loaded.as_ref().is_some_and(|(path, _)| path == model) {
        return Ok(0);
    }
    *loaded = None;
    // A load on a busy computer can take minutes. The desktop cannot tell that from a hang unless it hears this: one line a
    // second while the file is read, so it waits for as long as the load is making progress and no longer.
    let done = Arc::new(AtomicBool::new(false));
    {
        let done = done.clone();
        thread::spawn(move || {
            let started = Instant::now();
            while !done.load(Ordering::Relaxed) {
                emit(json!({"ev": "loading", "elapsedMs": started.elapsed().as_millis() as u64}));
                for _ in 0..10 {
                    if done.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        });
    }
    let result = load(model);
    done.store(true, Ordering::Relaxed);
    let (session, ms) = result?;
    *loaded = Some((model.to_path_buf(), session));
    Ok(ms)
}

/// Which engine slot serves a request. `Main` is dictation's; the wake path's own model lives in `Wake`, so neither
/// reloads the other's on every turn. A model already in a slot is never loaded into the other.
#[derive(Debug, PartialEq)]
enum Slot {
    Main,
    Wake,
    /// Dictation's model is in the wake slot (he switched models): swap the slots, then use `Main`.
    SwapThenMain,
}

fn plan_slot(wake: bool, main: Option<&Path>, other: Option<&Path>, wanted: &Path) -> Slot {
    if main == Some(wanted) {
        Slot::Main
    } else if wake {
        Slot::Wake
    } else if other == Some(wanted) {
        Slot::SwapThenMain
    } else {
        Slot::Main
    }
}

type Loaded = Option<(PathBuf, Session)>;

fn path_of(slot: &Loaded) -> Option<&Path> {
    slot.as_ref().map(|(path, _)| path.as_path())
}

/// One thread owns the models. Each slot loads on first use and leaves after ten idle minutes of its own, because
/// 16 GB is shared with everything else on the laptop; the dictation slot stays while dictation is bound (`Keep`).
/// v3 held is about 1.2 GB.
fn engine_thread(work: Receiver<Work>, out: Sender<Msg>) {
    let mut loaded: Loaded = None;
    let mut other: Loaded = None;
    let mut loaded_at = Instant::now();
    let mut other_at = Instant::now();
    let mut live: Option<Live> = None;
    let mut keep = false;
    loop {
        let message = work.recv_timeout(IDLE_TICK);
        if live.is_none() && !keep && loaded_at.elapsed() >= IDLE_UNLOAD {
            loaded = None;
        }
        if other_at.elapsed() >= IDLE_UNLOAD {
            other = None;
        }
        match message {
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
            Ok(Work::Clip(mut job)) => {
                let plan = plan_slot(job.wake, path_of(&loaded), path_of(&other), &job.model);
                if plan == Slot::SwapThenMain {
                    std::mem::swap(&mut loaded, &mut other);
                }
                let slot = if plan == Slot::Wake {
                    other_at = Instant::now();
                    &mut other
                } else {
                    loaded_at = Instant::now();
                    &mut loaded
                };
                let model = job.model.file_name().map(|name| name.to_string_lossy().into_owned());
                let result = ensure_loaded(slot, &job.model).and_then(|load_ms| {
                    let session = &mut slot.as_mut().expect("loaded above").1;
                    infer(session, &mut job.pcm, job.language.take()).map(|(text, audio_ms, infer_ms)| Done {
                        text,
                        audio_ms,
                        infer_ms,
                        load_ms,
                        release_ms: None,
                        pieces: 1,
                        wav: None,
                        model,
                        timing: None,
                    })
                });
                let _ = out.send(Msg::Finished { id: job.id, dictated: job.dictated, target: job.target, result });
            }
            Ok(Work::Load { id, model }) => {
                if plan_slot(false, path_of(&loaded), path_of(&other), &model) == Slot::SwapThenMain {
                    std::mem::swap(&mut loaded, &mut other);
                }
                loaded_at = Instant::now();
                let line = match ensure_loaded(&mut loaded, &model) {
                    Ok(load_ms) => json!({"ev": "model_ready", "id": id, "loadMs": load_ms}),
                    Err(error) => json!({"ev": "model_ready", "id": id, "error": error}),
                };
                emit(line);
            }
            Ok(Work::Begin { external: Some(dir), language, .. }) => {
                live = Some(Live { external: Some(dir), ..Live::new(language, 0, None) });
            }
            Ok(Work::Begin { model, language, external: None }) => {
                if plan_slot(false, path_of(&loaded), path_of(&other), &model) == Slot::SwapThenMain {
                    std::mem::swap(&mut loaded, &mut other);
                }
                loaded_at = Instant::now();
                live = Some(match ensure_loaded(&mut loaded, &model) {
                    Ok(load_ms) => Live::new(language, load_ms, None),
                    Err(e) => {
                        loaded = None;
                        Live::new(language, 0, Some(e))
                    }
                });
            }
            Ok(Work::Audio(pcm)) => {
                loaded_at = Instant::now();
                let Some(current) = live.as_mut() else { continue };
                current.heard.extend_from_slice(&pcm);
                if current.failed.is_none() && current.external.is_none() {
                    if let (Some(piece), Some((_, session))) = (current.chunker.push(&pcm), loaded.as_mut()) {
                        current.decode(session, piece);
                    }
                }
            }
            Ok(Work::End { target, released, timing }) => {
                let Some(current) = live.take() else { continue };
                let result = current
                    .finish(loaded.as_mut().map(|(_, session)| session), released)
                    .map(|done| Done { timing: Some(timing), ..done });
                let _ = out.send(Msg::Finished { id: None, dictated: true, target, result });
            }
            Ok(Work::Abort) => live = None,
            Ok(Work::Keep(on)) => {
                keep = on;
                loaded_at = Instant::now();
            }
        }
    }
}

fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let spec = reader.spec();
    if spec.sample_rate != 16_000 || spec.channels != 1 || spec.bits_per_sample != 16 {
        return Err(format!("{}: needs 16 kHz mono 16-bit", path.display()));
    }
    reader
        .samples::<i16>()
        .map(|s| s.map(|v| v as f32 / 32768.0).map_err(|e| e.to_string()))
        .collect()
}

fn devices_json() -> Value {
    *DEVICE_ID.lock().unwrap_or_else(|e| e.into_inner()) = None;
    match list_input_devices() {
        Ok(devices) => devices
            .iter()
            .map(|d| json!({"id": d.id, "name": d.name, "channels": d.channels, "isDefault": d.is_default}))
            .collect(),
        Err(_) => json!([]),
    }
}

/// The chosen microphone's id by its name. Listing every input on each press costs time on Windows, so the id is
/// kept; a press whose open fails with it, and a device change (`devices`), look it up again.
static DEVICE_ID: Mutex<Option<(String, String)>> = Mutex::new(None);

fn recorder_config(device: Option<&str>, channel: Option<u16>, fresh: bool) -> Result<RecorderConfig, String> {
    let mut config = RecorderConfig::speech();
    if let Some(wanted) = device {
        let mut kept = DEVICE_ID.lock().unwrap_or_else(|e| e.into_inner());
        let id = match kept.as_ref() {
            Some((name, id)) if !fresh && name == wanted => id.clone(),
            _ => {
                let devices = list_input_devices().map_err(|e| e.to_string())?;
                let found = devices
                    .iter()
                    .find(|d| d.name == wanted)
                    .ok_or_else(|| format!("{wanted} is not connected"))?;
                *kept = Some((wanted.to_string(), found.id.clone()));
                found.id.clone()
            }
        };
        config.device = Some(id);
    }
    if let Some(index) = channel {
        config.channels = Channels::Only(index);
    }
    Ok(config)
}

fn paste_text(enigo: &mut Option<Enigo>, text: &str, method: PasteMethod) -> Result<(), String> {
    // Linux sends its chord through external tools: enigo there is X11 only.
    #[cfg(target_os = "linux")]
    {
        let _ = enigo;
        desktop_unix::paste(text, method)
    }
    #[cfg(not(target_os = "linux"))]
    {
        if enigo.is_none() {
            *enigo = Some(Enigo::new(&Settings::default()).map_err(|e| e.to_string())?);
        }
        let enigo = enigo.as_mut().expect("set above");
        #[cfg(windows)]
        return paste_windows::run(text, method, enigo);
        #[cfg(not(windows))]
        return desktop_unix::paste(text, method, enigo);
    }
}

/// Dropping it stops the hook thread, which owns the manager.
struct Keys(Arc<AtomicBool>);

impl Drop for Keys {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn start_keys(config: &Config, tx: &Sender<Msg>) -> Result<Option<Keys>, String> {
    if config.hold.is_empty() && config.toggle.is_empty() {
        return Ok(None);
    }
    // `new_with_blocking`: the chord must not also reach the focused app.
    let manager = HotkeyManager::new_with_blocking().map_err(|e| e.to_string())?;
    let register = |texts: &Vec<String>| -> Result<Vec<_>, String> {
        texts
            .iter()
            .map(|text| {
                let hotkey: Hotkey = text.parse().map_err(|e| format!("{text}: {e}"))?;
                manager.register(hotkey).map_err(|e| format!("{text}: {e}"))
            })
            .collect()
    };
    let hold = register(&config.hold)?;
    register(&config.toggle)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let tx = tx.clone();
    thread::spawn(move || {
        while !stopped.load(Ordering::Relaxed) {
            match manager.try_recv() {
                Some(event) => {
                    let pressed = event.state == HotkeyState::Pressed;
                    let _ = tx.send(Msg::Key { hold: hold.contains(&event.id), pressed });
                }
                None => thread::sleep(Duration::from_millis(5)),
            }
        }
    });
    Ok(Some(Keys(stop)))
}

/// Hands the microphone to the engine as it arrives.
struct LiveSink {
    work: Sender<Work>,
    samples: Arc<AtomicUsize>,
    first_audio: Arc<OnceLock<Instant>>,
}

impl Sink for LiveSink {
    fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
        let samples = chunk.samples[..chunk.valid_frames].to_vec();
        if !samples.is_empty() {
            let _ = self.first_audio.set(Instant::now());
        }
        self.samples.fetch_add(samples.len(), Ordering::Relaxed);
        let _ = self.work.send(Work::Audio(samples));
    }
}

enum Source {
    Mic(Recorder<LiveSink>),
    Fake(Arc<AtomicBool>),
}

struct Recording {
    source: Source,
    samples: Arc<AtomicUsize>,
    started: Instant,
    target: isize,
    /// When the key (or start) asked for it, the microphone took, and the first audio arrived.
    pressed: Instant,
    mic_ms: u64,
    first_audio: Arc<OnceLock<Instant>>,
    via: &'static str,
}

impl Drop for Recording {
    fn drop(&mut self) {
        if let Source::Fake(stop) = &self.source {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// BATON_FAKE_MIC=<wav>, re-read on each recording: the file plays at real-time pace through the
/// path a microphone takes, so latency can be measured with nobody speaking. It never pastes.
fn fake_mic() -> Option<PathBuf> {
    std::env::var_os("BATON_FAKE_MIC").map(PathBuf::from)
}

fn play_fake(
    path: &Path,
    work: Sender<Work>,
    samples: Arc<AtomicUsize>,
    first_audio: Arc<OnceLock<Instant>>,
    stop: Arc<AtomicBool>,
    tx: Sender<Msg>,
) -> Result<(), String> {
    let pcm = read_wav(path)?;
    thread::spawn(move || {
        let started = Instant::now();
        for (i, chunk) in pcm.chunks(480).enumerate() {
            let due = started + Duration::from_millis(30 * i as u64);
            thread::sleep(due.saturating_duration_since(Instant::now()));
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let _ = first_audio.set(Instant::now());
            samples.fetch_add(chunk.len(), Ordering::Relaxed);
            let _ = work.send(Work::Audio(chunk.to_vec()));
        }
        let _ = tx.send(Msg::FakeEnded);
    });
    Ok(())
}

#[cfg(windows)]
fn foreground_window() -> isize {
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow().0 as isize }
}

#[cfg(unix)]
use desktop_unix::{foreground_window, window_app};

#[cfg(not(any(windows, unix)))]
fn foreground_window() -> isize {
    0
}

/// Which app a window belongs to and what its title says, for choosing a writing mode.
#[cfg(windows)]
fn window_app(window: isize) -> (String, String) {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW, GetWindowThreadProcessId};
    let hwnd = HWND(window as *mut _);
    let mut title = [0u16; 256];
    let length = unsafe { GetWindowTextW(hwnd, &mut title) }.max(0) as usize;
    let title = String::from_utf16_lossy(&title[..length]);
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let mut exe = String::new();
    if let Ok(process) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        let mut path = [0u16; 1024];
        let mut size = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size) }.is_ok() {
            let full = String::from_utf16_lossy(&path[..size as usize]);
            exe = full.rsplit('\\').next().unwrap_or("").to_lowercase();
        }
        let _ = unsafe { CloseHandle(process) };
    }
    (exe, title)
}

#[cfg(not(any(windows, unix)))]
fn window_app(_window: isize) -> (String, String) {
    (String::new(), String::new())
}

#[cfg(windows)]
fn window_rect(window: isize) -> Value {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let mut r = RECT::default();
    match unsafe { GetWindowRect(HWND(window as *mut _), &mut r) } {
        Ok(()) => json!({"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top}),
        Err(_) => Value::Null,
    }
}

#[cfg(not(windows))]
fn window_rect(_window: isize) -> Value {
    Value::Null
}

/// Lab only: real mouse input with no process starting, to stand in for his hand during a drive.
#[cfg(windows)]
fn nudge(dx: i32, dy: i32) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT,
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

#[cfg(not(windows))]
fn nudge(_dx: i32, _dy: i32) {}

#[cfg(windows)]
fn window_at(x: i32, y: i32) -> isize {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
    unsafe { GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT).0 as isize }
}

#[cfg(not(windows))]
fn window_at(_x: i32, _y: i32) -> isize {
    0
}

#[cfg(windows)]
fn locate_element(id: Option<u64>, label: &str, x: i32, y: i32, foreground: bool, window: Option<&str>, invoke: bool, reference: Option<(u64, usize)>) -> Value {
    let mut out = uia::locate(label, x, y, foreground, window, invoke, reference).unwrap_or_else(|e| json!({"found": false, "error": e}));
    out["ev"] = json!("located");
    out["id"] = json!(id);
    out
}

#[cfg(not(windows))]
fn locate_element(id: Option<u64>, _label: &str, _x: i32, _y: i32, _foreground: bool, _window: Option<&str>, _invoke: bool, _reference: Option<(u64, usize)>) -> Value {
    json!({"ev": "located", "id": id, "found": false, "error": "not on this platform yet"})
}

/// `title`: part of a window's title, for the window he named that is open behind another; else the handle.
/// shortcut: the first window in z-order whose title contains it, so a tab titled like the app can win; match the exe if that bites.
#[cfg(windows)]
fn focus_window_event(id: Option<u64>, window: isize, title: Option<&str>) -> Value {
    let window = match title {
        Some(t) => match uia::find_window(t) {
            Some(hwnd) => hwnd.0 as isize,
            None => return json!({"ev": "focused", "id": id, "error": format!("No open window is titled like \"{t}\".")}),
        },
        None => window,
    };
    let mut v = capture::focus_window(window).unwrap_or_else(|e| json!({"error": e}));
    if title.is_some() {
        v["title"] = json!(window_app(window).1);
    }
    v["ev"] = json!("focused");
    v["id"] = json!(id);
    v
}

#[cfg(not(windows))]
fn focus_window_event(id: Option<u64>, _window: isize, _title: Option<&str>) -> Value {
    json!({"ev": "focused", "id": id, "error": "not on this platform yet"})
}

#[cfg(windows)]
fn capture_window_event(id: Option<u64>, window: Option<&str>, handle: Option<isize>, out: &str) -> Value {
    let mut v = capture::capture_window(window, handle, out).unwrap_or_else(|e| json!({"error": e}));
    v["ev"] = json!("captured");
    v["id"] = json!(id);
    v
}

#[cfg(not(windows))]
fn capture_window_event(id: Option<u64>, _window: Option<&str>, _handle: Option<isize>, _out: &str) -> Value {
    json!({"ev": "captured", "id": id, "error": "not on this platform yet"})
}

/// The hands' pointer and keys: `{"op": "at", "x", "y", "buttons": [flags], "wheel"}` (no x and y: where the pointer is)
/// or `{"op": "keys", "vks": [codes]}`.
#[cfg(windows)]
fn input_event(id: Option<u64>, value: &Value) -> Value {
    let numbers = |key: &str| -> Vec<u64> {
        value[key].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default()
    };
    let result = match value["op"].as_str() {
        Some("at") => {
            let point = match (value["x"].as_i64(), value["y"].as_i64()) {
                (Some(x), Some(y)) => Some((x as i32, y as i32)),
                _ => None,
            };
            let buttons: Vec<u32> = numbers("buttons").into_iter().map(|b| b as u32).collect();
            input_windows::at(point, &buttons, value["wheel"].as_i64().unwrap_or(0) as i32)
        }
        Some("keys") => {
            let vks: Vec<u16> = numbers("vks").into_iter().map(|k| k as u16).collect();
            if vks.is_empty() { Err("no keys".to_string()) } else { input_windows::keys(&vks) }
        }
        _ => Err("unknown input".to_string()),
    };
    json!({"ev": "input", "id": id, "error": result.err()})
}

#[cfg(not(windows))]
fn input_event(id: Option<u64>, _value: &Value) -> Value {
    json!({"ev": "input", "id": id, "error": "not on this platform yet"})
}

#[cfg(windows)]
fn set_value_event(id: Option<u64>, window: &str, text: &str) -> Value {
    let mut out = uia::set_value(window, text).unwrap_or_else(|e| json!({"set": false, "error": e}));
    out["ev"] = json!("value_set");
    out["id"] = json!(id);
    out
}

#[cfg(not(windows))]
fn set_value_event(id: Option<u64>, _window: &str, _text: &str) -> Value {
    json!({"ev": "value_set", "id": id, "set": false, "error": "not on this platform yet"})
}

#[cfg(windows)]
fn ui_tree(id: Option<u64>, window: Option<&str>, find: Option<&str>, numbered: bool) -> Value {
    let mut out = uia::tree(120, window, find, numbered).unwrap_or_else(|e| json!({"error": e}));
    out["ev"] = json!("tree");
    out["id"] = json!(id);
    out
}

#[cfg(not(windows))]
fn ui_tree(id: Option<u64>, _window: Option<&str>, _find: Option<&str>, _numbered: bool) -> Value {
    json!({"ev": "tree", "id": id, "error": "not on this platform yet"})
}

#[cfg(windows)]
fn focus_state_event(id: Option<u64>, window: Option<&str>) -> Value {
    let mut out = uia::focus_state(window).unwrap_or_else(|e| json!({"error": e}));
    out["ev"] = json!("focus_state");
    out["id"] = json!(id);
    out
}

#[cfg(windows)]
fn caret_event(id: Option<u64>) -> Value {
    let mut out = uia::caret_context(120).unwrap_or_else(|e| json!({"error": e}));
    out["ev"] = json!("caret");
    out["id"] = json!(id);
    out
}

#[cfg(not(windows))]
fn caret_event(id: Option<u64>) -> Value {
    json!({"ev": "caret", "id": id, "before": null, "after": null})
}

/// Where the caret is drawn, for the words to appear there as he speaks. Its own worker with a deadline: a field
/// that hangs UI Automation answers "no caret" in time and the pill shows the words instead.
fn caret_at_event(id: Option<u64>) -> Value {
    let (tx, rx) = channel();
    thread::spawn(move || {
        #[cfg(windows)]
        let out = uia::caret_geometry().unwrap_or_else(|_| json!({"caret": null}));
        #[cfg(not(windows))]
        let out = json!({"caret": null});
        let _ = tx.send(out);
    });
    let mut out = rx.recv_timeout(CARET_AT_DEADLINE).unwrap_or_else(|_| json!({"caret": null, "late": true}));
    out["ev"] = json!("caret_at");
    out["id"] = json!(id);
    out
}

/// When he last pressed a key, clicked or moved the mouse, in the system's ms tick (0 off Windows).
fn last_input_tick() -> u32 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info).as_bool() {
            return info.dwTime;
        }
    }
    0
}

#[cfg(not(windows))]
fn focus_state_event(id: Option<u64>, _window: Option<&str>) -> Value {
    json!({"ev": "focus_state", "id": id, "error": "not on this platform yet"})
}

/// What a press of the dictation key does. While the desktop's voice dictation runs, the press is its ✓, so it is
/// handed to the desktop: starting a second, separate recording here is what left the two unable to stop each other.
#[derive(Debug, PartialEq, Eq)]
enum Press {
    Begin,
    Finish,
    ToDesktop,
}

fn dictation_press(recording: bool, voice_on: bool) -> Press {
    if recording {
        Press::Finish
    } else if voice_on {
        Press::ToDesktop
    } else {
        Press::Begin
    }
}

/// Text goes only into the window it was spoken for. Windows reports 0 mid-switch, which is not it.
fn should_paste(target: Option<isize>, now: isize) -> bool {
    matches!(target, Some(window) if window != 0 && window == now)
}

fn over_limit(held: Duration) -> bool {
    held >= MAX_RECORDING
}

fn serve() {
    let (tx, rx) = channel::<Msg>();
    let (job_tx, job_rx) = channel::<Work>();
    {
        let tx = tx.clone();
        thread::spawn(move || engine_thread(job_rx, tx));
    }
    {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let _ = tx.send(Msg::Line(line));
            }
            // Electron went away: nothing is left to serve.
            std::process::exit(0);
        });
    }

    let mut config = Config::default();
    let mut keys: Option<Keys> = None;
    let mut enigo = None;
    let mut recording: Option<Recording> = None;
    let mut held = false;
    let mut taps = PushToTalk::default();
    let clock = Instant::now();
    let mut toggle_down = false;
    // The desktop's voice dictation is running (it says so with `voice`): a key press is its ✓.
    let mut voice_on = false;
    emit(json!({"ev": "ready", "devices": devices_json()}));

    // `via`: the hold key, the toggle key, or `start` (a held mouse button or the desktop), for the timing line.
    let begin = |config: &Config, recording: &mut Option<Recording>, tx: &Sender<Msg>, job_tx: &Sender<Work>, via: &'static str| {
        if recording.is_some() {
            return;
        }
        let pressed = Instant::now();
        let Some(model) = config.model.clone() else {
            emit(json!({"ev": "error", "message": "no model configured"}));
            return;
        };
        let _ = job_tx.send(Work::Begin { model, language: config.language.clone(), external: config.external.clone() });
        let samples = Arc::new(AtomicUsize::new(0));
        let first_audio = Arc::new(OnceLock::new());
        let opened = match fake_mic() {
            Some(path) => {
                let stop = Arc::new(AtomicBool::new(false));
                play_fake(&path, job_tx.clone(), samples.clone(), first_audio.clone(), stop.clone(), tx.clone())
                    .map(|()| Source::Fake(stop))
            }
            None => {
                let open = |fresh: bool| {
                    let sink = LiveSink { work: job_tx.clone(), samples: samples.clone(), first_audio: first_audio.clone() };
                    let tx = tx.clone();
                    recorder_config(config.device.as_deref(), config.channel, fresh).and_then(|cfg| {
                        let recorder = Recorder::open_with_failure_handler(cfg, move |e| {
                            let _ = tx.send(Msg::MicFailed(e.to_string()));
                        })
                        .map_err(|e| e.to_string())?;
                        recorder.start(sink).map_err(|e| e.to_string())?;
                        Ok(Source::Mic(recorder))
                    })
                };
                // A kept id can be stale after a replug: one fresh look before saying the microphone failed.
                open(false).or_else(|_| open(true))
            }
        };
        match opened {
            Ok(source) => {
                let target = foreground_window();
                let (app, title) = window_app(target);
                let mic_ms = pressed.elapsed().as_millis() as u64;
                *recording =
                    Some(Recording { source, samples, started: Instant::now(), target, pressed, mic_ms, first_audio, via });
                emit(json!({"ev": "recording", "app": app, "title": title, "micMs": mic_ms}));
            }
            Err(message) => {
                let _ = job_tx.send(Work::Abort);
                emit(json!({"ev": "error", "message": message}));
            }
        }
    };
    let finish = |recording: &mut Option<Recording>, job_tx: &Sender<Work>, paste: bool| {
        let Some(current) = recording.take() else { return };
        let released = Instant::now();
        let held_for = current.started.elapsed();
        // A fake microphone must never reach his keyboard.
        let target = (paste && matches!(current.source, Source::Mic(_))).then_some(current.target);
        let samples = current.samples.clone();
        let stopped = match &current.source {
            Source::Mic(recorder) => recorder.stop().map(drop).map_err(|e| e.to_string()),
            Source::Fake(_) => Ok(()),
        };
        match stopped {
            Ok(()) if samples.load(Ordering::Relaxed) >= MIN_SAMPLES => {
                emit(json!({"ev": "transcribing", "heldMs": held_for.as_millis() as u64}));
                let since = |at: Instant| at.saturating_duration_since(current.pressed).as_millis() as u64;
                let timing = json!({
                    "via": current.via,
                    "micMs": current.mic_ms,
                    "firstAudioMs": current.first_audio.get().map(|at| since(*at)),
                    "releasedMs": since(released),
                });
                let _ = job_tx.send(Work::End { target, released, timing });
            }
            Ok(()) => {
                let _ = job_tx.send(Work::Abort);
                emit(json!({"ev": "idle"}));
            }
            Err(message) => {
                let _ = job_tx.send(Work::Abort);
                emit(json!({"ev": "error", "message": message}));
            }
        }
    };

    loop {
        let message = match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(message) => message,
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                if recording.as_ref().is_some_and(|r| over_limit(r.started.elapsed())) {
                    held = false;
                    finish(&mut recording, &job_tx, false);
                }
                continue;
            }
        };
        match message {
            Msg::Line(line) => {
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                match value["cmd"].as_str().unwrap_or("") {
                    "configure" => {
                        match serde_json::from_value::<Config>(value.clone()) {
                            Ok(next) => {
                                let rebind = next.hold != config.hold || next.toggle != config.toggle;
                                config = next;
                                let bound = !config.hold.is_empty() || !config.toggle.is_empty() || config.mouse.is_some();
                                let local = config.model.is_some() && config.external.is_none();
                                let _ = job_tx.send(Work::Keep(config.keep_loaded && bound && local));
                                #[cfg(windows)]
                                mouse_windows::configure(config.mouse.as_deref());
                                if rebind {
                                    // Nothing can stop a recording once its keys are gone.
                                    if recording.take().is_some() {
                                        let _ = job_tx.send(Work::Abort);
                                        held = false;
                                        taps = PushToTalk::default();
                                        emit(json!({"ev": "idle"}));
                                    }
                                    keys = None;
                                    thread::sleep(Duration::from_millis(30));
                                    match start_keys(&config, &tx) {
                                        Ok(started) => keys = started,
                                        Err(message) => emit(json!({"ev": "error", "message": message})),
                                    }
                                }
                                emit(json!({"ev": "configured", "mouse": cfg!(windows)}));
                            }
                            Err(e) => emit(json!({"ev": "error", "message": e.to_string()})),
                        }
                    }
                    "devices" => emit(json!({"ev": "devices", "devices": devices_json()})),
                    "load" => {
                        let id = value["id"].as_u64();
                        match &config.model {
                            Some(model) => {
                                let _ = job_tx.send(Work::Load { id, model: model.clone() });
                            }
                            None => emit(json!({"ev": "model_ready", "id": id, "error": "no model configured"})),
                        }
                    }
                    "foreground" => {
                        let window = foreground_window();
                        let (app, title) = window_app(window);
                        emit(json!({"ev": "foreground", "id": value["id"].as_u64(), "rect": window_rect(window), "app": app, "title": title, "window": window as i64}));
                    }
                    "nudge" if std::env::var_os("BATON_LAB").is_some() => nudge(
                        value["dx"].as_i64().unwrap_or(0) as i32,
                        value["dy"].as_i64().unwrap_or(0) as i32,
                    ),
                    "window_at" => {
                        let (x, y) = (value["x"].as_i64().unwrap_or(0) as i32, value["y"].as_i64().unwrap_or(0) as i32);
                        let window = window_at(x, y);
                        let (app, title) = window_app(window);
                        emit(json!({"ev": "window_at", "id": value["id"].as_u64(), "window": window as i64, "app": app, "title": title}));
                    }
                    "locate" => {
                        let id = value["id"].as_u64();
                        let label = value["label"].as_str().unwrap_or("").to_string();
                        let (x, y) = (value["x"].as_i64().unwrap_or(0) as i32, value["y"].as_i64().unwrap_or(0) as i32);
                        // Its own thread: a big page can take a while, and the keys must not wait.
                        let foreground = value["foreground"].as_bool().unwrap_or(false);
                        let invoke = value["invoke"].as_bool().unwrap_or(false);
                        let window = value["window"].as_str().map(str::to_string);
                        let reference = value["ref"].as_u64().map(|n| (value["tree"].as_u64().unwrap_or(0), n as usize));
                        thread::spawn(move || emit(locate_element(id, &label, x, y, foreground, window.as_deref(), invoke, reference)));
                    }
                    "ui_changes" => {
                        #[cfg(windows)]
                        let out = json!({"ev": "ui_changes", "id": value["id"].as_u64(), "count": changes::changes()});
                        #[cfg(not(windows))]
                        let out = json!({"ev": "ui_changes", "id": value["id"].as_u64(), "error": "not on this platform yet"});
                        emit(out);
                    }
                    "ui_tree" => {
                        let id = value["id"].as_u64();
                        let window = value["window"].as_str().map(str::to_string);
                        let find = value["find"].as_str().map(str::to_string);
                        let numbered = value["number"].as_bool().unwrap_or(false);
                        thread::spawn(move || emit(ui_tree(id, window.as_deref(), find.as_deref(), numbered)));
                    }
                    "caret" => {
                        let id = value["id"].as_u64();
                        thread::spawn(move || emit(caret_event(id)));
                    }
                    "caret_at" => {
                        let id = value["id"].as_u64();
                        thread::spawn(move || emit(caret_at_event(id)));
                    }
                    "last_input" => {
                        emit(json!({"ev": "last_input", "id": value["id"].as_u64(), "tick": last_input_tick()}));
                    }
                    "focus_state" => {
                        let id = value["id"].as_u64();
                        let window = value["window"].as_str().map(str::to_string);
                        thread::spawn(move || emit(focus_state_event(id, window.as_deref())));
                    }
                    "input" => {
                        let id = value["id"].as_u64();
                        // Its own thread: a chord holds for 100 ms, and the dictation keys must not wait.
                        let value = value.clone();
                        thread::spawn(move || emit(input_event(id, &value)));
                    }
                    "set_value" => {
                        let id = value["id"].as_u64();
                        let window = value["window"].as_str().unwrap_or("").to_string();
                        let text = value["text"].as_str().unwrap_or("").to_string();
                        thread::spawn(move || emit(set_value_event(id, &window, &text)));
                    }
                    "focus_window" => {
                        let id = value["id"].as_u64();
                        let window = value["window"].as_i64().unwrap_or(0) as isize;
                        let title = value["title"].as_str().map(str::to_string);
                        thread::spawn(move || emit(focus_window_event(id, window, title.as_deref())));
                    }
                    "capture_window" => {
                        let id = value["id"].as_u64();
                        let window = value["window"].as_str().map(str::to_string);
                        let handle = value["handle"].as_i64().map(|h| h as isize);
                        let out = value["out"].as_str().unwrap_or("").to_string();
                        thread::spawn(move || emit(capture_window_event(id, window.as_deref(), handle, &out)));
                    }
                    "toggle" => {
                        if recording.is_some() {
                            finish(&mut recording, &job_tx, true);
                        } else {
                            begin(&config, &mut recording, &tx, &job_tx, "toggle");
                        }
                    }
                    // A mouse button held to dictate, and the desktop ending a recording from any of its entry points.
                    "start" => {
                        if recording.is_none() {
                            begin(&config, &mut recording, &tx, &job_tx, "start");
                        }
                    }
                    "finish" => {
                        if recording.is_some() {
                            finish(&mut recording, &job_tx, true);
                        }
                        // A ✓ on a latched hold also ends the latch, so the next press starts afresh.
                        held = false;
                        taps = PushToTalk::default();
                    }
                    "voice" => voice_on = value["on"].as_bool().unwrap_or(false),
                    "cancel" => {
                        recording = None;
                        let _ = job_tx.send(Work::Abort);
                        held = false;
                        taps = PushToTalk::default();
                        emit(json!({"ev": "idle"}));
                    }
                    "transcribe" => {
                        let id = value["id"].as_u64();
                        let wav = value["wav"].as_str().unwrap_or("");
                        // The wake path may ask for its own model; dictation's is the default.
                        let asked = value["model"].as_str().filter(|m| !m.is_empty()).map(PathBuf::from);
                        let asked_own = asked.is_some();
                        match (read_wav(Path::new(wav)), asked.or_else(|| config.model.clone())) {
                            (Ok(pcm), Some(model)) => {
                                let _ = job_tx.send(Work::Clip(Job {
                                    id,
                                    dictated: false,
                                    target: None,
                                    pcm,
                                    model,
                                    language: config.language.clone(),
                                    wake: asked_own,
                                }));
                            }
                            (Err(message), _) => emit(json!({"ev": "text", "id": id, "error": message})),
                            (_, None) => emit(json!({"ev": "text", "id": id, "error": "no model configured"})),
                        }
                    }
                    "paste" => {
                        let id = value["id"].as_u64();
                        let text = value["text"].as_str().unwrap_or("");
                        // With a target the text goes only into that window, as a dictation's does.
                        let target = value["target"].as_i64().map(|t| t as isize);
                        if target.is_some() && !should_paste(target, foreground_window()) {
                            emit(json!({"ev": "pasted", "id": id, "moved": true}));
                        } else {
                            let started = Instant::now();
                            let result = paste_text(&mut enigo, text, config.paste);
                            let paste_ms = started.elapsed().as_millis() as u64;
                            emit(json!({"ev": "pasted", "id": id, "error": result.err(), "pasteMs": paste_ms}));
                        }
                    }
                    "quit" => return,
                    _ => {}
                }
            }
            Msg::Key { hold: true, pressed } => {
                let at = clock.elapsed().as_secs_f64() * 1000.0;
                for out in taps.step(pressed, at, config.latch) {
                    match out {
                        Out::Start => match dictation_press(recording.is_some(), voice_on) {
                            // Handed to the desktop as ✓: nothing is held here, so this hold's release starts nothing.
                            Press::ToDesktop => {
                                held = false;
                                taps = PushToTalk::default();
                                emit(json!({"ev": "binding", "id": "toggle"}));
                            }
                            _ => {
                                held = true;
                                begin(&config, &mut recording, &tx, &job_tx, "hold");
                            }
                        },
                        Out::Stop => {
                            held = false;
                            finish(&mut recording, &job_tx, true);
                        }
                        // An accidental tap: what little was heard is dropped, not transcribed.
                        Out::Cancel => {
                            held = false;
                            recording = None;
                            let _ = job_tx.send(Work::Abort);
                            emit(json!({"ev": "idle"}));
                        }
                        Out::Latch | Out::Unlatch => {}
                    }
                }
            }
            Msg::Key { hold: false, pressed: true } => {
                if !toggle_down {
                    toggle_down = true;
                    match dictation_press(recording.is_some(), voice_on) {
                        Press::Finish => finish(&mut recording, &job_tx, true),
                        Press::Begin => begin(&config, &mut recording, &tx, &job_tx, "toggle"),
                        Press::ToDesktop => emit(json!({"ev": "binding", "id": "toggle"})),
                    }
                }
            }
            Msg::Key { hold: false, pressed: false } => toggle_down = false,
            Msg::FakeEnded => finish(&mut recording, &job_tx, true),
            Msg::MicFailed(message) => {
                recording = None;
                let _ = job_tx.send(Work::Abort);
                held = false;
                taps = PushToTalk::default();
                emit(json!({"ev": "error", "message": message}));
            }
            Msg::Finished { id, dictated, target, result } => match result {
                Ok(done) => {
                    let mut pasted_error = None;
                    let mut paste_ms = None;
                    let paste = dictated && !config.cleanup && should_paste(target, foreground_window());
                    if paste && !done.text.is_empty() {
                        let started = Instant::now();
                        pasted_error = paste_text(&mut enigo, &done.text, config.paste).err();
                        paste_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    emit(json!({
                        "ev": "text", "id": id, "text": done.text, "audioMs": done.audio_ms,
                        "inferMs": done.infer_ms, "loadMs": done.load_ms, "pasteError": pasted_error,
                        "dictated": dictated, "pasted": paste, "target": target,
                        "releaseMs": done.release_ms, "pieces": done.pieces, "wav": done.wav, "model": done.model,
                        "timing": done.timing, "pasteMs": paste_ms,
                    }));
                }
                Err(message) => emit(json!({"ev": "text", "id": id, "error": message, "dictated": dictated})),
            },
        }
    }
}

/// Raw 16-bit PCM to stdout, for voice-lab's scorer.
struct StdoutSink;

impl Sink for StdoutSink {
    fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
        let bytes: Vec<u8> = chunk.samples[..chunk.valid_frames]
            .iter()
            .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
            .collect();
        let mut out = std::io::stdout().lock();
        if out.write_all(&bytes).is_err() {
            std::process::exit(0);
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn cli_transcribe(args: &[String]) -> Result<(), String> {
    let model = flag(args, "--model").ok_or("--model is required")?;
    let language = flag(args, "--language");
    let (mut session, load_ms) = load(Path::new(&model))?;
    emit(json!({"ev": "loaded", "loadMs": load_ms}));
    let list = flag(args, "--list");
    let files: Vec<String> = match list {
        Some(path) => std::fs::read_to_string(path)
            .map_err(|e| e.to_string())?
            .lines()
            .map(str::to_string)
            .collect(),
        None => args.iter().filter(|a| a.ends_with(".wav")).cloned().collect(),
    };
    for file in files {
        let result = read_wav(Path::new(&file))
            .and_then(|mut pcm| infer(&mut session, &mut pcm, language.clone()));
        match result {
            Ok((text, audio_ms, infer_ms)) => {
                emit(json!({"file": file, "text": text, "audioMs": audio_ms, "inferMs": infer_ms}))
            }
            Err(error) => emit(json!({"file": file, "error": error})),
        }
    }
    Ok(())
}

/// Live chunking with no pacing, for sweeping its settings: `finalMs` is what is left at release
/// when decoding has kept up, which the real-time replay confirms.
fn cli_chunked(args: &[String]) -> Result<(), String> {
    let model = flag(args, "--model").ok_or("--model is required")?;
    let language = flag(args, "--language");
    let (mut session, load_ms) = load(Path::new(&model))?;
    let loaded = Model::load(Path::new(&model)).map_err(|e| e.to_string())?;
    let caps = loaded.capabilities().map_err(|e| e.to_string())?;
    emit(json!({"ev": "loaded", "loadMs": load_ms, "streaming": caps.supports_streaming,
        "vocabulary": loaded.supports(Feature::Vocabulary), "arch": loaded.arch(), "variant": loaded.variant()}));
    let list = std::fs::read_to_string(flag(args, "--list").ok_or("--list is required")?).map_err(|e| e.to_string())?;
    for file in list.lines() {
        let pcm = match read_wav(Path::new(file)) {
            Ok(pcm) => pcm,
            Err(error) => {
                emit(json!({"file": file, "error": error}));
                continue;
            }
        };
        let mut chunker = Chunker::new(ChunkParams::from_env());
        let mut text: Vec<String> = Vec::new();
        let started = Instant::now();
        for chunk in pcm.chunks(480) {
            if let Some(piece) = chunker.push(chunk) {
                text.push(decode_piece(&mut session, piece, language.clone())?);
            }
        }
        let busy = started.elapsed().as_millis() as u64;
        let last = chunker.finish();
        let last_seconds = last.as_ref().map_or(0.0, |p| p.pcm.len() as f64 / 16_000.0);
        let released = Instant::now();
        if let Some(piece) = last {
            text.push(decode_piece(&mut session, piece, language.clone())?);
        }
        emit(json!({"file": file, "text": text.join(" "), "audioMs": pcm.len() as u64 / 16, "inferMs": busy,
            "finalMs": released.elapsed().as_millis() as u64, "lastSeconds": last_seconds, "pieces": text.len()}));
    }
    Ok(())
}

fn cli_record(args: &[String]) -> Result<(), String> {
    let channel = flag(args, "--channel").and_then(|c| c.parse().ok());
    let config = recorder_config(flag(args, "--device").as_deref(), channel, true)?;
    let seconds: u64 = flag(args, "--seconds").and_then(|s| s.parse().ok()).unwrap_or(0);
    // Exit on a dead stream: the desktop only learns of it from this process ending.
    let recorder = Recorder::open_with_failure_handler(config, |e| {
        eprintln!("{e}");
        std::process::exit(3);
    })
    .map_err(|e| e.to_string())?;
    recorder.start(StdoutSink).map_err(|e| e.to_string())?;
    if seconds == 0 {
        loop {
            thread::sleep(Duration::from_secs(3600));
        }
    }
    thread::sleep(Duration::from_secs(seconds));
    recorder.stop().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    // Without this Windows scales every coordinate here, so at 175 % the window and the element
    // under a physical point are the wrong ones.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if let Err(e) = init_backends_with(None::<&Path>, BackendMask::CPU) {
        emit(json!({"ev": "error", "message": format!("backend: {e}")}));
        std::process::exit(2);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        None | Some("serve") => {
            serve();
            Ok(())
        }
        Some("devices") => {
            println!("{}", devices_json());
            Ok(())
        }
        Some("foreground") => {
            let window = foreground_window();
            let (app, title) = window_app(window);
            println!("{}", json!({"window": window, "app": app, "title": title}));
            Ok(())
        }
        Some("locate") => {
            let number = |name: &str| flag(&args, name).and_then(|v| v.parse().ok()).unwrap_or(0);
            let label = flag(&args, "--label").unwrap_or_default();
            println!("{}", locate_element(None, &label, number("--x"), number("--y"), args.iter().any(|a| a == "--foreground"), flag(&args, "--window").as_deref(), args.iter().any(|a| a == "--invoke"), flag(&args, "--ref").and_then(|v| v.parse().ok()).map(|n| (flag(&args, "--tree").and_then(|v| v.parse().ok()).unwrap_or(0), n))));
            Ok(())
        }
        Some("ui_tree") => {
            println!("{}", ui_tree(None, flag(&args, "--window").as_deref(), flag(&args, "--find").as_deref(), args.iter().any(|a| a == "--number")));
            Ok(())
        }
        Some("transcribe") => cli_transcribe(&args[1..]),
        Some("chunked") => cli_chunked(&args[1..]),
        Some("record") => cli_record(&args[1..]),
        Some(other) => Err(format!("unknown command {other}")),
    };
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wake_path_and_dictation_keep_their_own_models_and_never_load_one_twice() {
        let (v3, fast) = (Path::new("v3.gguf"), Path::new("fast.gguf"));
        // [the wake path asked, what Main holds, what Wake holds, the model wanted, the slot]
        let rows = [
            (true, None, None, fast, Slot::Wake),
            (true, Some(v3), None, fast, Slot::Wake),
            (true, Some(v3), Some(fast), fast, Slot::Wake),
            (false, Some(v3), Some(fast), v3, Slot::Main),
            (false, None, None, v3, Slot::Main),
            // Already loaded in the other slot: used where it is, never loaded a second time.
            (true, Some(fast), None, fast, Slot::Main),
            (false, Some(v3), Some(fast), fast, Slot::SwapThenMain),
        ];
        for (wake, main, other, wanted, slot) in rows {
            assert_eq!(plan_slot(wake, main, other, wanted), slot, "{wake} {main:?} {other:?} {wanted:?}");
        }
    }

    #[test]
    fn a_cloud_recording_comes_back_as_a_wav_with_no_text() {
        let dir = std::env::temp_dir().join(format!("tessaya-wav-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut live = Live { external: Some(dir.clone()), ..Live::new(None, 0, None) };
        live.heard = vec![0.0, 0.5, -0.5, 1.0];
        let done = live.finish(None, Instant::now()).unwrap();
        assert_eq!(done.text, "");
        let wav = done.wav.unwrap();
        assert!(Path::new(&wav).starts_with(&dir));
        let back = read_wav(Path::new(&wav)).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(back.len(), 4);
        assert!((back[1] - 0.5).abs() < 0.001 && (back[3] - 1.0).abs() < 0.001);
    }

    #[test]
    fn threads_are_half_the_cores_but_never_more_than_the_cores() {
        assert_eq!([1, 2, 3, 4, 8, 16].map(default_threads), [1, 2, 2, 2, 4, 8]);
    }

    /// The timing table in docs/baton/fixtures/double-tap.json.
    #[test]
    fn the_push_to_talk_machine_replays_the_shared_timing_table() {
        let fixture: Value = serde_json::from_str(include_str!("../../../docs/baton/fixtures/double-tap.json")).unwrap();
        let t = &fixture["timings"];
        assert_eq!(
            [t["shortTapMs"].as_f64(), t["firstPressMs"].as_f64(), t["gapMs"].as_f64(), t["holdMs"].as_f64()],
            [Some(SHORT_TAP_MS), Some(FIRST_PRESS_MS), Some(GAP_MS), Some(HOLD_MS)]
        );
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 18);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let double_tap = case["doubleTap"].as_bool().unwrap();
            let mut machine = PushToTalk::default();
            let mut outputs: Vec<&str> = vec![];
            for event in case["events"].as_array().unwrap() {
                let down = event["type"].as_str().unwrap() == "down";
                for out in machine.step(down, event["at"].as_f64().unwrap(), double_tap) {
                    outputs.push(match out {
                        Out::Start => "start",
                        Out::Stop => "stop",
                        Out::Cancel => "cancel",
                        Out::Latch => "latch",
                        Out::Unlatch => "unlatch",
                    });
                }
            }
            let expected: Vec<&str> = case["outputs"].as_array().unwrap().iter().map(|o| o.as_str().unwrap()).collect();
            assert_eq!(outputs, expected, "{name}: outputs");
            assert_eq!(machine.name(), case["phase"].as_str().unwrap(), "{name}: phase");
        }
    }

    #[test]
    fn hotkeys_come_as_nothing_one_key_or_a_list() {
        let none: Config = serde_json::from_value(json!({"model": null, "hold": null})).unwrap();
        assert!(none.hold.is_empty() && none.toggle.is_empty());
        let old: Config = serde_json::from_value(json!({"hold": "Ctrl+Alt+Space"})).unwrap();
        assert_eq!(old.hold, vec!["Ctrl+Alt+Space".to_string()]);
        let many: Config = serde_json::from_value(json!({"toggle": ["F9", "Ctrl+Alt+D"]})).unwrap();
        assert_eq!(many.toggle, vec!["F9".to_string(), "Ctrl+Alt+D".to_string()]);
    }

    #[test]
    fn the_hands_free_key_starts_ends_and_during_voice_dictation_is_its_check_mark() {
        // First press starts, second ends: his own recording.
        assert_eq!(dictation_press(false, false), Press::Begin);
        assert_eq!(dictation_press(true, false), Press::Finish);
        // While "Tessaya, dictate" runs, the press goes to the desktop as ✓, never a second recording.
        assert_eq!(dictation_press(false, true), Press::ToDesktop);
        assert_eq!(dictation_press(true, true), Press::Finish);
    }

    #[test]
    fn pastes_only_into_the_window_it_was_spoken_for() {
        assert!(should_paste(Some(7), 7));
        assert!(!should_paste(Some(7), 8));
        assert!(!should_paste(None, 7));
        assert!(!should_paste(Some(0), 0));
    }

    #[test]
    fn a_recording_stops_at_the_limit() {
        assert!(!over_limit(MAX_RECORDING - Duration::from_secs(1)));
        assert!(over_limit(MAX_RECORDING));
    }
}
