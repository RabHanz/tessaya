//! While dictation's ghost text plays in his field, the typing keys he presses wait for its paste: Enter after the
//! words, never before them (the chat would send without them), and never sent twice. Pure, so it is tested on any
//! platform; `keygate_windows.rs` feeds it from a low-level keyboard hook that exists only while a hold is up.
//!
//! The rules: only plain typing keys, Enter and Tab are held, and only while the window the dictation targets is in
//! front. Ctrl, Alt or Win down: everything passes, so shortcuts are never touched. Another window in front: the held
//! keys are dropped and the hold ends. After `CAP_MS` everything passes. A hold is owned by one dictation's id.
#![cfg_attr(not(windows), allow(dead_code))]

/// The hold never lasts longer than this, in ms; then everything passes and the held keys are sent.
pub const CAP_MS: u64 = 3_000;
const SHIFTS: [u16; 3] = [0x10, 0xA0, 0xA1];
const SHIFT: u16 = 0xA0;

/// The modifiers down as a key arrives.
#[derive(Clone, Copy, Default)]
pub struct Mods {
    pub shift: bool,
    /// Ctrl, Alt or Win.
    pub command: bool,
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Pass,
    Hold,
    /// Held, and the first: the paste should go now.
    First,
    /// Another window came to the front: the held keys are gone, this key passes, and the hold is over.
    Lost,
}

/// Letters, digits, space, the punctuation keys, the number pad, Enter and Tab.
fn holdable(vk: u16) -> bool {
    matches!(vk, 0x09 | 0x0D | 0x20 | 0x30..=0x39 | 0x41..=0x5A | 0x60..=0x6F | 0xBA..=0xC0 | 0xDB..=0xDF | 0xE2)
}

pub struct Gate {
    pub owner: u64,
    target: isize,
    held: Vec<(u16, bool)>,
    /// Keys whose press was held: their release is held too, so the app never sees a release without its press.
    down: Vec<u16>,
}

impl Gate {
    pub fn new(owner: u64, target: isize) -> Self {
        Self { owner, target, held: Vec::new(), down: Vec::new() }
    }

    /// One key event, `elapsed` ms after the hold began, with `front` the window in front now.
    pub fn key(&mut self, vk: u16, up: bool, injected: bool, mods: Mods, front: isize, elapsed: u64) -> Verdict {
        if injected || elapsed >= CAP_MS || SHIFTS.contains(&vk) {
            return Verdict::Pass;
        }
        if front != self.target {
            self.held.clear();
            self.down.clear();
            return Verdict::Lost;
        }
        if up {
            return if self.down.contains(&vk) { Verdict::Hold } else { Verdict::Pass };
        }
        if mods.command || !holdable(vk) {
            return Verdict::Pass;
        }
        let first = self.held.is_empty();
        self.held.push((vk, mods.shift));
        if !self.down.contains(&vk) {
            self.down.push(vk);
        }
        if first {
            Verdict::First
        } else {
            Verdict::Hold
        }
    }

    /// Ends the hold for `owner` only: each held key as (code, up) events, in order, with Shift around it when he
    /// held Shift for it and it is not down now. Another dictation's id gets nothing and the hold stays.
    pub fn release(&mut self, owner: u64, shift_down: bool) -> Option<Vec<(u16, bool)>> {
        if owner != self.owner {
            return None;
        }
        let mut out = Vec::new();
        for (vk, shift) in self.held.drain(..) {
            let wrap = shift && !shift_down;
            if wrap {
                out.push((SHIFT, false));
            }
            out.extend([(vk, false), (vk, true)]);
            if wrap {
                out.push((SHIFT, true));
            }
        }
        self.down.clear();
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTER: u16 = 0x0D;
    const A: u16 = 0x41;
    const FIELD: isize = 7;
    const PLAIN: Mods = Mods { shift: false, command: false };

    #[test]
    fn enter_waits_for_the_paste_then_goes_once() {
        let mut gate = Gate::new(1, FIELD);
        assert_eq!(gate.key(ENTER, false, false, PLAIN, FIELD, 10), Verdict::First);
        assert_eq!(gate.key(ENTER, true, false, PLAIN, FIELD, 20), Verdict::Hold);
        // The paste chord is injected: it passes while Enter waits.
        assert_eq!(gate.key(0x56, false, true, Mods { shift: false, command: true }, FIELD, 30), Verdict::Pass);
        assert_eq!(gate.release(1, false), Some(vec![(ENTER, false), (ENTER, true)]));
        assert_eq!(gate.release(1, false), Some(vec![]));
    }

    #[test]
    fn shift_enter_stays_a_new_line_after_shift_is_let_go() {
        let mut gate = Gate::new(1, FIELD);
        let shift = Mods { shift: true, command: false };
        assert_eq!(gate.key(0xA0, false, false, PLAIN, FIELD, 0), Verdict::Pass);
        assert_eq!(gate.key(ENTER, false, false, shift, FIELD, 5), Verdict::First);
        assert_eq!(gate.key(0xA0, true, false, PLAIN, FIELD, 9), Verdict::Pass);
        assert_eq!(gate.release(1, false), Some(vec![(SHIFT, false), (ENTER, false), (ENTER, true), (SHIFT, true)]));
    }

    #[test]
    fn ctrl_alt_and_win_shortcuts_always_pass() {
        let mut gate = Gate::new(1, FIELD);
        let command = Mods { shift: false, command: true };
        for vk in [0xA2, 0xA4, 0x5B] {
            assert_eq!(gate.key(vk, false, false, PLAIN, FIELD, 0), Verdict::Pass);
        }
        assert_eq!(gate.key(ENTER, false, false, command, FIELD, 0), Verdict::Pass);
        assert_eq!(gate.key(A, false, false, command, FIELD, 0), Verdict::Pass);
        assert_eq!(gate.key(ENTER, true, false, PLAIN, FIELD, 0), Verdict::Pass);
        // Esc, the arrows and Backspace are not typing: they pass too.
        for vk in [0x1B, 0x25, 0x08] {
            assert_eq!(gate.key(vk, false, false, PLAIN, FIELD, 0), Verdict::Pass);
        }
        assert_eq!(gate.release(1, false), Some(vec![]));
    }

    #[test]
    fn another_window_in_front_drops_the_held_keys() {
        let mut gate = Gate::new(1, FIELD);
        assert_eq!(gate.key(A, false, false, PLAIN, FIELD, 0), Verdict::First);
        assert_eq!(gate.key(ENTER, false, false, PLAIN, 99, 50), Verdict::Lost);
        assert_eq!(gate.release(1, false), Some(vec![]));
    }

    #[test]
    fn only_its_own_dictation_releases_a_hold() {
        let mut gate = Gate::new(2, FIELD);
        gate.key(ENTER, false, false, PLAIN, FIELD, 0);
        assert_eq!(gate.release(1, false), None);
        assert_eq!(gate.release(2, false), Some(vec![(ENTER, false), (ENTER, true)]));
    }

    #[test]
    fn after_three_seconds_everything_passes() {
        let mut gate = Gate::new(1, FIELD);
        assert_eq!(gate.key(A, false, false, PLAIN, FIELD, CAP_MS - 1), Verdict::First);
        assert_eq!(gate.key(ENTER, false, false, PLAIN, FIELD, CAP_MS), Verdict::Pass);
        assert_eq!(gate.key(ENTER, false, false, PLAIN, 99, CAP_MS + 1), Verdict::Pass);
        assert_eq!(gate.release(1, false), Some(vec![(A, false), (A, true)]));
    }
}
