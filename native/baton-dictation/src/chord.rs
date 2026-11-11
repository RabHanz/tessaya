//! A hold key of modifiers alone (Alt+Win, Ctrl+Shift+Win), read without blocking anything: blocking the key that
//! completes it would eat Windows' own Win+Alt+R or Win+Ctrl+Shift+B. Pure, so it is tested on any platform; on Windows
//! `chord_windows.rs` feeds it raw key events from its own low-level hook.
//!
//! It holds only while exactly the wanted modifiers are down and no other key. A key joining it cancels it, and that key
//! goes on to Windows untouched. A key pressed under any modifier (Alt+Tab, Win+Alt+R) taints the modifiers held then,
//! so the chord cannot start until every modifier has been let go. Injected events (our own paste chord, the menu mask)
//! are never fed in: a paste while he holds Win must not start or end a dictation.
use std::collections::HashSet;

use handy_keys::Modifiers;

#[derive(Debug, PartialEq)]
pub enum ChordOut {
    Down,
    Up,
    /// Another key joined while it held: the dictation it started is dropped.
    Cancel,
}

#[derive(Clone, Copy, Debug)]
pub enum Ev {
    /// One side's modifier (`Modifiers::OPT_LEFT`…), down or up.
    Mod(Modifiers, bool),
    /// Any other key by its code, down or up.
    Key(u32, bool),
}

pub struct Chord {
    want: Modifiers,
    down: Modifiers,
    /// Other keys down now: the chord never starts over one.
    keys: HashSet<u32>,
    active: bool,
    spoiled: bool,
    /// A key went down under the modifiers held now: they are a shortcut, not the chord, until all are let go.
    tainted: bool,
}

/// Each one-side modifier, for `stale`.
const SIDES: [Modifiers; 8] = [
    Modifiers::CMD_LEFT,
    Modifiers::CMD_RIGHT,
    Modifiers::SHIFT_LEFT,
    Modifiers::SHIFT_RIGHT,
    Modifiers::CTRL_LEFT,
    Modifiers::CTRL_RIGHT,
    Modifiers::OPT_LEFT,
    Modifiers::OPT_RIGHT,
];

impl Chord {
    pub fn new(want: Modifiers) -> Self {
        Self { want, down: Modifiers::empty(), keys: HashSet::new(), active: false, spoiled: false, tainted: false }
    }

