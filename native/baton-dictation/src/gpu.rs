//! Recognition on his graphics card (Vulkan), when the build has it (`--features gpu`, Windows) and a capable card is
//! present: read and warmed on a low-priority thread, so a key press never waits for it; until it is warm, and after any
//! error on it, the CPU recognises as before. The Vulkan backend is a module loaded at run time, so a PC without a
//! Vulkan driver only ever sees the CPU.
use std::path::Path;
use std::time::Instant;

use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, Session, SessionOptions, TimestampKind};

/// His setting "Use graphics card for recognition".
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// A discrete card with room for the model.
    #[default]
    Auto,
    /// Any Vulkan device that loads it, an integrated one too.
    On,
    Off,
}

/// Free memory a card needs for the model and its working buffers: 1.1 GB measured on his MX150. A 2 GB card with his
/// apps open has about 1.4 GB free, so 1.5 GB turned it away; a load that still runs short falls back to the CPU.
const MIN_FREE: u64 = 1100 << 20;

/// The backends this process registers, fixed at its start (`--gpu`): with his setting Off, or a build without the card's
/// module, the Vulkan code never runs, so a broken driver cannot touch dictation. A change takes effect at the
/// sidecar's next start, which the desktop makes at once.
pub fn mask(mode: Mode) -> transcribe_cpp::BackendMask {
    if cfg!(feature = "gpu") && mode != Mode::Off {
        transcribe_cpp::BackendMask::ALL
    } else {
        transcribe_cpp::BackendMask::CPU
    }
}

impl std::str::FromStr for Mode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        serde_json::from_value(serde_json::Value::String(s.to_string())).map_err(|_| format!("--gpu {s}: auto, on or off"))
    }
}

/// One device as the choice sees it.
pub struct Card {
    pub vulkan: bool,
    pub discrete: bool,
    pub free: u64,
}

/// The card to use: in Auto a discrete one with `MIN_FREE`, in On any Vulkan one; a discrete card first, then the most
/// free memory.
pub fn choose(cards: &[Card], mode: Mode) -> Option<usize> {
    cards
        .iter()
        .enumerate()
        .filter(|(_, c)| c.vulkan && (mode == Mode::On || (mode == Mode::Auto && c.discrete && c.free >= MIN_FREE)))
        .max_by_key(|(_, c)| (c.discrete, c.free))
        .map(|(i, _)| i)
}

/// The CPU's own session: asked for by name, since in a GPU build the default would pick the card.
pub fn cpu_model(model: &Path) -> transcribe_cpp::Result<Model> {
    Model::load_with(model, &ModelOptions { backend: Backend::Cpu, ..Default::default() })
}

/// The model on his card, warmed: its shaders are compiled by decoding a short and a dictation-length clip with word
/// times, as a dictation does (his first dictation otherwise took 15 s on the MX150). Err: the CPU keeps recognising.
pub fn load(model: &Path, mode: Mode) -> Result<(Session, String), String> {
    let devices = transcribe_cpp::devices();
    let cards: Vec<Card> = devices
        .iter()
        .map(|d| Card {
            vulkan: d.kind == "vulkan",
            discrete: d.device_type == transcribe_cpp::DeviceType::Gpu,
            free: d.memory_free,
        })
        .collect();
    let device = choose(&cards, mode).map(|i| devices[i].clone()).ok_or("no graphics card with room for the model")?;
    let name = device.description.clone();
    let started = Instant::now();
    let options = ModelOptions { backend: Backend::Vulkan, device: Some(device), ..Default::default() };
    let mut session = Model::load_with(model, &options)
        // The library's default is every core, spinning beside his work; the CPU path's count did 6x better under load.
        .and_then(|m| m.session_with(&SessionOptions { n_threads: crate::default_threads(crate::usable_cores()), ..Default::default() }))
        .map_err(|e| format!("{name}: {e}"))?;
    for seconds in [1, 9] {
        nudge(&mut session, seconds).map_err(|e| format!("{name} warm-up: {e}"))?;
    }
    Ok((session, format!("{name} in {} ms", started.elapsed().as_millis())))
}

/// Unused this long, the card has clocked down and may have moved the model out of its memory: his first dictation after
/// an hour took 1,046 ms to decode 445 ms of audio (0.1.98). A press after this long nudges it while he speaks.
pub const IDLE: std::time::Duration = std::time::Duration::from_secs(60);

/// One decode of `seconds` of quiet noise, as a dictation's (word times on). Not silence: a silent clip can end before
/// the decoder's shaders are reached.
pub fn nudge(session: &mut Session, seconds: usize) -> transcribe_cpp::Result<()> {
    let noise: Vec<f32> =
        (0..seconds * 16_000).map(|i| ((i as f32 * 12.9898).sin() * 43_758.547).fract() * 0.01).collect();
    session.run(&noise, &RunOptions { timestamps: TimestampKind::Word, ..Default::default() }).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_takes_a_discrete_card_with_room_and_on_takes_any() {
        let card = |vulkan, discrete, gb: f64| Card { vulkan, discrete, free: (gb * (1u64 << 30) as f64) as u64 };
        // His laptop: the CPU, the Intel graphics (shared memory) and the MX150.
        let his = [card(false, false, 6.0), card(true, false, 8.0), card(true, true, 1.6)];
        assert_eq!(choose(&his, Mode::Auto), Some(2));
        assert_eq!(choose(&his, Mode::On), Some(2));
        assert_eq!(choose(&his[..2], Mode::On), Some(1));
        assert_eq!(choose(&his, Mode::Off), None);
        // His MX150 with his apps open (1.4 GB free) is taken; too little free memory is left to the CPU in Auto.
        assert_eq!(choose(&[card(true, true, 1.4)], Mode::Auto), Some(0));
        assert_eq!(choose(&[card(true, true, 1.0)], Mode::Auto), None);
        assert_eq!(choose(&[card(true, true, 1.0)], Mode::On), Some(0));
        // No Vulkan at all: the CPU.
        assert_eq!(choose(&[card(false, false, 16.0)], Mode::On), None);
    }
}
