//! Which microphone hears him. At a press his first mic records as always, and the others in his order record beside it
//! for the first seconds. When one of them hears speech while the first hears nothing at all (a receiver whose
//! transmitter is off: digital silence or a flat floor), the dictation moves to it with everything it heard so far, so
//! no word is lost. Speech decides, never level alone: a quiet room on a working mic never moves anything. Pure.

/// 30 ms at 16 kHz.
const FRAME: usize = 480;
/// Speech is this far over the mic's own floor (12 dB)…
const SPEECH_OVER_FLOOR: f32 = 4.0;
/// …and at least this loud (about -54 dBFS), so hiss on a dead input never counts.
const SPEECH_MIN: f32 = 0.002;
/// For this many frames in a row (150 ms): a click or a knock is not speech.
const SPEECH_FRAMES: usize = 5;
/// A live mic moves at least this much (6 dB) over its floor while he speaks, even far from him.
const ALIVE_OVER_FLOOR: f32 = 2.0;
/// Under 1 LSB of 16-bit audio.
const SILENCE: f32 = 2e-5;
/// The others record only until the first mic hears him or one takes over, and this long at most (then the first is kept),
/// so no other mic stays open through a dictation.
pub const PROBE_SAMPLES: usize = 16_000 * 4;

fn levels(pcm: &[f32]) -> Vec<f32> {
    pcm.chunks_exact(FRAME).map(|f| (f.iter().map(|s| s * s).sum::<f32>() / FRAME as f32).sqrt()).collect()
}

fn floor(levels: &[f32]) -> f32 {
    let mut sorted = levels.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    sorted.get(sorted.len() / 10).copied().unwrap_or(0.0).max(SILENCE)
}

/// He is speaking into this mic.
pub fn hears_speech(pcm: &[f32]) -> bool {
    let levels = levels(pcm);
    let gate = (floor(&levels) * SPEECH_OVER_FLOOR).max(SPEECH_MIN);
    levels.split(|l| *l < gate).any(|run| run.len() >= SPEECH_FRAMES)
}

/// Anything at all moves on this mic: not digital silence, not a flat floor.
fn alive(pcm: &[f32]) -> bool {
    let levels = levels(pcm);
    let loud = levels.iter().copied().fold(0.0, f32::max);
    loud > SILENCE && loud >= floor(&levels) * ALIVE_OVER_FLOOR
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// Nobody has spoken yet: keep listening on all of them.
    Wait,
    /// The first mic is the one: the others close. `preferred_heard`: the first of `others` heard him too.
    Keep { preferred_heard: bool },
    /// Move to `others[i]`.
    Switch(usize),
}

/// `first`: what the recording's mic heard so far; `others`: each probe's, in his order.
pub fn judge(first: &[f32], others: &[&[f32]]) -> Verdict {
    if hears_speech(first) {
        return Verdict::Keep { preferred_heard: others.first().is_some_and(|p| hears_speech(p)) };
    }
    let Some(heard) = others.iter().position(|p| hears_speech(p)) else {
        return Verdict::Wait;
    };
    // He is speaking: a first mic that moves at all is his (far, or turned down), so it stays.
    if alive(first) {
        Verdict::Keep { preferred_heard: heard == 0 }
    } else {
        Verdict::Switch(heard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A noise floor, then `speech_at`..`speech_end` seconds of a 200 Hz tone at `speech` amplitude.
    fn mic(floor: f32, speech: f32, speech_at: f32, speech_end: f32, seconds: f32) -> Vec<f32> {
        let n = (seconds * 16_000.0) as usize;
        (0..n)
            .map(|i| {
                let t = i as f32 / 16_000.0;
                let noise = ((i as f32 * 12.9898).sin() * 43_758.547).fract() * floor;
                let voice = if t >= speech_at && t < speech_end { (t * 200.0 * std::f32::consts::TAU).sin() * speech } else { 0.0 };
                noise + voice
            })
            .collect()
    }

    #[test]
    fn a_dead_first_mic_moves_to_the_first_one_that_hears_him() {
        // His case: the DJI receiver pinned with its transmitter off, the Scarlett live beside it.
        let dji_off = vec![0.0; 16_000];
        let webcam = mic(0.0005, 0.01, 0.3, 1.0, 1.0);
        let scarlett = mic(0.0003, 0.1, 0.3, 1.0, 1.0);
        assert_eq!(judge(&dji_off, &[&scarlett, &webcam]), Verdict::Switch(0));
        // A flat floor (a receiver that hisses) is as dead as silence.
        assert_eq!(judge(&mic(0.002, 0.0, 0.0, 0.0, 1.0), &[&scarlett]), Verdict::Switch(0));
        // In order: the Scarlett had nothing yet, the webcam heard him.
        assert_eq!(judge(&dji_off, &[&mic(0.0003, 0.0, 0.0, 0.0, 1.0), &webcam]), Verdict::Switch(1));
    }

    #[test]
    fn a_quiet_room_on_a_working_mic_moves_nothing() {
        let quiet = mic(0.0003, 0.0, 0.0, 0.0, 1.0);
        assert_eq!(judge(&quiet, &[&quiet.clone()]), Verdict::Wait);
        // Nobody spoke on any mic, even with the first one dead: wait, never guess.
        assert_eq!(judge(&vec![0.0; 16_000], &[&quiet]), Verdict::Wait);
        // A knock on the other mic is not speech.
        let knock = mic(0.0003, 0.3, 0.5, 0.56, 1.0);
        assert_eq!(judge(&vec![0.0; 16_000], &[&knock]), Verdict::Wait);
    }

    #[test]
    fn a_first_mic_that_hears_him_at_all_stays() {
        let scarlett = mic(0.0003, 0.1, 0.3, 1.0, 1.0);
        assert_eq!(judge(&scarlett, &[&vec![0.0; 16_000]]), Verdict::Keep { preferred_heard: false });
        // Far from him, turned down: under the speech gate, but it moves with his voice, so it is his choice and stays.
        let far = mic(0.0003, 0.0015, 0.3, 1.0, 1.0);
        let near = mic(0.0003, 0.1, 0.3, 1.0, 1.0);
        assert_eq!(judge(&far, &[&near]), Verdict::Keep { preferred_heard: true });
        // On the mic it moved to last time, the preferred one hearing him again says to go back to it next time.
        assert_eq!(judge(&near, &[&far.clone(), &near.clone()]), Verdict::Keep { preferred_heard: false });
        assert_eq!(judge(&near, &[&near.clone()]), Verdict::Keep { preferred_heard: true });
    }
}
