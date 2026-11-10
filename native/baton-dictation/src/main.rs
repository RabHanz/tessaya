//! Baton's native dictation: Handy's engine stack (transcribe.cpp, handy-recorder, handy-keys) and
//! its Windows paste, behind JSON lines on stdin/stdout, so Electron stays out of the audio path.
//! See docs/baton/VOICE.md. Run with no arguments it serves; the subcommands are for voice-lab.
#[cfg(unix)]
mod desktop_unix;
#[cfg(windows)]
mod escape_windows;
mod keygate;
#[cfg(windows)]
mod keygate_windows;
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
mod remote;
#[cfg(any(windows, test))]
mod paste_tx;

use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use enigo::Enigo;
#[cfg(not(target_os = "linux"))]
use enigo::Settings;
use handy_keys::{Hotkey, HotkeyManager, HotkeyState, Key, KeyboardListener, Modifiers};
use handy_recorder::{
    list_input_devices, AudioChunk, Channels, Recorder, RecorderConfig, Sink,
};
use keys::PasteMethod;
use live::{
    join_pieces, lift_gain, meter_b64, preview_due, words_after, ChunkParams, Chunker, Piece, METER_SAMPLES, REUSE_FLAT,
};
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

/// An end line (`idle`, `error`) names the dictation it ends, so the desktop never pins it on the next one.
fn of_dictation(mut event: Value, id: Option<u64>) -> Value {
    if let Some(id) = id {
        event["dictation"] = json!(id);
    }
    event
}

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
    /// He keeps the audio of dictations: each recording is also written as a WAV into this private folder for History.
    #[serde(default, rename = "keepAudio")]
    keep_audio: Option<PathBuf>,
    /// The desktop says this machine has the memory to keep the dictation model loaded between dictations.
    #[serde(default, rename = "keepLoaded")]
    keep_loaded: bool,
    /// His words in the pill as he speaks: previews of the words not yet cut, and the local model's words for the cloud.
    #[serde(default, rename = "liveWords")]
    live_words: bool,
    /// His recognisers on his own servers, in his order: while the key is held the audio goes to the first healthy one
    /// and the laptop only decodes if none answers or one stalls (remote.rs).
    #[serde(default)]
    recognizers: Vec<remote::Server>,
    /// Wake words are off, so no other mic reader feeds the pill's waveform: the recording sends `pcm` lines.
    #[serde(default)]
    meter: bool,
}

enum Msg {
    Line(String),
    /// `at`: ms on the serve loop's clock when the hook saw it, so a press handled late (the microphone opening holds
    /// the loop for 100 to 250 ms) still times the hold he made, not when the loop got to it.
    Key { hold: bool, pressed: bool, at: f64 },
    MicFailed(String),
    /// Another key joined the hold chord (Win+Ctrl+Shift+B): the dictation it started is dropped, never pasted.
    ChordJoined,
    /// Esc while the hold key is down (`escape_windows`): the recording is dropped and its release pastes nothing.
    #[cfg_attr(not(windows), allow(dead_code))]
    HeldEscape,
    /// A block of the recording's audio for the pill's waveform, written out by the serve thread, never the audio's.
    Meter(Vec<f32>),
    /// A fake microphone ran out of file, which stands in for releasing the key.
    FakeEnded,
    /// `dictation`: the key dictation it answers (`Work::Begin`'s id); None for a clip.
    Finished { id: Option<u64>, dictation: Option<u64>, dictated: bool, target: Option<isize>, result: Result<Done, String> },
    /// A dictation paste's checks are back from their worker (`paste_checked`).
    PasteChecked { id: Option<u64>, text: String, why: &'static str, started: Instant },
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
    /// The recording as a WAV for History, when he keeps the audio of dictations.
    audio: Option<String>,
    /// The release took the last preview's words: nothing was decoded after the key came up.
    reused: bool,
    /// Who wrote the words: "local", "remote" (his server) or "fallback" (the server failed, the laptop wrote).
    via: &'static str,
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
    /// Each dictation's messages carry its id: audio or an end meant for another one never reaches this one.
    Begin {
        id: u64,
        model: PathBuf,
        language: Option<String>,
        external: Option<PathBuf>,
        keep: Option<PathBuf>,
        live: bool,
        /// His recognisers to try first (`Config::recognizers`); empty: the laptop decodes.
        remote: Vec<remote::Server>,
    },
    Audio(u64, Vec<f32>),
    End { id: u64, target: Option<isize>, released: Instant, timing: Value },
    Abort,
    /// Dictation is bound to a key and heard here: the dictation model stays loaded, so a press never waits on a reload.
    Keep(bool),
    /// Cloud live words want this model read in the background (`warm_needed`); a cloud Begin asks again.
    Warm(PathBuf),
    /// The model `warm_in_background` loaded for cloud dictation's live words (None: it would not load); taken only
    /// into an empty slot.
    Warmed(PathBuf, Option<Session>),
}

/// A background read of `wanted` is due: it is on disk, no slot holds it and none is running. After an idle unload
/// the slot is empty again, so the next ask reads it again; a model already in either slot is never read twice.
fn warm_needed(wanted: &Path, main: Option<&Path>, other: Option<&Path>, warming: bool, on_disk: bool) -> bool {
    on_disk && !warming && main != Some(wanted) && other != Some(wanted)
}

/// Cloud dictation's live words need the local model, but a recording must never wait for it: it is read here, on a
/// low-priority thread of its own, and handed to the engine when ready. Until then the pill shows only its bars.
fn warm_in_background(
    model: PathBuf,
    job_tx: Sender<Work>,
    loader: impl FnOnce(&Path) -> Result<(Session, u64), String> + Send + 'static,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        #[cfg(windows)]
        unsafe {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_LOWEST};
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
        }
        let session = loader(&model).ok().map(|(session, _)| session);
        let _ = job_tx.send(Work::Warmed(model, session));
    })
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
    /// The dictation this is (`Work::Begin`'s id).
    id: u64,
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
    /// He keeps the audio of dictations: the recording is also written here for History, beside its text.
    keep: Option<PathBuf>,
    /// Previews of the words not yet cut go to the pill (`preview_due`): where the last one reached, and its time.
    live_words: bool,
    previewed: usize,
    preview_ms: u64,
    /// The last preview's words for the uncut audio up to `previewed`: with only quiet after it, the release takes
    /// them instead of decoding again (`reused`).
    preview: Option<String>,
    /// Where the uncut audio was last checked for a pause (`Chunker::paused_since`), so the check runs every 100 ms.
    pause_checked: usize,
    reused: bool,
    /// His server is recognising this dictation; the laptop keeps every sample and decodes only if it fails.
    remote: Option<Remote>,
    /// Who wrote the words, for the timing line: "local", "remote", or "fallback" (the server failed, the laptop wrote).
    via: &'static str,
}