    pub fn step(&mut self, ev: Ev) -> Option<ChordOut> {
        match ev {
            Ev::Key(code, false) => {
                self.keys.remove(&code);
                None
            }
            Ev::Key(code, true) => {
                self.keys.insert(code);
                if !self.down.is_empty() {
                    self.tainted = true;
                }
                if self.active && !self.spoiled {
                    self.spoiled = true;
                    return Some(ChordOut::Cancel);
                }
                None
            }
            Ev::Mod(side, pressed) => {
                if pressed {
                    self.down |= side;
                } else {
                    self.down &= !side;
                }
                // A key-up missed while every modifier was up cannot block the chord for good.
                if self.down.is_empty() {
                    self.keys.clear();
                    self.tainted = false;
                }
                let now = self.want.matches(self.down);
                if now && !self.active && self.keys.is_empty() && !self.tainted {
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
    }

    /// A modifier we hold as down that the keyboard says is up lost its key-up (a lock screen, a secure desktop): it is let
    /// go now, so a later Alt alone never reads as Alt+Win. `except` is the key being handled, whose state the keyboard has
    /// not caught up with yet.
    pub fn stale(&mut self, is_down: impl Fn(Modifiers) -> bool, except: Option<Modifiers>) -> Option<ChordOut> {
        let mut out = None;
        for side in SIDES {
            if self.down.contains(side) && Some(side) != except && !is_down(side) {
                out = self.step(Ev::Mod(side, false)).or(out);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use handy_keys::Hotkey;

    const ALT: Modifiers = Modifiers::OPT_LEFT;
    const ALT_R: Modifiers = Modifiers::OPT_RIGHT;
    const WIN: Modifiers = Modifiers::CMD_LEFT;
    const CTRL: Modifiers = Modifiers::CTRL_LEFT;
    const SHIFT: Modifiers = Modifiers::SHIFT_LEFT;
    const TAB: u32 = 0x09;
    const R: u32 = 0x52;

    fn chord(text: &str) -> Chord {
        Chord::new(text.parse::<Hotkey>().unwrap().modifiers)
    }
    fn down(m: Modifiers) -> Ev {
        Ev::Mod(m, true)
    }
    fn up(m: Modifiers) -> Ev {
        Ev::Mod(m, false)
    }

    #[test]
    fn alt_win_holds_in_either_order_and_with_either_alt() {
        for (first, second) in [(ALT, WIN), (WIN, ALT), (ALT_R, WIN), (WIN, ALT_R)] {
            let mut c = chord("Alt+Win");
            assert_eq!(c.step(down(first)), None);
            assert_eq!(c.step(down(second)), Some(ChordOut::Down));
            assert_eq!(c.step(down(second)), None, "a modifier's key repeat");
            assert_eq!(c.step(up(first)), Some(ChordOut::Up));
            assert_eq!(c.step(up(second)), None);
        }
    }

    #[test]
    fn altgr_is_ctrl_and_alt_so_it_never_starts_alt_win() {
        let mut c = chord("Alt+Win");
        c.step(down(CTRL));
        c.step(down(ALT_R));
        assert_eq!(c.step(down(WIN)), None);
    }

    #[test]
    fn a_key_joining_cancels_and_lets_go_without_a_stop() {
        // Win+Alt+R (Game Bar): the dictation it started is dropped, R goes on to Windows, and letting go starts nothing.
        let mut c = chord("Alt+Win");
        c.step(down(ALT));
        assert_eq!(c.step(down(WIN)), Some(ChordOut::Down));
        assert_eq!(c.step(Ev::Key(R, true)), Some(ChordOut::Cancel));
        assert_eq!(c.step(Ev::Key(R, false)), None);
        assert_eq!(c.step(up(WIN)), None);
        assert_eq!(c.step(down(WIN)), None, "the same Alt hold is a shortcut now, not the chord");
        assert_eq!(c.step(up(WIN)), None);
        assert_eq!(c.step(up(ALT)), None);
        // All let go: the next press is a chord again.
        c.step(down(WIN));
        assert_eq!(c.step(down(ALT)), Some(ChordOut::Down));
    }

    #[test]
    fn alt_tab_then_win_never_starts() {
        let mut c = chord("Alt+Win");
        c.step(down(ALT));
        c.step(Ev::Key(TAB, true));
        c.step(Ev::Key(TAB, false));
        assert_eq!(c.step(down(WIN)), None);
        assert_eq!(c.step(up(WIN)), None);
        assert_eq!(c.step(up(ALT)), None);
    }

    #[test]
    fn a_key_already_down_blocks_it_and_extra_modifiers_are_not_it() {
        let mut c = chord("Alt+Win");
        c.step(Ev::Key(0x41, true));
        c.step(down(ALT));
        assert_eq!(c.step(down(WIN)), None);
        let mut c = chord("Alt+Win");
        c.step(down(ALT));
        c.step(down(SHIFT));
        assert_eq!(c.step(down(WIN)), None, "Alt+Shift+Win is not Alt+Win");
        // The old chord still works for anyone who keeps it.
        let mut c = chord("Ctrl+Shift+Win");
        c.step(down(WIN));
        c.step(down(CTRL));
        assert_eq!(c.step(down(SHIFT)), Some(ChordOut::Down));
        assert_eq!(c.step(up(CTRL)), Some(ChordOut::Up));
    }

    #[test]
    fn a_lost_key_up_is_let_go_but_the_key_in_hand_is_trusted() {
        // Win+L locks the screen and its Win key-up never arrives.
        let mut c = chord("Alt+Win");
        c.step(down(WIN));
        // Later a lone Alt: before it is handled, the keyboard says Win is up, so Alt alone starts nothing.
        assert_eq!(c.stale(|_| false, Some(ALT)), None);
        assert_eq!(c.step(down(ALT)), None);
        assert_eq!(c.step(up(ALT)), None);
        // The key in hand is trusted though the keyboard has not caught up with it; one truly down is kept.
        c.step(down(WIN));
        assert_eq!(c.stale(|m| m == WIN, Some(ALT)), None);
        assert_eq!(c.step(down(ALT)), Some(ChordOut::Down));
        // Held, then Win's key-up lost: the next event ends it.
        assert_eq!(c.stale(|m| m == ALT, None), Some(ChordOut::Up));
    }
}
