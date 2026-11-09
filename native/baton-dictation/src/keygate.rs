//! While dictation's ghost text plays in his field, a key he presses waits for the paste: Enter after the words, never
//! before them (the chat would send without them), and never lost or sent twice. Pure, so it is tested on any platform;
//! `keygate_windows.rs` feeds it from a low-level keyboard hook that exists only while the gate is up.
#![cfg_attr(not(windows), allow(dead_code))]

/// Shift, Ctrl, Alt and Windows, in both their generic and left/right codes: they pass, and are read for each key held.
pub const MODIFIERS: [u16; 11] = [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C];
/// Esc keeps its own meaning (it ends the cleanup), so it is never held.
const ESCAPE: u16 = 0x1B;

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Pass,
    Swallow,
    /// Swallowed, and the first key held: the paste should go now.
    First,
}

#[derive(Default)]
pub struct Gate {
    /// Each held press with the modifiers down when he pressed it, in order.
    held: Vec<(u16, Vec<u16>)>,
    /// Keys whose press was held: their release is held too, so the app never sees a release without its press.
    down: Vec<u16>,
}

impl Gate {
    /// One key event. `injected` ones (the paste, or a replay) always pass; so do modifiers, Esc, and the release of a
    /// key pressed before the gate went up.
    pub fn key(&mut self, vk: u16, up: bool, injected: bool, modifiers: &[u16]) -> Verdict {
        if injected || vk == ESCAPE || MODIFIERS.contains(&vk) {
            return Verdict::Pass;
        }
        if up {
            return if self.down.contains(&vk) { Verdict::Swallow } else { Verdict::Pass };
        }
        let first = self.held.is_empty();
        self.held.push((vk, modifiers.to_vec()));
        if !self.down.contains(&vk) {
            self.down.push(vk);
        }
        if first {
            Verdict::First
        } else {
            Verdict::Swallow
        }
    }

    /// The paste has landed: each held key as (code, up) events, in order, wrapped in the modifiers he held for it that
    /// are not down now. A key still physically down is replayed as a press only; its own release follows from him.
    pub fn release(&mut self, now_down: &[u16]) -> Vec<(u16, bool)> {
        let mut out = Vec::new();
        for (vk, modifiers) in self.held.drain(..) {
            let missing: Vec<u16> = modifiers.into_iter().filter(|m| !now_down.contains(m)).collect();
            out.extend(missing.iter().map(|&m| (m, false)));
            out.push((vk, false));
            if !now_down.contains(&vk) {
                out.push((vk, true));
            }
            out.extend(missing.iter().rev().map(|&m| (m, true)));
        }
        self.down.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTER: u16 = 0x0D;
    const SHIFT: u16 = 0xA0;
    const A: u16 = 0x41;

    #[test]
    fn enter_waits_for_the_paste_then_goes_once() {
        let mut gate = Gate::default();
        assert_eq!(gate.key(ENTER, false, false, &[]), Verdict::First);
        assert_eq!(gate.key(ENTER, true, false, &[]), Verdict::Swallow);
        // The paste chord is injected: it passes while Enter waits.
        assert_eq!(gate.key(0xA2, false, true, &[]), Verdict::Pass);
        assert_eq!(gate.key(0x56, false, true, &[0xA2]), Verdict::Pass);
        assert_eq!(gate.release(&[]), vec![(ENTER, false), (ENTER, true)]);
        assert_eq!(gate.release(&[]), vec![]);
    }

    #[test]
    fn shift_enter_stays_a_new_line_after_shift_is_let_go() {
        let mut gate = Gate::default();
        assert_eq!(gate.key(SHIFT, false, false, &[]), Verdict::Pass);
        assert_eq!(gate.key(ENTER, false, false, &[SHIFT]), Verdict::First);
        assert_eq!(gate.key(ENTER, true, false, &[SHIFT]), Verdict::Swallow);
        assert_eq!(gate.key(SHIFT, true, false, &[]), Verdict::Pass);
        assert_eq!(gate.release(&[]), vec![(SHIFT, false), (ENTER, false), (ENTER, true), (SHIFT, true)]);
        // Shift still held: no extra Shift is pressed or let go.
        gate.key(ENTER, false, false, &[SHIFT]);
        assert_eq!(gate.release(&[SHIFT]), vec![(ENTER, false), (ENTER, true)]);
    }

    #[test]
    fn keys_keep_their_order_and_esc_and_earlier_presses_pass() {
        let mut gate = Gate::default();
        assert_eq!(gate.key(ESCAPE, false, false, &[]), Verdict::Pass);
        assert_eq!(gate.key(A, true, false, &[]), Verdict::Pass);
        assert_eq!(gate.key(A, false, false, &[]), Verdict::First);
        assert_eq!(gate.key(ENTER, false, false, &[]), Verdict::Swallow);
        // Enter still held down at the release: its press goes, and his own release follows.
        assert_eq!(gate.release(&[ENTER]), vec![(A, false), (A, true), (ENTER, false)]);
        assert_eq!(gate.key(ENTER, true, false, &[]), Verdict::Pass);
    }
}
