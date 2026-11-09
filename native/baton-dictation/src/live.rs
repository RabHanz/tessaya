//! Transcribing while he speaks. Neither Parakeet TDT build streams (transcribe.cpp offers that only
//! to the cache-aware models), so this is Handy's live chunking with shorter chunks: cut at pauses,
//! decode each piece as it arrives, and at key release only the last piece is left. Handy cuts for
//! accuracy at 30 s; these are cut for latency, so each piece carries the audio before it for
//! context and only the words past that audio are kept.

const RATE: usize = 16_000;
const FRAME: usize = RATE / 50;
const PAUSE_FRAMES: usize = 10;
/// The longest tail release may skip: a pause cut leaves half its pause behind.
const QUIET_TAIL_MAX: usize = RATE * 3 / 4;

#[derive(Clone, Copy)]
pub struct ChunkParams {
    pub min_samples: usize,
    pub max_samples: usize,
    pub context_samples: usize,
}

impl ChunkParams {
    /// BATON_CHUNK=min_ms,max_ms,context_ms is for measuring, like BATON_THREADS.
    pub fn from_env() -> Self {
        // Measured on 80 of his clips against Wispr (PR #649): 1 s of context cost 16.5% WER, 3 s with these lengths 5.0%
        // (whole-clip 3.4%). A pause before release still leaves nothing to decode (`pending_is_quiet`).
        let mut ms = [6_000, 15_000, 3_000];
        if let Ok(text) = std::env::var("BATON_CHUNK") {
            for (slot, value) in ms.iter_mut().zip(text.split(',')) {
                *slot = value.trim().parse().unwrap_or(*slot);
            }
        }
        let samples = |ms: usize| ms * RATE / 1000;
        Self { min_samples: samples(ms[0]), max_samples: samples(ms[1]), context_samples: samples(ms[2]) }
    }
}

/// One piece to decode: `context` samples already heard, then new audio.
#[derive(Debug, PartialEq)]
pub struct Piece {
    pub pcm: Vec<f32>,
    pub context: usize,
    /// Cut at a pause he made, not at the length limit: the likely end of what he meant to say.
    pub at_pause: bool,
}

fn frame_levels(pcm: &[f32]) -> Vec<f32> {
    pcm.chunks_exact(FRAME)
        .map(|f| (f.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt())
        .collect()
}

fn percentile(values: &[f32], at: f32) -> f32 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted.get(((sorted.len() as f32 * at) as usize).min(sorted.len().saturating_sub(1))).copied().unwrap_or(0.0)
}

/// The middle of the last pause in `pcm`. Relative to this audio's own floor and speech, so a
/// whisper pauses as clearly as a shout.
fn last_pause(pcm: &[f32], from: usize) -> Option<usize> {
    let levels = frame_levels(pcm);
    let (floor, loud) = (percentile(&levels, 0.1), percentile(&levels, 0.9));
    if loud < floor * 2.0 {
        return None;
    }
    let quiet = floor + (loud - floor) * 0.1;
    let mut run = 0;
    for (i, level) in levels.iter().enumerate().rev() {
        if *level <= quiet {
            run += 1;
        } else {
            run = 0;
        }
        if run >= PAUSE_FRAMES {
            // Extend to the start of this quiet stretch, then take its middle.
            let start = levels[..i].iter().rposition(|l| *l > quiet).map_or(0, |p| p + 1);
            let cut = (start + i + run) / 2 * FRAME;
            return (cut >= from).then_some(cut);
        }
    }
    None
}

/// With no pause at all: the quietest moment of the last 1.5 s, the least bad place to split a word.
fn quietest(pcm: &[f32]) -> usize {
    let from = pcm.len().saturating_sub(RATE * 3 / 2);
    let levels = frame_levels(&pcm[from..]);
    let best = levels.iter().enumerate().min_by(|a, b| a.1.total_cmp(b.1)).map_or(0, |(i, _)| i);
    from + best * FRAME
}

pub struct Chunker {
    params: ChunkParams,
    pending: Vec<f32>,
    /// The tail of what was already cut, as context for the next piece.
    tail: Vec<f32>,
    scanned_at: usize,
}

impl Chunker {
    pub fn new(params: ChunkParams) -> Self {
        Self { params, pending: Vec::new(), tail: Vec::new(), scanned_at: 0 }
    }

    fn cut(&mut self, at: usize, at_pause: bool) -> Piece {
        let new: Vec<f32> = self.pending.drain(..at).collect();
        let context = self.tail.len();
        let mut pcm = std::mem::take(&mut self.tail);
        pcm.extend_from_slice(&new);
        let keep = pcm.len().saturating_sub(self.params.context_samples);
        self.tail = pcm[keep..].to_vec();
        self.scanned_at = 0;
        Piece { pcm, context, at_pause }
    }

