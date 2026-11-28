//! The recognition of one dictation at a time, as the desktop sidecar's engine does it (native/baton-dictation
//! main.rs `Live`): the same pieces, previews, pause preview and its reuse. Kept in step by hand until the sidecar's
//! engine moves into a shared module; `live.rs` itself is shared source.
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Instant;

use transcribe_cpp::{Model, RunOptions, Session, SessionOptions, TimestampKind};

use crate::live::{
    join_pieces, lift_gain, preview_due, words_after, ChunkParams, Chunker, Piece, REUSE_FLAT,
};

const RATE: usize = 16_000;
/// Silence after the audio, as the sidecar pads it, so the last word is heard whole.
const TAIL_SAMPLES: usize = RATE / 5;

pub enum Feed {
    Audio(Vec<f32>),
    End(Instant),
    Abort,
}

pub enum Reply {
    Partial { text: String, pause: bool },
    Text { text: String, infer_ms: u64, pieces: u64, reused: bool, release_ms: u64, words: Scored },
    Error(String),
}

pub struct Job {
    pub audio: Receiver<Feed>,
    pub replies: Sender<Reply>,
    pub language: Option<String>,
    /// His dictionary's terms, in priority order: the decoder favours them once the model starts one (phrase boosting).
    pub vocabulary: Vec<String>,
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
            // Warm, off the clock.
            let _ = session.run(&vec![0.0f32; RATE], &RunOptions::default());
            for job in incoming {
                recognise(&mut session, job);
                queue.fetch_sub(1, Ordering::SeqCst);
            }
        });
    }
    (jobs, queue)
}

fn decode(session: &mut Session, piece: Piece, start: usize, options: &RunOptions) -> Result<(String, Scored), String> {
    decode_words(session, piece, start, options).map(|(text, _, scored)| (text, scored))
}

/// A preview's words with where each ends, in samples of the uncut audio.
type EndedWords = Vec<(usize, String)>;

/// A kept word, its weakest token's confidence (NaN where the model gives none; transcript repair, V-018), and when it
/// starts and ends in ms from the start of the dictation's audio.
#[derive(Clone, Debug, PartialEq)]
pub struct Heard {
    pub w: String,
    pub p: f32,
    pub s_ms: i64,
    pub e_ms: i64,
}

pub type Scored = Vec<Heard>;

/// A time in a piece (ms from its pcm's start, context included) as ms from the start of the dictation's audio, where
/// the piece's new audio begins at sample `start`. A word straddling the seam may start just before it: clamped to 0.
fn dictation_ms(start: usize, context_ms: i64, t_ms: i64) -> i64 {
    (start as i64 / 16 + t_ms - context_ms).max(0)
}

/// The final text's own words with their scores and times, one for one; none when they do not line up (repair and
/// timings stay off this turn). Each takes the text's spelling, so a stop `join_pieces` dropped keeps its word's times.
fn final_words(text: &str, scored: Scored) -> Scored {
    let written: Vec<&str> = text.split_whitespace().collect();
    if written.len() != scored.len() {
        return Vec::new();
    }
    scored.into_iter().zip(written).map(|(heard, w)| Heard { w: w.to_string(), ..heard }).collect()
}

/// `decode`, and each kept word with where it ends in the piece's new audio (the sidecar's `decode_words`, #726).
/// `start` is where the piece's new audio begins in the dictation's audio, in samples.
fn decode_words(
    session: &mut Session,
    piece: Piece,
    start: usize,
    options: &RunOptions,
) -> Result<(String, EndedWords, Scored), String> {
    let Piece { mut pcm, context, .. } = piece;
    lift_gain(&mut pcm);
    pcm.resize(pcm.len() + TAIL_SAMPLES, 0.0);
    let result = session.run(&pcm, options).map_err(|e| format!("transcribe: {e}"))?;
    let context_ms = context as i64 / 16;
    let kept: Vec<(usize, _)> = result
        .words
        .iter()
        .enumerate()
        .filter(|(_, w)| context == 0 || w.t0_ms >= context_ms - 80)
        .filter(|(_, w)| !w.text.trim().is_empty())
        .collect();
    let ended =
        kept.iter().map(|(_, w)| (((w.t1_ms - context_ms).max(0) * 16) as usize, w.text.trim().to_string())).collect();
    let scored = kept
        .iter()
        .map(|(i, w)| {
            let tokens = result.tokens.iter().filter(|t| t.word_index as usize == *i);
            Heard {
                w: w.text.trim().to_string(),
                p: tokens.map(|t| t.p).fold(f32::NAN, f32::min),
                s_ms: dictation_ms(start, context_ms, w.t0_ms),
                e_ms: dictation_ms(start, context_ms, w.t1_ms),
            }
        })
        .collect();
    if context == 0 || result.words.is_empty() {
        return Ok((result.text.trim().to_string(), ended, scored));
    }
    Ok((words_after(result.words.iter().map(|w| (w.t0_ms, w.text.as_str())), context_ms), ended, scored))
}

/// A word ending this close to where a preview stopped may be cut off there: release decodes from before it.
const PREVIEW_SAFE: usize = RATE * 2 / 5;

