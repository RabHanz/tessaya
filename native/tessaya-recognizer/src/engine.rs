//! The recognition of one dictation at a time, as the desktop sidecar's engine does it (native/baton-dictation
//! main.rs `Live`): the same pieces, previews, pause preview and its reuse. Kept in step by hand until the sidecar's
//! engine moves into a shared module; `live.rs` itself is shared source.
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use transcribe_cpp::{Model, RunOptions, Session, SessionOptions, TimestampKind};

use crate::live::{
    join_pieces, lift_gain, preview_due, words_after, ChunkParams, Chunker, Piece, REUSE_FLAT,
};

const RATE: usize = 16_000;
/// Silence after the audio, as the sidecar pads it, so the last word is heard whole.
const TAIL_SAMPLES: usize = RATE / 5;

/// How fast this machine decodes now: a moving average of the real-time factor over the last few pieces.
pub static SPEED: Speed = Speed { rtf_milli: AtomicU64::new(0), at_ms: AtomicU64::new(0) };
/// An average older than this says nothing about the machine now (its load moves on); the CPU probe still does.
const SPEED_FRESH: Duration = Duration::from_secs(120);

pub struct Speed {
    rtf_milli: AtomicU64,
    /// When it was last measured, in ms since the first measurement plus one; 0: never.
    at_ms: AtomicU64,
}

fn since_start() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

impl Speed {
    pub fn record(&self, took: Duration, samples: usize) {
        let rtf = took.as_millis() as u64 * 1000 / (samples as u64 / 16).max(1);
        let old = self.rtf_milli.load(Ordering::Relaxed);
        let fresh = self.at_ms.load(Ordering::Relaxed) != 0;
        // Weighted 3 in 10 to the newest piece: a few pieces turn it, one odd piece does not.
        self.rtf_milli.store(if fresh { (old * 7 + rtf * 3) / 10 } else { rtf }, Ordering::Relaxed);
        self.at_ms.store(since_start(), Ordering::Relaxed);
    }

    /// The recent real-time factor, or None when nothing was decoded lately.
    pub fn recent(&self) -> Option<f64> {
        let at = self.at_ms.load(Ordering::Relaxed);
        (at != 0 && since_start() - at < SPEED_FRESH.as_millis() as u64)
            .then(|| self.rtf_milli.load(Ordering::Relaxed) as f64 / 1000.0)
    }
}

pub enum Feed {
    Audio(Vec<f32>),
    End(Instant),
    Abort,
}

pub enum Reply {
    Partial { text: String, pause: bool },
    Text { text: String, infer_ms: u64, pieces: u64, reused: bool, release_ms: u64 },
    Error(String),
}

pub struct Job {
    pub audio: Receiver<Feed>,
    /// Samples sent to `audio` and not yet taken off it: the decode backlog the health answer reports.
    pub waiting: Arc<AtomicUsize>,
    pub replies: Sender<Reply>,
    pub language: Option<String>,
}

/// Loads the model once and recognises dictations one after another; `queue` counts those begun and not finished.
pub fn start(model: &Path, threads: i32) -> (Sender<Job>, Arc<AtomicUsize>) {
    let session = Model::load(model)
        .and_then(|m| m.session_with(&SessionOptions { n_threads: threads, ..Default::default() }))
        .expect("the model loads");
    let (jobs, incoming) = channel::<Job>();
    let queue = Arc::new(AtomicUsize::new(0));
    {
        let queue = queue.clone();
        std::thread::spawn(move || {
            let mut session = session;
            // Warm, off the clock; it is also the first speed measured.
            let started = Instant::now();
            let _ = session.run(&vec![0.0f32; RATE], &RunOptions::default());
            SPEED.record(started.elapsed(), RATE);
            for job in incoming {
                recognise(&mut session, job);
                queue.fetch_sub(1, Ordering::SeqCst);
            }
        });
    }
    (jobs, queue)
}

fn decode(session: &mut Session, piece: Piece, language: Option<String>) -> Result<String, String> {
    let Piece { mut pcm, context, .. } = piece;
    lift_gain(&mut pcm);
    pcm.resize(pcm.len() + TAIL_SAMPLES, 0.0);
    let options = RunOptions { language, timestamps: TimestampKind::Word, ..Default::default() };
    let started = Instant::now();
    let result = session.run(&pcm, &options).map_err(|e| format!("transcribe: {e}"))?;
    SPEED.record(started.elapsed(), pcm.len());
    if context == 0 || result.words.is_empty() {
        return Ok(result.text.trim().to_string());
    }
    Ok(words_after(result.words.iter().map(|w| (w.t0_ms, w.text.as_str())), context as i64 / 16))
}