/// How long a connection to his server may take before the laptop decodes instead.
const REMOTE_CONNECT: Duration = Duration::from_millis(400);
/// How long release waits for his server's text before the laptop decodes everything it kept.
const REMOTE_TEXT: Duration = Duration::from_millis(2_000);

/// One dictation on his server: connecting in the background while the key is held, then streaming.
struct Remote {
    connecting: Option<Receiver<Option<remote::Dictation>>>,
    dictation: Option<remote::Dictation>,
    /// Samples of `heard` already sent.
    sent: usize,
}

impl Remote {
    /// Picks the server and opens the dictation off the engine's thread; audio waits in `heard` meanwhile.
    fn connect(servers: Vec<remote::Server>, language: Option<String>) -> Remote {
        let (tx, rx) = channel();
        thread::spawn(move || {
            let chosen = remote::pick(&servers, REMOTE_CONNECT)
                .and_then(|i| remote::Dictation::start(&servers[i], language, REMOTE_CONNECT).ok());
            let _ = tx.send(chosen);
        });
        Remote { connecting: Some(rx), dictation: None, sent: 0 }
    }

    /// Sends what is new and passes its live words on. False: the server failed or never answered.
    fn step(&mut self, heard: &[f32]) -> bool {
        if let Some(rx) = &self.connecting {
            match rx.try_recv() {
                Ok(Some(dictation)) => {
                    self.dictation = Some(dictation);
                    self.connecting = None;
                }
                Ok(None) | Err(std::sync::mpsc::TryRecvError::Disconnected) => return false,
                Err(std::sync::mpsc::TryRecvError::Empty) => return true,
            }
        }
        let Some(dictation) = &self.dictation else { return true };
        if heard.len() > self.sent {
            dictation.audio(&heard[self.sent..]);
            self.sent = heard.len();
        }
        while let Ok(event) = dictation.events.try_recv() {
            match event {
                remote::Event::Partial { text, pause } => emit(json!({"ev": "partial", "text": text, "pause": pause})),
                remote::Event::Failed(_) => return false,
                remote::Event::Text { .. } => {}
            }
        }
        true
    }

    /// The release: the rest of the audio, then its text within `REMOTE_TEXT`. None: the laptop decodes.
    fn finish(mut self, heard: &[f32]) -> Option<(String, u64, bool)> {
        if let Some(rx) = self.connecting.take() {
            self.dictation = rx.recv_timeout(REMOTE_CONNECT).ok().flatten();
        }
        let dictation = self.dictation?;
        if heard.len() > self.sent {
            dictation.audio(&heard[self.sent..]);
        }
        dictation.end();
        dictation
            .text(REMOTE_TEXT, |text, pause| emit(json!({"ev": "partial", "text": text, "pause": pause})))
            .ok()
    }
}

impl Live {
    fn new(language: Option<String>, load_ms: u64, failed: Option<String>) -> Self {
        Self {
            id: 0,
            external: None,
            keep: None,
            live_words: false,
            previewed: 0,
            preview_ms: 0,
            preview: None,
            pause_checked: 0,
            reused: false,
            remote: None,
            via: "local",
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
                // starts their cleanup then, so a release right after finds it done (never for the cloud's words).
                emit(json!({"ev": "partial", "text": join_pieces(&self.text), "pause": at_pause && self.external.is_none()}));
            }
            Err(e) => self.failed = Some(e),
        }
        self.previewed = 0;
        self.preview = None;
        self.pause_checked = 0;
        self.infer_ms += started.elapsed().as_millis() as u64;
        self.pieces += 1;
    }

    /// Audio in: a piece when the chunker cuts one, else a preview of the uncut words when one is due. Local
    /// recognition always decodes; the cloud's recording only for his live words.
    fn hear(&mut self, session: Option<&mut Session>, pcm: &[f32], behind: bool) {
        self.heard.extend_from_slice(pcm);
        if self.failed.is_some() || (self.external.is_some() && !self.live_words) {
            return;
        }
        // On his server the laptop only keeps the audio. If the server fails mid-dictation the laptop takes over at
        // once with everything heard so far, and the live words come from here.
        let fresh = match &mut self.remote {
            Some(remote) if remote.step(&self.heard) => return,
            Some(_) => {
                self.remote = None;
                self.via = "fallback";
                self.heard.clone()
            }
            None => pcm.to_vec(),
        };
        let piece = self.chunker.push(&fresh);
        let Some(session) = session else { return };
        if let Some(piece) = piece {
            return self.decode(session, piece);
        }
        if behind {
            return;
        }
        let pending = self.chunker.pending_len();
        // His live words on their cadence; and, for every local dictation, a look as soon as he pauses, which is
        // usually just before he lets go: the release then has nothing left to decode.
        let paused = pending >= self.pause_checked + 1_600 && {
            self.pause_checked = pending;
            self.chunker.paused_since(self.previewed, &self.heard)
        };
        let due = self.live_words && preview_due(pending, self.previewed, self.preview_ms);
        if !due && !paused {
            return;
        }
        let from = self.previewed;
        self.previewed = pending;
        // Nothing said since the last look: no decode, and the last preview still holds all of it.
        if self.chunker.quiet_since(from, &self.heard) {
            return;
        }
        let Some(piece) = self.chunker.preview() else {
            return;
        };
        let started = Instant::now();
        // A preview that fails costs nothing: the piece it looked at is decoded properly when it is cut.
        self.preview = decode_piece(session, piece, self.language.clone()).ok();
        // At his pause the words may be all of it: the desktop starts their cleanup now, so a release finds it done.
        if let (true, Some(text)) = (self.live_words || paused, &self.preview) {
            let words: Vec<&str> = self.text.iter().map(String::as_str).chain([text.as_str()]).collect();
            emit(json!({"ev": "partial", "text": join_pieces(&words), "pause": paused && self.external.is_none()}));
        }
        self.preview_ms = started.elapsed().as_millis() as u64;
    }

    fn finish(mut self, mut session: Option<&mut Session>, released: Instant) -> Result<Done, String> {
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
                audio: None,
                reused: false,
                via: "local",
            });
        }
        if let Some(remote) = self.remote.take() {
            if let Some((text, infer_ms, reused)) = remote.finish(&self.heard) {
                let audio = self.keep.as_deref().and_then(|dir| write_wav(dir, &self.heard).ok());
                return Ok(Done {
                    text,
                    audio_ms,
                    infer_ms,
                    load_ms: self.load_ms,
                    release_ms: Some(released.elapsed().as_millis() as u64),
                    pieces: 0,
                    wav: None,
                    model: None,
                    timing: None,
                    audio,
                    reused,
                    via: "remote",
                });
            }
            // His server did not answer in time: the laptop decodes all it kept.
            self.via = "fallback";
            let heard = self.heard.clone();
            if let (Some(piece), Some(session)) = (self.chunker.push(&heard), session.as_deref_mut()) {
                self.decode(session, piece);
            }
        }
        let session = session.ok_or_else(|| self.failed.clone().unwrap_or_else(|| "no model".to_string()))?;
        if self.failed.is_none() && !self.chunker.pending_is_quiet(&self.heard, REUSE_FLAT) {
            // No speech since the last preview: its words are the rest, and nothing is decoded at release.
            let reuse = self.preview.is_some() && !self.chunker.speech_after(self.previewed, &self.heard);
            if let (true, Some(text)) = (reuse, self.preview.take()) {
                self.chunker.finish();
                if !text.is_empty() {
                    self.text.push(text);
                }
                self.reused = true;
                self.pieces += 1;
            } else if let Some(piece) = self.chunker.finish() {
                self.decode(session, piece);
            }
        }
        let text = if self.failed.is_some() {
            infer(session, &mut self.heard, self.language.clone())?.0
        } else {
            join_pieces(&self.text)
        };
        let audio = self.keep.as_deref().and_then(|dir| write_wav(dir, &self.heard).ok());
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
            audio,
            reused: self.reused,
            via: self.via,
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