/// The preview's words that ended well before it stopped, and where the last of them ends: the release keeps these and
/// decodes only what follows, so a long uncut stretch costs its last second or so instead of all of it.
fn safe_words(words: &EndedWords, previewed: usize) -> Option<(usize, String)> {
    let safe = previewed.saturating_sub(PREVIEW_SAFE);
    let kept: Vec<&(usize, String)> = words.iter().take_while(|(end, _)| *end <= safe).collect();
    let &&(end, _) = kept.last()?;
    Some((end, kept.iter().map(|(_, w)| w.as_str()).collect::<Vec<_>>().join(" ")))
}

fn recognise(session: &mut Session, job: Job) {
    let Job { audio, replies, language, vocabulary } = job;
    // Token timestamps: the same words, plus each token's confidence (Word alone leaves `tokens` empty).
    let options = RunOptions { language, vocabulary, timestamps: TimestampKind::Token, ..Default::default() };
    let mut chunker = Chunker::new(ChunkParams::from_env());
    let mut heard: Vec<f32> = Vec::new();
    let mut text: Vec<String> = Vec::new();
    let mut scored: Scored = Vec::new();
    let (mut previewed, mut preview_ms, mut pause_checked) = (0usize, 0u64, 0usize);
    let mut preview: Option<String> = None;
    let mut preview_words: EndedWords = Vec::new();
    let mut preview_scored: Scored = Vec::new();
    let (mut infer_ms, mut pieces) = (0u64, 0u64);
    loop {
        let Ok(first) = audio.recv() else { return };
        // Everything already waiting is taken at once: then the engine is behind and no preview runs.
        let mut block = Vec::new();
        let mut released = None;
        let mut behind = false;
        let take = |feed: Feed, block: &mut Vec<f32>| match feed {
            Feed::Audio(pcm) => {
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
            let start = heard.len() - chunker.pending_len() - (piece.pcm.len() - piece.context);
            let t = Instant::now();
            match decode(session, piece, start, &options) {
                Ok((words, piece_scored)) if !words.is_empty() => {
                    text.push(words);
                    scored.extend(piece_scored);
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
            preview_words.clear();
            preview_scored.clear();
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
                        let start = heard.len() - chunker.pending_len();
                        let decoded = decode_words(session, piece, start, &options).ok();
                        preview_words = decoded.as_ref().map(|(_, words, _)| words.clone()).unwrap_or_default();
                        preview_scored = decoded.as_ref().map(|(_, _, s)| s.clone()).unwrap_or_default();
                        preview = decoded.map(|(text, _, _)| text);
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
                    scored.append(&mut preview_scored);
                }
                reused = true;
                pieces += 1;
            } else if let Some(piece) = {
                if let Some((end, words)) = safe_words(&preview_words, previewed) {
                    chunker.skip(end);
                    scored.extend(preview_scored.iter().take(words.split_whitespace().count()).cloned());
                    text.push(words);
                }
                chunker.finish()
            } {
                let start = heard.len() - (piece.pcm.len() - piece.context);
                let t = Instant::now();
                match decode(session, piece, start, &options) {
                    Ok((words, piece_scored)) if !words.is_empty() => {
                        text.push(words);
                        scored.extend(piece_scored);
                    }
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
        let text = join_pieces(&text);
        let words = final_words(&text, scored);
        let _ = replies.send(Reply::Text {
            text,
            words,
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
    fn a_release_keeps_the_preview_words_that_ended_well_before_it_stopped() {
        let words: EndedWords =
            vec![(RATE, "turn".into()), (2 * RATE, "on".into()), (3 * RATE, "the".into()), (4 * RATE - 100, "light".into())];
        // The preview stopped at 4 s: "light" ended within 0.4 s of that, so it is decoded again with what follows.
        assert_eq!(safe_words(&words, 4 * RATE), Some((3 * RATE, "turn on the".into())));
        // Nothing ended early enough: the whole uncut audio is decoded, as before.
        assert_eq!(safe_words(&words, RATE), None);
        assert_eq!(safe_words(&Vec::new(), 4 * RATE), None);
    }

    #[test]
    fn a_word_s_times_count_from_the_dictation_s_start_and_survive_its_spelling_changing() {
        // A second piece whose new audio begins 3 s in, with 1 s of context: 1.2 s into its pcm is 3.2 s in.
        assert_eq!(dictation_ms(3 * RATE, 1_000, 1_200), 3_200);
        // A word straddling the seam starts a little before it, never before the dictation.
        assert_eq!(dictation_ms(0, 0, -40), 0);
        let heard = |w: &str, s_ms, e_ms| Heard { w: w.into(), p: 0.9, s_ms, e_ms };
        // join_pieces dropped the stop the first piece ended on: the word keeps its times, spelled as the text has it.
        let text = "turn on the light please";
        let scored = vec![
            heard("turn", 0, 200),
            heard("on", 200, 350),
            heard("the", 350, 450),
            heard("light.", 450, 900),
            heard("please", 3_200, 3_700),
        ];
        let words = final_words(text, scored);
        assert_eq!(words[3], heard("light", 450, 900));
        assert_eq!(words.iter().map(|h| h.w.as_str()).collect::<Vec<_>>().join(" "), text);
        // Words that do not line up with the text are left out, not guessed at.
        assert!(final_words("turn on", vec![heard("turn", 0, 200)]).is_empty());
    }
}