    /// Takes audio; returns a piece when a pause, or the length limit, makes one certain.
    pub fn push(&mut self, pcm: &[f32]) -> Option<Piece> {
        self.pending.extend_from_slice(pcm);
        if self.pending.len() < self.params.min_samples || self.pending.len() < self.scanned_at + RATE / 5 {
            return None;
        }
        self.scanned_at = self.pending.len();
        if let Some(at) = last_pause(&self.pending, self.params.min_samples) {
            return Some(self.cut(at, true));
        }
        if self.pending.len() >= self.params.max_samples {
            let at = quietest(&self.pending);
            return Some(self.cut(at, false));
        }
        None
    }

    /// Samples heard since the last cut.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// The audio since the last cut, with its context, left in place: a quick look at words not yet cut.
    pub fn preview(&self) -> Option<Piece> {
        if self.pending.is_empty() {
            return None;
        }
        let mut pcm = self.tail.clone();
        pcm.extend_from_slice(&self.pending);
        Some(Piece { pcm, context: self.tail.len(), at_pause: false })
    }

    /// What is left at key release.
    pub fn finish(&mut self) -> Option<Piece> {
        if self.pending.is_empty() {
            return None;
        }
        let at = self.pending.len();
        Some(self.cut(at, false))
    }

    /// Nothing but quiet since the last cut: short, below the recording's speech, and flat in its own levels, so a
    /// soft word after a pause is still heard. The words before it are decoded, so release has nothing to wait for.
    pub fn pending_is_quiet(&self, heard: &[f32]) -> bool {
        if self.pending.len() > QUIET_TAIL_MAX {
            return false;
        }
        let levels = frame_levels(heard);
        let (floor, loud) = (percentile(&levels, 0.1), percentile(&levels, 0.9));
        if loud < floor * 2.0 {
            return false;
        }
        let quiet = floor + (loud - floor) * 0.1;
        let own = frame_levels(&self.pending);
        let (own_floor, own_loud) = (percentile(&own, 0.1), percentile(&own, 1.0));
        own.iter().all(|l| *l <= quiet) && own_loud <= own_floor * 2.0 + SILENCE
    }
}

/// A preview of the uncut words is due: half a second heard, then each second more, and never more than half the time
/// spent decoding (`last_ms` is the last preview's), so a slow machine previews less often instead of falling behind.
pub fn preview_due(pending: usize, previewed: usize, last_ms: u64) -> bool {
    let step = RATE.max(last_ms as usize * 2 * RATE / 1000);
    if previewed == 0 {
        pending >= RATE / 2
    } else {
        pending >= previewed + step
    }
}