/// Takes every audio chunk already waiting into `pcm`. True when there was any: the engine is behind his voice, so
/// no preview runs until it has caught up (a preview then only delays the real decode). Stops at the first other
/// message, returned to be handled next, so the order holds.
fn gather_audio(work: &Receiver<Work>, id: u64, pcm: &mut Vec<f32>) -> (bool, Option<Work>) {
    let mut behind = false;
    loop {
        match work.try_recv() {
            Ok(Work::Audio(of, more)) if of == id => {
                pcm.extend_from_slice(&more);
                behind = true;
            }
            Ok(other) => return (behind, Some(other)),
            Err(_) => return (behind, None),
        }
    }
}

/// One thread owns the models. Each slot loads on first use and leaves after ten idle minutes of its own, because
/// 16 GB is shared with everything else on the laptop; the dictation slot stays while dictation is bound (`Keep`).
/// v3 held is about 1.2 GB.
fn engine_thread(work: Receiver<Work>, out: Sender<Msg>, me: Sender<Work>) {
    // Cloud live words: the model to read in the background, and whether a read is running.
    let mut wanted: Option<PathBuf> = None;
    let mut warming = false;
    let mut loaded: Loaded = None;
    let mut other: Loaded = None;
    let mut loaded_at = Instant::now();
    let mut other_at = Instant::now();
    let mut live: Option<Live> = None;
    let mut keep = false;
    // A message taken off the queue while gathering audio that was waiting, handled next.
    let mut carried: Option<Work> = None;
    loop {
        let message = match carried.take() {
            Some(next) => Ok(next),
            None => work.recv_timeout(IDLE_TICK),
        };
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
                        audio: None,
                        reused: false,
                        via: "local",
                    })
                });
                let _ = out.send(Msg::Finished { id: job.id, dictation: None, dictated: job.dictated, target: job.target, result });
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
            Ok(Work::Begin { id, model, language, external: Some(dir), live: words, .. }) => {
                // Unloaded after idle: read again in the background for the next one; this one never waits for it.
                if words && wanted.as_ref() == Some(&model) {
                    let _ = me.send(Work::Warm(model.clone()));
                }
                // The cloud hears the recording. The local model shows his words as he speaks only when it is already
                // loaded: never loaded for them, so the key's release never waits on a load.
                let words = words && path_of(&loaded) == Some(model.as_path());
                live = Some(Live { id, external: Some(dir), live_words: words, ..Live::new(language, 0, None) });
            }
            Ok(Work::Begin { id, model, language, external: None, keep, live: words, remote: servers }) => {
                if plan_slot(false, path_of(&loaded), path_of(&other), &model) == Slot::SwapThenMain {
                    std::mem::swap(&mut loaded, &mut other);
                }
                loaded_at = Instant::now();
                let fresh = match ensure_loaded(&mut loaded, &model) {
                    Ok(load_ms) => Live::new(language, load_ms, None),
                    Err(e) => {
                        loaded = None;
                        Live::new(language, 0, Some(e))
                    }
                };
                let remote = (!servers.is_empty()).then(|| Remote::connect(servers, fresh.language.clone()));
                live = Some(Live { id, keep, live_words: words, remote, ..fresh });
            }
            Ok(Work::Audio(id, mut pcm)) => {
                loaded_at = Instant::now();
                let (behind, next) = gather_audio(&work, id, &mut pcm);
                carried = next;
                let Some(current) = live.as_mut().filter(|l| l.id == id) else {
                    continue;
                };
                current.hear(loaded.as_mut().map(|(_, session)| session), &pcm, behind);
            }
            Ok(Work::End { id, target, released, timing }) => {
                // Only its own recording answers a dictation; any other is never handed over as its words.
                let result = match live.take_if(|l| l.id == id) {
                    Some(current) => current
                        .finish(loaded.as_mut().map(|(_, session)| session), released)
                        .map(|done| {
                            let mut timing = timing;
                            timing["reused"] = json!(done.reused);
                            timing["recognizer"] = json!(done.via);
                            Done { timing: Some(timing), ..done }
                        }),
                    None => Err("That dictation's recording was lost, so nothing was written.".to_string()),
                };
                let _ = out.send(Msg::Finished { id: None, dictation: Some(id), dictated: true, target, result });
            }
            Ok(Work::Abort) => live = None,
            Ok(Work::Warm(model)) => {
                if warm_needed(&model, path_of(&loaded), path_of(&other), warming, model.is_file()) {
                    warming = true;
                    warm_in_background(model.clone(), me.clone(), |m| load(m));
                }
                wanted = Some(model);
            }
            Ok(Work::Warmed(path, session)) => {
                warming = false;
                if let Some(session) = session.filter(|_| loaded.is_none()) {
                    loaded = Some((path, session));
                    loaded_at = Instant::now();
                }
            }
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