fn recognise(session: &mut Session, job: Job) {
    let Job { audio, replies, language, waiting } = job;
    let mut chunker = Chunker::new(ChunkParams::from_env());
    let mut heard: Vec<f32> = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let (mut previewed, mut preview_ms, mut pause_checked) = (0usize, 0u64, 0usize);
    let mut preview: Option<String> = None;
    let (mut infer_ms, mut pieces) = (0u64, 0u64);
    loop {
        let Ok(first) = audio.recv() else { return };
        // Everything already waiting is taken at once: then the engine is behind and no preview runs.
        let mut block = Vec::new();
        let mut released = None;
        let mut behind = false;
        let take = |feed: Feed, block: &mut Vec<f32>| match feed {
            Feed::Audio(pcm) => {
                waiting.fetch_sub(pcm.len(), Ordering::SeqCst);
                block.extend(pcm);
                None
            }
            Feed::End(at) => Some(Some(at)),
            Feed::Abort => Some(None),
        };
        if let Some(end) = take(first, &mut block) {
            match end {
                Some(at) => released = Some(at),
                None => return,
            }
        }
        while released.is_none() {
            match audio.try_recv() {
                Ok(feed) => {
                    behind = true;
                    if let Some(end) = take(feed, &mut block) {
                        match end {
                            Some(at) => released = Some(at),
                            None => return,
                        }
                    }
                }
                Err(_) => break,
            }
        }
        heard.extend_from_slice(&block);
        if let Some(piece) = chunker.push(&block) {
            let at_pause = piece.at_pause;
            let t = Instant::now();
            match decode(session, piece, language.clone()) {
                Ok(words) if !words.is_empty() => {
                    text.push(words);
                    let _ = replies.send(Reply::Partial { text: join_pieces(&text), pause: at_pause });
                }
                Ok(_) => {}
                Err(e) => {
                    let _ = replies.send(Reply::Error(e));
                    return;
                }
            }
            infer_ms += t.elapsed().as_millis() as u64;
            pieces += 1;
            previewed = 0;
            preview = None;
            pause_checked = 0;
        } else if released.is_none() && !behind {
            let pending = chunker.pending_len();
            let paused = pending >= pause_checked + 1_600 && {
                pause_checked = pending;
                chunker.paused_since(previewed, &heard)
            };
            let due = preview_due(pending, previewed, preview_ms);
            if due || paused {
                let from = previewed;
                previewed = pending;
                if !chunker.quiet_since(from, &heard) {
                    if let Some(piece) = chunker.preview() {
                        let t = Instant::now();
                        preview = decode(session, piece, language.clone()).ok();
                        if let Some(words) = &preview {
                            let all: Vec<&str> = text.iter().map(String::as_str).chain([words.as_str()]).collect();
                            let _ = replies.send(Reply::Partial { text: join_pieces(&all), pause: paused });
                        }
                        preview_ms = t.elapsed().as_millis() as u64;
                    }
                }
            }
        }
        let Some(at) = released else { continue };
        // The release: only what was not yet heard is decoded, and nothing when a preview already holds it.
        let mut reused = false;
        if !chunker.pending_is_quiet(&heard, REUSE_FLAT) {
            if preview.is_some() && !chunker.speech_after(previewed, &heard) {
                chunker.finish();
                if let Some(words) = preview.take().filter(|w| !w.is_empty()) {
                    text.push(words);
                }
                reused = true;
                pieces += 1;
            } else if let Some(piece) = chunker.finish() {
                let t = Instant::now();
                match decode(session, piece, language.clone()) {
                    Ok(words) if !words.is_empty() => text.push(words),
                    Ok(_) => {}
                    Err(e) => {
                        let _ = replies.send(Reply::Error(e));
                        return;
                    }
                }
                infer_ms += t.elapsed().as_millis() as u64;
                pieces += 1;
            }
        }
        let _ = replies.send(Reply::Text {
            text: join_pieces(&text),
            infer_ms,
            pieces,
            reused,
            release_ms: at.elapsed().as_millis() as u64,
        });
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speed_follows_the_last_few_pieces() {
        let speed = Speed { rtf_milli: AtomicU64::new(0), at_ms: AtomicU64::new(0) };
        assert_eq!(speed.recent(), None);
        speed.record(Duration::from_millis(100), RATE); // 0.1
        assert_eq!(speed.recent(), Some(0.1));
        // A slow piece moves it 3 in 10, three in a row most of the way.
        speed.record(Duration::from_millis(1100), RATE);
        assert_eq!(speed.recent(), Some(0.4));
        speed.record(Duration::from_millis(1100), RATE);
        speed.record(Duration::from_millis(1100), RATE);
        assert!(speed.recent().unwrap() > 0.75);
    }
}