/// Words that start after the context. A word straddling the seam belongs to the piece that
/// heard it whole, which is this one, so the boundary sits slightly before the seam.
pub fn words_after<'a>(words: impl Iterator<Item = (i64, &'a str)>, context_ms: i64) -> String {
    words
        .filter(|(start, _)| *start >= context_ms - 80)
        .map(|(_, word)| word.trim())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

const TARGET_LEVEL: f32 = 0.07; // about -23 dBFS at the loud end of speech
const MAX_GAIN: f32 = 100.0; // 40 dB
const SILENCE: f32 = 2e-5; // under 1 LSB of 16-bit audio

/// Brings quiet speech up to what the model trained on. Never turns speech down, and leaves
/// digital silence alone so it does not become amplified hiss.
pub fn lift_gain(pcm: &mut [f32]) -> f32 {
    let levels = frame_levels(pcm);
    let loud = percentile(&levels, 0.95);
    if loud < SILENCE {
        return 1.0;
    }
    let gain = (TARGET_LEVEL / loud).clamp(1.0, MAX_GAIN);
    if gain > 1.0 {
        for sample in pcm.iter_mut() {
            *sample = (*sample * gain).clamp(-1.0, 1.0);
        }
    }
    gain
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARAMS: ChunkParams =
        ChunkParams { min_samples: 2 * RATE, max_samples: 6 * RATE, context_samples: RATE };

    fn tone(seconds: f32, level: f32) -> Vec<f32> {
        (0..(seconds * RATE as f32) as usize).map(|i| (i as f32 * 0.3).sin() * level).collect()
    }

    fn speech_with_gap(level: f32) -> Vec<f32> {
        let mut pcm = tone(3.0, level);
        pcm.extend(tone(0.4, level / 300.0));
        pcm.extend(tone(1.0, level));
        pcm
    }

    fn pieces(chunker: &mut Chunker, pcm: &[f32]) -> Vec<Piece> {
        let mut out: Vec<Piece> = pcm.chunks(480).filter_map(|c| chunker.push(c)).collect();
        out.extend(chunker.finish());
        out
    }

    #[test]
    fn cuts_at_a_pause_at_any_loudness() {
        for level in [0.3, 0.003] {
            let pcm = speech_with_gap(level);
            let got = pieces(&mut Chunker::new(PARAMS), &pcm);
            assert_eq!(got.len(), 2, "level {level}");
            let cut = got[0].pcm.len();
            assert!((3 * RATE..3 * RATE + 7 * RATE / 20).contains(&cut), "cut at {cut}");
        }
    }

    #[test]
    fn no_audio_is_lost_and_context_is_only_ever_old_audio() {
        let pcm = speech_with_gap(0.2);
        let got = pieces(&mut Chunker::new(PARAMS), &pcm);
        assert_eq!(got.iter().map(|p| p.pcm.len() - p.context).sum::<usize>(), pcm.len());
        assert_eq!(got[0].context, 0);
        assert_eq!(got[1].context, RATE);
        let seam = got[0].pcm.len();
        assert_eq!(got[1].pcm[got[1].context..], pcm[seam..]);
        assert_eq!(got[1].pcm[..got[1].context], pcm[seam - RATE..seam]);
    }

    #[test]
    fn unbroken_speech_stops_at_the_limit() {
        let got = pieces(&mut Chunker::new(PARAMS), &tone(7.0, 0.2));
        assert!(got.len() >= 2);
        assert!(got.iter().all(|p| p.pcm.len() - p.context <= 6 * RATE + RATE / 2));
    }

    #[test]
    fn a_pause_before_release_leaves_nothing_to_decode() {
        let mut pcm = tone(3.0, 0.2);
        pcm.extend(tone(0.6, 0.2 / 300.0));
        let mut chunker = Chunker::new(PARAMS);
        let cut: Vec<Piece> = pcm.chunks(480).filter_map(|c| chunker.push(c)).collect();
        assert!(cut.len() == 1 && cut[0].at_pause);
        assert!(chunker.pending_is_quiet(&pcm));
        let more = tone(0.5, 0.2);
        pcm.extend_from_slice(&more);
        assert!(chunker.push(&more).is_none());
        assert!(!chunker.pending_is_quiet(&pcm));
    }

    #[test]
    fn a_soft_word_after_a_pause_is_still_decoded() {
        let mut pcm = tone(3.0, 0.2);
        pcm.extend(tone(0.6, 0.2 / 300.0));
        let mut chunker = Chunker::new(PARAMS);
        assert_eq!(pcm.chunks(480).filter_map(|c| chunker.push(c)).count(), 1);
        let soft = tone(0.15, 0.2 * 0.15);
        pcm.extend_from_slice(&soft);
        assert!(chunker.push(&soft).is_none());
        assert!(!chunker.pending_is_quiet(&pcm));
    }

    #[test]
    fn a_preview_looks_at_the_uncut_words_without_taking_them() {
        let mut chunker = Chunker::new(PARAMS);
        assert!(chunker.preview().is_none());
        let speech = tone(1.0, 0.2);
        assert!(chunker.push(&speech).is_none());
        let piece = chunker.preview().unwrap();
        assert_eq!((piece.pcm.len(), piece.context, piece.at_pause), (RATE, 0, false));
        assert_eq!(chunker.pending_len(), RATE);
        assert_eq!(chunker.finish().unwrap().pcm.len(), RATE);
    }

    #[test]
    fn previews_come_each_second_and_back_off_on_a_slow_machine() {
        assert!(!preview_due(RATE / 4, 0, 0));
        assert!(preview_due(RATE / 2, 0, 0));
        assert!(!preview_due(RATE, RATE / 2, 200));
        assert!(preview_due(RATE * 3 / 2, RATE / 2, 200));
        // A preview that took 1.5 s waits for 3 s more audio, so decoding never takes more than half the time.
        assert!(!preview_due(RATE * 3, RATE / 2, 1_500));
        assert!(preview_due(RATE * 7 / 2, RATE / 2, 1_500));
    }

    #[test]
    fn keeps_only_the_words_past_the_seam() {
        let words = [(100, "we"), (900, "should"), (1000, "go"), (1500, "home.")];
        assert_eq!(words_after(words.into_iter(), 1000), "go home.");
        assert_eq!(words_after(words.into_iter(), 0), "we should go home.");
    }

    #[test]
    fn gain_lifts_a_whisper_and_leaves_the_rest() {
        let mut quiet = tone(1.0, 0.001);
        let gain = lift_gain(&mut quiet);
        assert!(gain > 40.0);
        assert!(quiet.iter().cloned().fold(0.0, f32::max) > 0.05);
        let mut loud = tone(1.0, 0.5);
        assert_eq!(lift_gain(&mut loud), 1.0);
        let mut silent = vec![0.0; RATE];
        assert_eq!(lift_gain(&mut silent), 1.0);
    }
}