/// A hold key of modifiers alone (Ctrl+Shift+Win), read without blocking anything: blocking the key that completes it
/// would eat Windows' own Win+Ctrl+Shift+B. It holds only while exactly those modifiers are down and no other key; a key
/// joining the chord cancels it, and that key goes on to Windows untouched.
struct ModChord {
    want: Modifiers,
    active: bool,
    spoiled: bool,
    /// Other keys down now: the chord never starts over one.
    held: HashSet<Key>,
}

#[derive(Debug, PartialEq)]
enum ChordOut {
    Down,
    Up,
    /// Another key joined while it held: the dictation it started is dropped.
    Cancel,
}

impl ModChord {
    fn new(want: Modifiers) -> Self {
        Self { want, active: false, spoiled: false, held: HashSet::new() }
    }

    fn step(&mut self, modifiers: Modifiers, key: Option<Key>, down: bool) -> Option<ChordOut> {
        if let Some(key) = key {
            if !down {
                self.held.remove(&key);
                return None;
            }
            self.held.insert(key);
            if self.active && !self.spoiled {
                self.spoiled = true;
                return Some(ChordOut::Cancel);
            }
            return None;
        }
        // A key-up missed while every modifier was up cannot block the chord for good.
        if modifiers.is_empty() {
            self.held.clear();
        }
        let now = self.want.matches(modifiers);
        if now && !self.active && self.held.is_empty() {
            self.active = true;
            self.spoiled = false;
            return Some(ChordOut::Down);
        }
        if !now && self.active {
            self.active = false;
            return (!std::mem::take(&mut self.spoiled)).then_some(ChordOut::Up);
        }
        None
    }
}

/// The shell opens Start when Win comes up with no other key since it went down; an unassigned key between them keeps
/// it shut, as the hotkey hook's own mask does (`handy-keys`' MENU_MASK_VK).
#[cfg(windows)]
fn mask_start_menu() {
    let _ = input_windows::keys(&[0xE8]);
}

#[cfg(not(windows))]
fn mask_start_menu() {}

fn start_keys(config: &Config, tx: &Sender<Msg>, clock: Instant) -> Result<Option<Keys>, String> {
    if config.hold.is_empty() && config.toggle.is_empty() {
        return Ok(None);
    }
    let parse = |text: &String| -> Result<Hotkey, String> { text.parse().map_err(|e| format!("{text}: {e}")) };
    let mut chords = Vec::new();
    let mut keyed = Vec::new();
    for text in &config.hold {
        let hotkey = parse(text)?;
        if hotkey.key.is_none() {
            chords.push(hotkey.modifiers);
        } else {
            keyed.push(hotkey);
        }
    }
    let toggles = config.toggle.iter().map(parse).collect::<Result<Vec<_>, _>>()?;
    let stop = Arc::new(AtomicBool::new(false));
    if !keyed.is_empty() || !toggles.is_empty() {
        // `new_with_blocking`: a chord with a key must not also reach the focused app.
        let manager = HotkeyManager::new_with_blocking().map_err(|e| e.to_string())?;
        let register = |hotkeys: Vec<Hotkey>| -> Result<Vec<_>, String> {
            hotkeys.into_iter().map(|h| manager.register(h).map_err(|e| e.to_string())).collect()
        };
        let hold = register(keyed)?;
        register(toggles)?;
        let stopped = stop.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match manager.try_recv() {
                    Some(event) => {
                        let pressed = event.state == HotkeyState::Pressed;
                        let at = clock.elapsed().as_secs_f64() * 1000.0;
                        let _ = tx.send(Msg::Key { hold: hold.contains(&event.id), pressed, at });
                    }
                    None => thread::sleep(Duration::from_millis(5)),
                }
            }
        });
    }
    if !chords.is_empty() {
        let listener = KeyboardListener::new().map_err(|e| e.to_string())?;
        let stopped = stop.clone();
        let tx = tx.clone();
        thread::spawn(move || {
            let mut machines: Vec<ModChord> = chords.into_iter().map(ModChord::new).collect();
            while !stopped.load(Ordering::Relaxed) {
                let Some(event) = listener.try_recv() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let at = clock.elapsed().as_secs_f64() * 1000.0;
                for machine in &mut machines {
                    match machine.step(event.modifiers, event.key, event.is_key_down) {
                        Some(ChordOut::Down) => {
                            mask_start_menu();
                            let _ = tx.send(Msg::Key { hold: true, pressed: true, at });
                        }
                        Some(ChordOut::Up) => {
                            let _ = tx.send(Msg::Key { hold: true, pressed: false, at });
                        }
                        Some(ChordOut::Cancel) => {
                            let _ = tx.send(Msg::ChordJoined);
                        }
                        None => {}
                    }
                }
            }
        });
    }
    Ok(Some(Keys(stop)))
}

/// Hands the microphone to the engine as it arrives.
struct LiveSink {
    dictation: u64,
    work: Sender<Work>,
    samples: Arc<AtomicUsize>,
    first_audio: Arc<OnceLock<Instant>>,
    /// The serve thread, which writes the waveform's `pcm` lines: stdout is never touched from the audio callback.
    out: Sender<Msg>,
    /// Config's `meter`, read live so turning wake words on or off mid-recording takes effect.
    meter_on: Arc<AtomicBool>,
    meter: Meter,
}

/// Shortest gap between two waveform blocks: about 30 a second.
const METER_GAP: Duration = Duration::from_millis(33);

