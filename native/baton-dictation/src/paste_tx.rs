//! The pure half of a clipboard paste transaction (Handy's `paste_tx`, MIT, see paste_windows.rs): when the target
//! has read, when to settle, and whether a new paste may take the clipboard yet. No platform calls, so it is tested on
//! any machine (`rustc --edition 2021 --test src/paste_tx.rs`).

use std::time::{Duration, Instant};

/// How long after the *last* observed read the transcript stays on the clipboard before restoring. Covers
/// applications that read the clipboard several times per paste (e.g. Chromium probe-then-read).
pub const QUIET_PERIOD: Duration = Duration::from_millis(200);

/// Upper bound on how long the transcript may occupy the clipboard before we restore regardless of receipts.
pub const RESTORE_TIMEOUT: Duration = Duration::from_secs(8);

/// When the chord could not be injected at all, no legitimate receipt can arrive, so restore quickly.
pub const FAILED_INJECTION_TIMEOUT: Duration = Duration::from_millis(500);

/// A new paste waits no longer than this for an unread chord: past it the old one is left unread (its words kept),
/// so a dead target never holds the sidecar's loop, and his key presses, for the full restore timeout.
pub const UNREAD_TAKEOVER: Duration = Duration::from_millis(1500);

/// Shared, cross-thread record of one paste transaction.
#[derive(Debug)]
pub struct TxState {
    /// When the transcript was published to the clipboard.
    pub published_at: Instant,
    /// When the paste chord was injected. Only receipts *after* this count as evidence the target read the
    /// transcript; earlier reads are eager third parties reacting to the clipboard change itself.
    pub injected_at: Option<Instant>,
    /// The chord could not be sent; short-circuit the wait.
    pub injection_failed: bool,
    /// Times at which a consumer requested the clipboard data.
    pub receipts: Vec<Instant>,
    /// Someone else took clipboard ownership (user copied elsewhere, ...).
    pub ownership_lost: bool,
    /// Settled: restored, left or handed on. Set once.
    pub cancelled: bool,
    /// A newer paste settled it; its own timer only tears down.
    pub taken_over: bool,
    /// First post-injection receipt has been logged.
    pub logged_receipt: bool,
}

impl TxState {
    pub fn new(now: Instant) -> Self {
        Self {
            published_at: now,
            injected_at: None,
            injection_failed: false,
            receipts: Vec::new(),
            ownership_lost: false,
            cancelled: false,
            taken_over: false,
            logged_receipt: false,
        }
    }

    /// Records a read receipt; true for the first one that counts as evidence (after the chord).
    pub fn record_receipt(&mut self, at: Instant) -> bool {
        self.receipts.push(at);
        if self.logged_receipt {
            return false;
        }
        match self.injected_at {
            Some(injected) if at >= injected => {
                self.logged_receipt = true;
                true
            }
            _ => false,
        }
    }

    pub fn last_receipt_after_injection(&self) -> Option<Instant> {
        let injected = self.injected_at?;
        self.receipts.iter().copied().rev().find(|t| *t >= injected)
    }

