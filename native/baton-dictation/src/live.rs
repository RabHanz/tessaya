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
/// A frame this many times its recording's noise floor (12 dB) is speech; his release tails (a breath, the key) peaked
/// at 4 to 12 dB over it.
const SPEECH_OVER_FLOOR: f32 = 3.98;
/// For this many frames in a row (60 ms): a click is shorter.
const SPEECH_RUN: usize = 3;
/// How uneven the quiet after a pause preview may be for the release to take the preview's words (`quiet_after`).
pub const REUSE_FLAT: f32 = 4.0;
/// Quiet this long after speech is a pause worth the final decode (`Chunker::paused_since`): he stops a few hundred ms
/// before he lets go, so 200 ms starts it early enough to be done at release; a breath between words is shorter.
const PAUSE_PREVIEW: usize = RATE / 5;

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

    /// Nothing but quiet in the uncut audio from `from` on, against the whole recording's floor and speech: a preview
    /// of it would only decode silence.
    pub fn quiet_since(&self, from: usize, heard: &[f32]) -> bool {
        let levels = frame_levels(heard);
        let (floor, loud) = (percentile(&levels, 0.1), percentile(&levels, 0.9));
        if loud < floor * 2.0 {
            return loud < SILENCE;
        }
        let quiet = floor + (loud - floor) * 0.1;
        frame_levels(&self.pending[from.min(self.pending.len())..]).iter().all(|l| *l <= quiet)
    }

    /// What is left at key release.
    /// The first `samples` of the uncut audio are already written (a preview's words that ended well before it did):
    /// they become context only, so `finish` leaves just what follows them to decode.
    pub fn skip(&mut self, samples: usize) {
        let at = samples.min(self.pending.len());
        if at > 0 {
            self.cut(at, false);
        }
    }

    pub fn finish(&mut self) -> Option<Piece> {
        if self.pending.is_empty() {
            return None;
        }
        let at = self.pending.len();
        Some(self.cut(at, false))
    }

    /// Nothing but quiet since the last cut: short, below the recording's speech, and flat in its own levels, so a
    /// soft word after a pause is still heard. The words before it are decoded, so release has nothing to wait for.
    /// Speech anywhere in the uncut audio from `from` on: `SPEECH_RUN` frames in a row `SPEECH_OVER_FLOOR` above the
    /// recording's own noise floor (its quietest tenth; his is about -67 dBFS). Relative to the floor, not to his
    /// speech, so a soft last sentence after loud ones still counts. A release takes a preview's words only without it.
    pub fn speech_after(&self, from: usize, heard: &[f32]) -> bool {
        let floor = percentile(&frame_levels(heard), 0.1).max(SILENCE);
        let over = floor * SPEECH_OVER_FLOOR;
        let mut run = 0;
        frame_levels(&self.pending[from.min(self.pending.len())..]).iter().any(|level| {
            run = if *level > over { run + 1 } else { 0 };
            run >= SPEECH_RUN
        })
    }

    /// Capped at `QUIET_TAIL_MAX`: a longer tail may be a quiet last sentence, and is decoded.
    pub fn pending_is_quiet(&self, heard: &[f32], flat: f32) -> bool {
        self.pending.len() <= QUIET_TAIL_MAX && self.quiet_after(0, heard, flat)
    }

    /// He has just stopped: the last `PAUSE_PREVIEW` of the uncut audio is quiet and he spoke since `from` (where the
    /// last preview reached). A preview now likely holds all he said, so a release soon after has nothing to decode.
    pub fn paused_since(&self, from: usize, heard: &[f32]) -> bool {
        let len = self.pending.len();
        len >= from + PAUSE_PREVIEW && self.quiet_since(len - PAUSE_PREVIEW, heard) && !self.quiet_since(from, heard)
    }

    /// The uncut audio from `from` on is quiet by `pending_is_quiet`'s rule: below his speech, and its loudest frame
    /// under `flat` times its own floor, so a soft word stands out. The words a preview read up to `from` are then all
    /// of it. His release tails (a breath, the key) measured 2.3 to 4.8 times their floor; a word is far more.
    pub fn quiet_after(&self, from: usize, heard: &[f32], flat: f32) -> bool {
        let tail = &self.pending[from.min(self.pending.len())..];
        if tail.len() < FRAME {
            return true;
        }
        let levels = frame_levels(heard);
        let (floor, loud) = (percentile(&levels, 0.1), percentile(&levels, 0.9));
        if loud < floor * 2.0 {
            return false;
        }
        let quiet = floor + (loud - floor) * 0.1;
        let own = frame_levels(tail);
        let (own_floor, own_loud) = (percentile(&own, 0.1), percentile(&own, 1.0));
        own.iter().all(|l| *l <= quiet) && own_loud <= own_floor * flat + SILENCE
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

/// One-dot abbreviations whose dot is part of the word, never a sentence's end.
const ABBREVIATIONS: &[&str] = &["etc", "vs", "mr", "mrs", "ms", "dr", "st", "inc", "ltd", "jr", "sr", "approx"];

/// The pieces' words as one text. Each piece is decoded alone, so the model ends it with a full stop even where he did
/// not stop: a stop before a piece that starts in lower case was a cut mid-sentence (the model capitalises a real
/// sentence start), and is dropped. An abbreviation's own dot ("e.g.", "U.S.") stays, and so does a stop before a
/// brand that starts in lower case ("iPhone", "eBay").
pub fn join_pieces<S: AsRef<str>>(pieces: &[S]) -> String {
    let mut out = String::new();
    for piece in pieces.iter().map(|p| p.as_ref().trim()).filter(|p| !p.is_empty()) {
        if !out.is_empty() {
            let first = piece.split_whitespace().next().unwrap_or("");
            let lower =
                first.chars().next().is_some_and(|c| c.is_lowercase()) && !first.chars().any(|c| c.is_uppercase());
            let last = out.rsplit(char::is_whitespace).next().unwrap_or("");
            let abbreviation = last.strip_suffix('.').is_some_and(|w| {
                w.contains('.')
                    || ABBREVIATIONS
                        .contains(&w.trim_start_matches(|c: char| !c.is_alphanumeric()).to_lowercase().as_str())
            });
            if lower && out.ends_with('.') && !abbreviation {
                out.pop();
            }
            out.push(' ');
        }
        out.push_str(piece);
    }
    out
}

/// Samples per `pcm` line the recording sends the desktop for the pill's waveform: 40 ms.
pub const METER_SAMPLES: usize = RATE / 25;

/// The microphone's samples as 16-bit little-endian PCM in base64, the waveform's input when no other mic reader runs.
pub fn meter_b64(pcm: &[f32]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = pcm.iter().flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
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
        assert!(chunker.pending_is_quiet(&pcm, 2.0));
        // A quiet tail past QUIET_TAIL_MAX is decoded all the same: it may be a quiet last sentence.
        let mut long = Chunker::new(PARAMS);
        let mut heard = tone(3.0, 0.2);
        heard.extend(tone(1.5, 0.2 / 300.0));
        heard.chunks(480).for_each(|c| drop(long.push(c)));
        assert!(long.pending_len() > QUIET_TAIL_MAX && long.quiet_after(0, &heard, REUSE_FLAT));
        assert!(!long.pending_is_quiet(&heard, REUSE_FLAT));
        let more = tone(0.5, 0.2);
        pcm.extend_from_slice(&more);
        assert!(chunker.push(&more).is_none());
        assert!(!chunker.pending_is_quiet(&pcm, 2.0));
    }

    #[test]
    fn a_fifth_of_a_second_of_quiet_is_his_pause() {
        // He stops a few hundred ms before he lets go: the final decode starts 200 ms into the quiet, not 300.
        let mut chunker = Chunker::new(ChunkParams { min_samples: 6 * RATE, ..PARAMS });
        // A recording opens on the room before he speaks: its floor.
        let mut heard = tone(0.3, 0.2 / 300.0);
        heard.extend_from_slice(&tone(2.0, 0.2));
        chunker.push(&heard);
        let hush = tone(0.22, 0.2 / 300.0);
        heard.extend_from_slice(&hush);
        chunker.push(&hush);
        assert!(chunker.paused_since(0, &heard));
        // A breath of 120 ms between words is not.
        let mut talk = Chunker::new(ChunkParams { min_samples: 6 * RATE, ..PARAMS });
        let mut said = tone(0.3, 0.2 / 300.0);
        said.extend_from_slice(&tone(2.0, 0.2));
        said.extend_from_slice(&tone(0.12, 0.2 / 300.0));
        talk.push(&said);
        assert!(!talk.paused_since(0, &said));
    }

    #[test]
    fn a_preview_taken_at_his_pause_is_all_a_release_needs() {
        // A short dictation, under the first cut: all of it is still uncut at release.
        let mut chunker = Chunker::new(ChunkParams { min_samples: 6 * RATE, ..PARAMS });
        let mut heard = tone(2.0, 0.2);
        chunker.push(&heard);
        // Still talking: no pause yet.
        assert!(!chunker.paused_since(0, &heard));
        let hush = tone(0.4, 0.2 / 300.0);
        heard.extend_from_slice(&hush);
        chunker.push(&hush);
        assert!(chunker.paused_since(0, &heard));
        // A preview here reaches the end; quiet after it, the release takes its words without decoding.
        let reached = chunker.pending_len();
        assert!(!chunker.paused_since(reached, &heard));
        let more_hush = tone(0.5, 0.2 / 300.0);
        heard.extend_from_slice(&more_hush);
        chunker.push(&more_hush);
        assert!(chunker.quiet_after(reached, &heard, REUSE_FLAT));
        // A soft word after it is not quiet: the release decodes.
        let soft = tone(0.15, 0.2 * 0.15);
        heard.extend_from_slice(&soft);
        chunker.push(&soft);
        assert!(!chunker.quiet_after(reached, &heard, REUSE_FLAT));
    }

    /// Deterministic noise at an RMS level, for a room's floor.
    fn noise(seconds: f32, rms: f32) -> Vec<f32> {
        let mut seed = 7u32;
        (0..(seconds * RATE as f32) as usize)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                ((seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * rms * 1.732
            })
            .collect()
    }

    fn db(level: f32) -> f32 {
        10f32.powf(level / 20.0)
    }

    #[test]
    fn a_soft_last_sentence_after_loud_speech_is_speech_but_his_breath_is_not() {
        let mix = |a: Vec<f32>, b: &[f32]| a.iter().zip(b).map(|(x, y)| x + y).collect::<Vec<f32>>();
        // Loud speech at -20 dBFS, a pause, then a soft sentence at -50 dBFS, all over his -67 dBFS room.
        let loud = mix(tone(3.0, db(-20.0) * 1.414), &noise(3.0, db(-67.0)));
        let pause = noise(0.6, db(-67.0));
        let soft = mix(tone(1.5, db(-50.0) * 1.414), &noise(1.5, db(-67.0)));
        let mut chunker = Chunker::new(ChunkParams { min_samples: 30 * RATE, ..PARAMS });
        let mut heard = loud.clone();
        heard.extend_from_slice(&pause);
        chunker.push(&heard);
        let previewed = chunker.pending_len();
        heard.extend_from_slice(&soft);
        chunker.push(&soft);
        assert!(chunker.speech_after(previewed, &heard), "the soft sentence must be decoded");
        // His release tail: the room, and a breath 9 dB over it for 200 ms. Nothing to decode.
        let mut quiet = Chunker::new(ChunkParams { min_samples: 30 * RATE, ..PARAMS });
        let mut tail = noise(1.0, db(-67.0));
        tail.extend(noise(0.2, db(-58.0)));
        tail.extend(noise(0.8, db(-67.0)));
        let mut heard = loud;
        heard.extend_from_slice(&pause);
        quiet.push(&heard);
        let previewed = quiet.pending_len();
        heard.extend_from_slice(&tail);
        quiet.push(&tail);
        assert!(!quiet.speech_after(previewed, &heard));
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
        assert!(!chunker.pending_is_quiet(&pcm, 2.0));
    }

    #[test]
    fn a_stop_the_cut_put_mid_sentence_is_dropped() {
        assert_eq!(
            join_pieces(&["It is not very smooth.", "of the words appearing.", "", "Because the cursor stays."]),
            "It is not very smooth of the words appearing. Because the cursor stays."
        );
        assert_eq!(join_pieces(&["Is it?", "yes.", "Wait...", "then go"]), "Is it? yes. Wait... then go");
        // An abbreviation keeps its dot; a brand in lower case is not a cut mid-sentence.
        assert_eq!(join_pieces(&["Fruit, e.g.", "apples"]), "Fruit, e.g. apples");
        assert_eq!(join_pieces(&["Pens, paper etc.", "and so on"]), "Pens, paper etc. and so on");
        assert_eq!(join_pieces(&["Made in the U.S.", "by hand"]), "Made in the U.S. by hand");
        assert_eq!(join_pieces(&["I bought one.", "iPhone for her"]), "I bought one. iPhone for her");
        assert_eq!(join_pieces(&["Sold it.", "eBay took a cut"]), "Sold it. eBay took a cut");
    }

    #[test]
    fn the_meter_is_little_endian_pcm_in_base64() {
        // 0x0000, 0x7fff, 0x8001 -> bytes 00 00 ff 7f 01 80
        assert_eq!(meter_b64(&[0.0, 1.0, -1.0]), "AAD/fwGA");
        assert_eq!(meter_b64(&[1.0]), "/38=");
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
    fn a_release_after_a_preview_decodes_only_what_follows_its_safe_words() {
        let mut chunker = Chunker::new(ChunkParams { min_samples: 6 * RATE, max_samples: 15 * RATE, context_samples: 3 * RATE });
        let heard: Vec<f32> = (0..5 * RATE).map(|i| (i as f32 * 0.01).sin() * 0.1).collect();
        assert!(chunker.push(&heard).is_none());
        // A preview's words were safe up to 4 s; release decodes the last second, with 3 s before it as context.
        chunker.skip(4 * RATE);
        let piece = chunker.finish().unwrap();
        assert_eq!(piece.context, 3 * RATE);
        assert_eq!(piece.pcm.len(), 4 * RATE);
        assert_eq!(&piece.pcm[piece.context..], &heard[4 * RATE..]);
        // Nothing safe: the whole uncut audio is decoded, as before.
        let mut whole = Chunker::new(ChunkParams { min_samples: 6 * RATE, max_samples: 15 * RATE, context_samples: 3 * RATE });
        whole.push(&heard);
        whole.skip(0);
        assert_eq!(whole.finish().unwrap().pcm.len(), 5 * RATE);
    }

    #[test]
    fn a_preview_of_silence_is_skipped() {
        let mut heard = tone(1.0, 0.2);
        let mut chunker = Chunker::new(PARAMS);
        chunker.push(&heard);
        assert!(!chunker.quiet_since(0, &heard));
        let hush = tone(0.6, 0.2 / 300.0);
        heard.extend_from_slice(&hush);
        chunker.push(&hush);
        assert!(chunker.quiet_since(RATE, &heard));
        let zeros = tone(1.0, 0.0);
        let mut silent = Chunker::new(PARAMS);
        silent.push(&zeros);
        assert!(silent.quiet_since(0, &zeros));
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