/// Audio not yet sent for the pill's waveform, and when the last block went.
#[derive(Default)]
struct Meter {
    pending: Vec<f32>,
    sent: Option<Instant>,
}

impl Meter {
    /// The newest whole block once one is due; a burst of audio sends its last block, never a backlog.
    fn feed(&mut self, more: &[f32], now: Instant) -> Option<Vec<f32>> {
        self.pending.extend_from_slice(more);
        let whole = self.pending.len() / METER_SAMPLES * METER_SAMPLES;
        if whole == 0 || self.sent.is_some_and(|at| now.saturating_duration_since(at) < METER_GAP) {
            // Only the newest block is ever drawn: older audio is let go.
            let keep = self.pending.len().saturating_sub(METER_SAMPLES);
            self.pending.drain(..keep);
            return None;
        }
        let block = self.pending[whole - METER_SAMPLES..whole].to_vec();
        self.pending.drain(..whole);
        self.sent = Some(now);
        Some(block)
    }
}

impl Sink for LiveSink {
    fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
        let samples = chunk.samples[..chunk.valid_frames].to_vec();
        if !samples.is_empty() {
            let _ = self.first_audio.set(Instant::now());
        }
        if self.meter_on.load(Ordering::Relaxed) {
            if let Some(block) = self.meter.feed(&samples, Instant::now()) {
                let _ = self.out.send(Msg::Meter(block));
            }
        }
        self.samples.fetch_add(samples.len(), Ordering::Relaxed);
        let _ = self.work.send(Work::Audio(self.dictation, samples));
    }
}

enum Source {
    Mic(Recorder<LiveSink>),
    Fake(Arc<AtomicBool>),
}

struct Recording {
    /// This dictation's id, on every message it sends the engine.
    id: u64,
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
    dictation: u64,
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
            let _ = work.send(Work::Audio(dictation, chunk.to_vec()));
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
        Ok(()) => {
            json!({"x": r.left, "y": r.top, "width": r.right - r.left, "height": r.bottom - r.top})
        }
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

/// The desktop waits this long for a checked paste (`pasteChecked`); a verdict after it is never pasted.
const PASTE_DEADLINE: Duration = Duration::from_millis(1_500);

/// Which step stops a dictation paste, in the order they are checked. `no_field`: the keyboard is on icons, a list or a
/// button (`focused_takes_no_text`), where a paste lands nowhere.
fn paste_verdict(focused: bool, same_window: bool, same_title: bool, secret: bool, no_field: bool) -> &'static str {
    if !focused {
        "gone"
    } else if !same_window || !same_title {
        "changed"
    } else if secret {
        "secret"
    } else if no_field {
        "nofield"
    } else {
        "ok"
    }
}

/// Hebrew, Arabic, Syriac, Thaana, N'Ko and their presentation forms: the ghost draws left to right only.
#[cfg_attr(not(windows), allow(dead_code))]
fn has_rtl(text: &str) -> bool {
    text.chars().any(|c| matches!(c, '\u{0590}'..='\u{07FF}' | '\u{FB1D}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFC}'))
}

/// The desktop and taskbar: shell panes with nothing to type into. Windows reports them as a plain pane, which
/// `focused_takes_no_text` otherwise keeps as a box because editors that draw their own text look the same.
#[cfg_attr(not(windows), allow(dead_code))]
fn shell_surface(class: &str) -> bool {
    ["Progman", "WorkerW", "SHELLDLL_DefView", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class)
}

#[cfg(windows)]
fn focus_for_paste(window: isize) -> Result<(), String> {
    capture::focus_window(window).map(drop)
}

/// Bringing a window forward is the Windows helper's; elsewhere the words go to the clipboard, as before.
#[cfg(not(windows))]
fn focus_for_paste(_window: isize) -> Result<(), String> {
    Err("not on this platform yet".to_string())
}

/// Esc is the helper's while a hold records, since the desktop's Esc shortcut never fires under the hold's modifiers.
#[cfg(windows)]
fn take_escape(tx: &Sender<Msg>, on: bool) {
    if on {
        escape_windows::arm(tx)
    } else {
        escape_windows::disarm()
    }
}

#[cfg(not(windows))]
fn take_escape(_tx: &Sender<Msg>, _on: bool) {}

#[cfg(windows)]
fn focused_is_secret() -> bool {
    uia::focused_is_secret()
}

#[cfg(not(windows))]
fn focused_is_secret() -> bool {
    false
}

#[cfg(windows)]
fn focused_takes_no_text() -> bool {
    uia::focused_takes_no_text()
}