    pub fn any_receipt_after_injection(&self) -> bool {
        self.last_receipt_after_injection().is_some()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaitDecision {
    KeepWaiting,
    /// Stop waiting; settle the transaction (guarded restore).
    Finish,
}

/// Given the current transaction state, keep waiting for the target to read, or finish now.
pub fn evaluate(state: &TxState, now: Instant) -> WaitDecision {
    if state.ownership_lost || state.cancelled {
        return WaitDecision::Finish;
    }
    if let Some(last) = state.last_receipt_after_injection() {
        if now.duration_since(last) >= QUIET_PERIOD {
            return WaitDecision::Finish;
        }
    }
    let deadline = if state.injection_failed {
        FAILED_INJECTION_TIMEOUT
    } else {
        RESTORE_TIMEOUT
    };
    if now.duration_since(state.published_at) >= deadline {
        return WaitDecision::Finish;
    }
    WaitDecision::KeepWaiting
}

/// What a new paste does about the one before it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum TakeOver {
    /// Its target may still read it: wait.
    Wait,
    /// It is done (read and quiet, timed out, or his copy replaced it): let it settle as it would on its own.
    Settle,
    /// Its chord has gone unread too long: leave its words where he can get them and go on.
    LeaveUnread,
}

/// Settling the previous paste before its target had read it put his old clipboard back under a Ctrl+V still on its
/// way, so that is what got pasted (0.1.79). A new paste waits as the previous one would on its own, but never more
/// than `UNREAD_TAKEOVER` for a chord nothing has read.
pub fn take_over(previous: &TxState, now: Instant) -> TakeOver {
    if evaluate(previous, now) == WaitDecision::Finish {
        return TakeOver::Settle;
    }
    match previous.injected_at {
        Some(injected)
            if !previous.any_receipt_after_injection()
                && now.duration_since(injected) >= UNREAD_TAKEOVER =>
        {
            TakeOver::LeaveUnread
        }
        _ => TakeOver::Wait,
    }
}

/// What the clipboard holds just before the chord: ours only while we still own it and nothing wrote since we
/// published. Anything else must not be pasted under our name.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Held {
    Ours,
    Other,
}

pub fn held_at_chord(published_sequence: u32, sequence_now: u32, we_own_it: bool) -> Held {
    if we_own_it && published_sequence == sequence_now {
        Held::Ours
    } else {
        Held::Other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(at: Instant) -> TxState {
        let mut state = TxState::new(at);
        state.injected_at = Some(at);
        state
    }

    #[test]
    fn a_new_paste_waits_while_the_last_chord_is_unread() {
        let t0 = Instant::now();
        let previous = sent(t0);
        // The second flush arrives 100 ms after the first Ctrl+V, which the target has not read yet.
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(100)), TakeOver::Wait);
    }

    #[test]
    fn a_new_paste_waits_until_the_reads_go_quiet() {
        let t0 = Instant::now();
        let mut previous = sent(t0);
        previous.record_receipt(t0 + Duration::from_millis(40));
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(100)), TakeOver::Wait);
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(260)), TakeOver::Settle);
    }

    #[test]
    fn an_unread_chord_is_left_unread_after_a_second_and_a_half_not_restored_over() {
        let t0 = Instant::now();
        let previous = sent(t0);
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(1400)), TakeOver::Wait);
        // Not the 8 s restore timeout: his next hold-key press must not wait that long behind it.
        assert_eq!(take_over(&previous, t0 + UNREAD_TAKEOVER), TakeOver::LeaveUnread);
    }

    #[test]
    fn a_new_paste_settles_one_that_is_done() {
        let t0 = Instant::now();
        let mut lost = sent(t0);
        lost.ownership_lost = true;
        assert_eq!(take_over(&lost, t0), TakeOver::Settle);
        let mut failed = TxState::new(t0);
        failed.injection_failed = true;
        assert_eq!(take_over(&failed, t0 + FAILED_INJECTION_TIMEOUT), TakeOver::Settle);
    }

    #[test]
    fn a_read_before_the_chord_is_not_the_targets() {
        let t0 = Instant::now();
        let mut state = TxState::new(t0);
        assert!(!state.record_receipt(t0 + Duration::from_millis(5)));
        state.injected_at = Some(t0 + Duration::from_millis(10));
        assert!(!state.any_receipt_after_injection());
        assert!(state.record_receipt(t0 + Duration::from_millis(30)));
    }

    #[test]
    fn only_our_own_unchanged_clipboard_is_pasted() {
        assert_eq!(held_at_chord(7, 7, true), Held::Ours);
        // He copied something between our write and the chord, or a clipboard manager rewrote it.
        assert_eq!(held_at_chord(7, 8, true), Held::Other);
        assert_eq!(held_at_chord(7, 7, false), Held::Other);
    }
}