#[cfg(not(windows))]
fn focused_takes_no_text() -> bool {
    false
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
        let me = job_tx.clone();
        thread::spawn(move || engine_thread(job_rx, tx, me));
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
    let meter_on = Arc::new(AtomicBool::new(false));
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
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let _ = job_tx.send(Work::Begin {
            id,
            model,
            language: config.language.clone(),
            external: config.external.clone(),
            keep: config.keep_audio.clone(),
            live: config.live_words,
            remote: config.recognizers.clone(),
        });
        let samples = Arc::new(AtomicUsize::new(0));
        let first_audio = Arc::new(OnceLock::new());
        let opened = match fake_mic() {
            Some(path) => {
                let stop = Arc::new(AtomicBool::new(false));
                play_fake(&path, id, job_tx.clone(), samples.clone(), first_audio.clone(), stop.clone(), tx.clone())
                    .map(|()| Source::Fake(stop))
            }
            None => {
                let open = |fresh: bool| {
                    let sink = LiveSink {
                        dictation: id,
                        work: job_tx.clone(),
                        samples: samples.clone(),
                        first_audio: first_audio.clone(),
                        out: tx.clone(),
                        meter_on: meter_on.clone(),
                        meter: Meter::default(),
                    };
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
                    Some(Recording { id, source, samples, started: Instant::now(), target, pressed, mic_ms, first_audio, via });
                emit(json!({"ev": "recording", "app": app, "title": title, "micMs": mic_ms, "dictation": id, "via": via}));
            }
            Err(message) => {
                let _ = job_tx.send(Work::Abort);
                emit(of_dictation(json!({"ev": "error", "message": message}), Some(id)));
            }
        }
    };
    let finish = |recording: &mut Option<Recording>, job_tx: &Sender<Work>, paste: bool| {
        let Some(current) = recording.take() else {
            return;
        };
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
                let _ = job_tx.send(Work::End { id: current.id, target, released, timing });
            }
            Ok(()) => {
                let _ = job_tx.send(Work::Abort);
                emit(of_dictation(json!({"ev": "idle"}), Some(current.id)));
            }
            Err(message) => {
                let _ = job_tx.send(Work::Abort);
                emit(of_dictation(json!({"ev": "error", "message": message}), Some(current.id)));
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
                                meter_on.store(config.meter, Ordering::Relaxed);
                                let bound = !config.hold.is_empty() || !config.toggle.is_empty() || config.mouse.is_some();
                                let local = config.model.is_some() && (config.external.is_none() || config.live_words);
                                let keep = config.keep_loaded && bound && local;
                                let _ = job_tx.send(Work::Keep(keep));
                                // Live words with the cloud, or a model kept loaded: read in the background now, only if
                                // it is on disk (never downloaded for this), so the first dictation never waits for it
                                // (his first after a start waited 1.6 to 2.4 s).
                                if let (true, Some(model)) =
                                    (keep || (config.live_words && config.external.is_some()), config.model.as_ref())
                                {
                                    let _ = job_tx.send(Work::Warm(model.clone()));
                                }
                                #[cfg(windows)]
                                mouse_windows::configure(config.mouse.as_deref());
                                if rebind {
                                    // Nothing can stop a recording once its keys are gone.
                                    if let Some(stopped) = recording.take() {
                                        let _ = job_tx.send(Work::Abort);
                                        held = false;
                                        taps = PushToTalk::default();
                                        emit(of_dictation(json!({"ev": "idle"}), Some(stopped.id)));
                                    }
                                    keys = None;
                                    thread::sleep(Duration::from_millis(30));
                                    match start_keys(&config, &tx, clock) {
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
                        take_escape(&tx, false);
                        taps = PushToTalk::default();
                    }
                    "voice" => voice_on = value["on"].as_bool().unwrap_or(false),
                    // Typing keys he presses while the ghost plays wait for that dictation's paste (Windows only).
                    "hold_keys" => {
                        #[cfg(windows)]
                        if let (Some(id), Some(window)) = (value["id"].as_u64(), value["window"].as_i64()) {
                            keygate_windows::hold(id, window as isize);
                        }
                    }
                    "release_keys" => {
                        #[cfg(windows)]
                        if let Some(id) = value["id"].as_u64() {
                            keygate_windows::release(id);
                        }
                    }
                    "cancel" => {
                        let stopped = recording.take().map(|r| r.id);
                        let _ = job_tx.send(Work::Abort);
                        held = false;
                        taps = PushToTalk::default();
                        emit(of_dictation(json!({"ev": "idle"}), stopped));
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
                    // The dictation paste in one call: bring its window forward, check it is the same window and page and
                    // not a password box, then paste. The checks run on a worker (focusing can stall for seconds); only the
                    // paste, which needs enigo, comes back to this loop, and only inside the deadline the desktop waits.
                    "paste_checked" => {
                        let id = value["id"].as_u64();
                        let text = value["text"].as_str().unwrap_or("").to_string();
                        let target = value["target"].as_i64().unwrap_or(0) as isize;
                        let title = value["title"].as_str().unwrap_or("").to_string();
                        let started = Instant::now();
                        let tx = tx.clone();
                        thread::spawn(move || {
                            let focused = focus_for_paste(target).is_ok();
                            let now = foreground_window();
                            let title_now = window_app(target).1;
                            let why = paste_verdict(
                                focused,
                                now == target,
                                title_now == title,
                                focused_is_secret(),
                                focused_takes_no_text(),
                            );
                            let _ = tx.send(Msg::PasteChecked { id, text, why, started });
                        });
                    }
                    "quit" => return,
                    _ => {}
                }
            }
            Msg::Key { hold: true, pressed, at } => {
                // Raw edges, so a press that "did not fire" can be told from one let go within SHORT_TAP_MS.
                emit(json!({"ev": "key_edge", "down": pressed, "at": at.round()}));
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
                                // Before the microphone opens (80 to 140 ms), so the pill shows on the press itself.
                                emit(json!({"ev": "pressed"}));
                                begin(&config, &mut recording, &tx, &job_tx, "hold");
                                take_escape(&tx, recording.is_some());
                            }
                        },
                        Out::Stop => {
                            held = false;
                            take_escape(&tx, false);
                            finish(&mut recording, &job_tx, true);
                        }
                        // An accidental tap: what little was heard is dropped, not transcribed. Said, so a key that
                        // seems not to fire can be told from one let go too soon.
                        Out::Cancel => {
                            held = false;
                            take_escape(&tx, false);
                            let stopped = recording.take().map(|r| r.id);
                            let _ = job_tx.send(Work::Abort);
                            emit(of_dictation(json!({"ev": "idle", "tap": true}), stopped));
                        }
                        // Hands-free from here: the desktop shows the pill's ✓ and ✕.
                        Out::Latch => {
                            take_escape(&tx, false);
                            emit(json!({"ev": "latched"}));
                        }
                        Out::Unlatch => {}
                    }
                }
            }
            Msg::Key { hold: false, pressed: true, .. } => {
                if !toggle_down {
                    toggle_down = true;
                    match dictation_press(recording.is_some(), voice_on) {
                        Press::Finish => finish(&mut recording, &job_tx, true),
                        Press::Begin => begin(&config, &mut recording, &tx, &job_tx, "toggle"),
                        Press::ToDesktop => emit(json!({"ev": "binding", "id": "toggle"})),
                    }
                }
            }
            Msg::Key { hold: false, pressed: false, .. } => toggle_down = false,
            Msg::FakeEnded => finish(&mut recording, &job_tx, true),
            Msg::ChordJoined => {
                held = false;
                take_escape(&tx, false);
                taps = PushToTalk::default();
                if let Some(stopped) = recording.take() {
                    let _ = job_tx.send(Work::Abort);
                    emit(of_dictation(json!({"ev": "idle", "joined": true}), Some(stopped.id)));
                }
            }
            Msg::Meter(block) => emit(json!({"ev": "pcm", "b64": meter_b64(&block)})),
            Msg::PasteChecked { id, text, why, started } => {
                // Past the deadline the desktop has kept the words already; pasting them now would type them twice.
                let why = if why == "ok" && started.elapsed() >= PASTE_DEADLINE { "late" } else { why };
                let mut line = json!({"ev": "paste_checked", "id": id, "why": why});
                if why == "ok" {
                    if let Err(e) = paste_text(&mut enigo, &text, config.paste) {
                        line = json!({"ev": "paste_checked", "id": id, "why": "refused", "error": e});
                    }
                }
                line["pasteMs"] = json!(started.elapsed().as_millis() as u64);
                if why == "secret" {
                    line["secret"] = json!(true);
                }
                emit(line);
            }
            // The key is still down: its release finds no recording, so nothing is pasted.
            Msg::HeldEscape => {
                if held {
                    if let Some(stopped) = recording.take() {
                        let _ = job_tx.send(Work::Abort);
                        emit(of_dictation(json!({"ev": "idle", "discarded": true}), Some(stopped.id)));
                    }
                }
            }
            Msg::MicFailed(message) => {
                take_escape(&tx, false);
                let stopped = recording.take().map(|r| r.id);
                let _ = job_tx.send(Work::Abort);
                held = false;
                taps = PushToTalk::default();
                emit(of_dictation(json!({"ev": "error", "message": message}), stopped));
            }
            Msg::Finished { id, dictation, dictated, target, result } => match result {
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
                        "ev": "text", "id": id, "dictation": dictation, "text": done.text, "audioMs": done.audio_ms,
                        "inferMs": done.infer_ms, "loadMs": done.load_ms, "pasteError": pasted_error,
                        "dictated": dictated, "pasted": paste, "target": target,
                        "releaseMs": done.release_ms, "pieces": done.pieces, "wav": done.wav, "model": done.model,
                        "timing": done.timing, "pasteMs": paste_ms, "audio": done.audio,
                    }));
                }
                Err(message) => emit(json!({"ev": "text", "id": id, "dictation": dictation, "error": message, "dictated": dictated})),
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
        emit(json!({"file": file, "text": join_pieces(&text), "audioMs": pcm.len() as u64 / 16, "inferMs": busy,
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
    fn a_paste_stops_at_the_first_failed_check() {
        let rows = [
            ((false, true, true, false, false), "gone"),
            ((false, false, false, true, true), "gone"),
            ((true, false, true, false, false), "changed"),
            ((true, true, false, false, false), "changed"),
            ((true, false, false, true, true), "changed"),
            ((true, true, true, true, true), "secret"),
            // Explorer's icons or the desktop in front: nothing takes the paste.
            ((true, true, true, false, true), "nofield"),
            ((true, true, true, false, false), "ok"),
        ];
        for ((focused, same_window, same_title, secret, no_field), want) in rows {
            assert_eq!(paste_verdict(focused, same_window, same_title, secret, no_field), want);
        }
    }

    #[test]
    fn right_to_left_script_before_the_caret_is_seen() {
        assert!(has_rtl("hello שלום"));
        assert!(has_rtl("مرحبا"));
        assert!(!has_rtl("hello, naïve café — 日本語"));
        assert!(!has_rtl(""));
    }

    #[test]
    fn the_desktop_and_taskbar_are_no_text_box() {
        for class in ["Progman", "WorkerW", "SHELLDLL_DefView", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"] {
            assert!(shell_surface(class), "{class}");
        }
        // Panes editors draw their own text in stay boxes.
        for class in ["", "Chrome_RenderWidgetHostHWND", "_WwG", "Scintilla", "CabinetWClass"] {
            assert!(!shell_surface(class), "{class}");
        }
    }

    #[test]
    fn the_waveform_sends_at_most_one_newest_block_per_gap() {
        let (mut meter, t0) = (Meter::default(), Instant::now());
        // Not a whole block yet.
        assert!(meter.feed(&vec![0.1; METER_SAMPLES / 2], t0).is_none());
        // A burst of three blocks sends only the newest one.
        let mut burst = vec![0.1; METER_SAMPLES / 2];
        burst.extend(vec![0.2; METER_SAMPLES * 2]);
        burst.extend(vec![0.3; METER_SAMPLES]);
        assert_eq!(meter.feed(&burst, t0), Some(vec![0.3; METER_SAMPLES]));
        // Within the gap nothing goes, and the backlog never grows past a block.
        assert!(meter.feed(&vec![0.4; METER_SAMPLES * 3], t0 + Duration::from_millis(10)).is_none());
        assert!(meter.pending.len() <= METER_SAMPLES);
        assert_eq!(meter.feed(&[], t0 + METER_GAP), Some(vec![0.4; METER_SAMPLES]));
    }

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
    fn the_cloud_recording_reaches_the_local_model_only_for_live_words() {
        let speech: Vec<f32> = (0..16_000).map(|i| (i as f32 * 0.3).sin() * 0.2).collect();
        let mut quiet = Live { external: Some(std::env::temp_dir()), ..Live::new(None, 0, None) };
        quiet.hear(None, &speech, false);
        assert_eq!((quiet.heard.len(), quiet.chunker.pending_len()), (16_000, 0));
        let mut shown = Live { external: Some(std::env::temp_dir()), live_words: true, ..Live::new(None, 0, None) };
        shown.hear(None, &speech, false);
        assert_eq!((shown.heard.len(), shown.chunker.pending_len()), (16_000, 16_000));
        let mut local = Live::new(None, 0, None);
        local.hear(None, &speech, false);
        assert_eq!(local.chunker.pending_len(), 16_000);
    }

    #[test]
    fn audio_waiting_behind_a_chunk_is_taken_with_it_and_the_next_message_kept() {
        let (tx, rx) = channel::<Work>();
        let mut pcm = vec![0.1; 4];
        assert!(matches!(gather_audio(&rx, 1, &mut pcm), (false, None)));
        tx.send(Work::Audio(1, vec![0.2; 3])).unwrap();
        tx.send(Work::Audio(1, vec![0.3; 2])).unwrap();
        tx.send(Work::Abort).unwrap();
        tx.send(Work::Audio(1, vec![0.4; 1])).unwrap();
        let (behind, next) = gather_audio(&rx, 1, &mut pcm);
        assert!(behind && matches!(next, Some(Work::Abort)));
        assert_eq!(pcm.len(), 9);
        // What follows the other message stays queued, in order.
        assert!(matches!(rx.try_recv(), Ok(Work::Audio(1, rest)) if rest.len() == 1));
        // Another dictation's audio is never gathered into this one's.
        tx.send(Work::Audio(2, vec![0.5; 1])).unwrap();
        assert!(matches!(gather_audio(&rx, 1, &mut pcm), (false, Some(Work::Audio(2, _)))));
    }

    #[test]
    fn a_dictation_never_answers_with_another_ones_recording() {
        let (job_tx, job_rx) = channel::<Work>();
        let (out_tx, out_rx) = channel::<Msg>();
        let me = job_tx.clone();
        thread::spawn(move || engine_thread(job_rx, out_tx, me));
        let dir = std::env::temp_dir().join(format!("tessaya-ids-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let begin = |id| Work::Begin {
            id,
            model: PathBuf::from("parakeet-test.gguf"),
            language: None,
            external: Some(dir.clone()),
            keep: None,
            live: false,
            remote: vec![],
        };
        let end = |id| Work::End { id, target: None, released: Instant::now(), timing: json!({}) };
        job_tx.send(begin(1)).unwrap();
        job_tx.send(Work::Audio(1, vec![0.1; 32_000])).unwrap();
        // The second starts before the first's end arrives; the first's late audio and end must not reach it.
        job_tx.send(begin(2)).unwrap();
        job_tx.send(Work::Audio(2, vec![0.1; 16_000])).unwrap();
        job_tx.send(Work::Audio(1, vec![0.1; 8_000])).unwrap();
        job_tx.send(end(1)).unwrap();
        job_tx.send(end(2)).unwrap();
        let first = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(first, Msg::Finished { dictation: Some(1), result: Err(_), .. }));
        let second = out_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(second, Msg::Finished { dictation: Some(2), result: Ok(Done { audio_ms: 1_000, .. }), .. }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_background_read_never_loads_a_model_twice_and_runs_again_after_an_unload() {
        let m = Path::new("parakeet.gguf");
        assert!(warm_needed(m, None, None, false, true));
        assert!(!warm_needed(m, Some(m), None, false, true));
        assert!(!warm_needed(m, Some(Path::new("wake.gguf")), Some(m), false, true));
        assert!(!warm_needed(m, None, None, true, true));
        // Not on disk: never downloaded for this.
        assert!(!warm_needed(m, None, None, false, false));
        // Unloaded after idle, the slot is empty again: the next ask reads it again.
        assert!(warm_needed(m, None, Some(Path::new("wake.gguf")), false, true));
    }

    #[test]
    fn a_cloud_dictation_never_waits_on_the_live_words_load() {
        let (job_tx, job_rx) = channel::<Work>();
        let (out_tx, out_rx) = channel::<Msg>();
        let me = job_tx.clone();
        thread::spawn(move || engine_thread(job_rx, out_tx, me));
        // A load that takes as long as the test does: the recording must finish without it.
        let (unblock, blocked) = channel::<()>();
        let model = PathBuf::from("parakeet-test.gguf");
        let warm = warm_in_background(model.clone(), job_tx.clone(), move |_| {
            let _ = blocked.recv();
            Err("stopped".to_string())
        });
        let dir = std::env::temp_dir().join(format!("tessaya-warm-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        job_tx
            .send(Work::Begin {
                id: 1,
                model,
                language: None,
                external: Some(dir.clone()),
                keep: None,
                live: true,
                remote: vec![],
            })
            .unwrap();
        job_tx.send(Work::Audio(1, vec![0.1; 16_000])).unwrap();
        job_tx.send(Work::End { id: 1, target: None, released: Instant::now(), timing: json!({}) }).unwrap();
        let finished = out_rx.recv_timeout(Duration::from_secs(5)).expect("the release waited on the load");
        assert!(matches!(finished, Msg::Finished { result: Ok(Done { wav: Some(_), .. }), .. }));
        unblock.send(()).unwrap();
        warm.join().unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn threads_are_half_the_cores_but_never_more_than_the_cores() {
        assert_eq!([1, 2, 3, 4, 8, 16].map(default_threads), [1, 2, 2, 2, 4, 8]);
    }

    #[test]
    fn the_modifier_chord_holds_only_alone_and_lets_a_fourth_key_through() {
        let want: Hotkey = "Ctrl+Shift+Win".parse().unwrap();
        let (ctrl, shift, win) = (Modifiers::CTRL_LEFT, Modifiers::SHIFT_LEFT, Modifiers::CMD_LEFT);
        let mut chord = ModChord::new(want.modifiers);
        // In any order; only the third modifier starts it, and the first one up ends it.
        assert_eq!(chord.step(win, None, true), None);
        assert_eq!(chord.step(win | ctrl, None, true), None);
        assert_eq!(chord.step(win | ctrl | shift, None, true), Some(ChordOut::Down));
        assert_eq!(chord.step(win | ctrl | shift, None, true), None, "a modifier's key repeat");
        assert_eq!(chord.step(win | shift, None, false), Some(ChordOut::Up));
        assert_eq!(chord.step(Modifiers::empty(), None, false), None);
        // Win+Ctrl+Shift+B: B joins, the dictation is dropped, and letting go starts nothing.
        let b = Some(Key::B);
        chord.step(ctrl | shift | win, None, true);
        assert_eq!(chord.step(ctrl | shift | win, b, true), Some(ChordOut::Cancel));
        assert_eq!(chord.step(ctrl | shift | win, b, false), None);
        assert_eq!(chord.step(ctrl | shift, None, false), None);
        // A key already down when the chord forms: it never starts.
        chord.step(Modifiers::empty(), None, false);
        chord.step(Modifiers::empty(), Some(Key::A), true);
        assert_eq!(chord.step(ctrl | shift | win, None, true), None);
        // Wispr's Ctrl+Win, or Alt as well, is not ours.
        let mut other = ModChord::new(want.modifiers);
        assert_eq!(other.step(ctrl | win, None, true), None);
        assert_eq!(other.step(ctrl | shift | win | Modifiers::OPT_LEFT, None, true), None);
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
