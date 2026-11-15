//! The pure half of a clipboard paste transaction (Handy's `paste_tx`, MIT, see paste_windows.rs): whether the field
//! took the words, when to settle, and whether a new paste may take the clipboard yet. No platform calls, so it is
//! tested on any machine (`rustc --edition 2021 --test src/paste_tx.rs`).

use std::time::{Duration, Instant};

/// How long the transcript stays on the clipboard once the field shows it, for a target that reads more than once
/// per paste (e.g. Chromium probe-then-read).
pub const QUIET_PERIOD: Duration = Duration::from_millis(200);

/// A field UI Automation cannot read gives no sign the paste landed, so his clipboard comes back this long after the
/// chord. shortcut: a target slower than this pastes his old clipboard; widen it if one shows up.
pub const BLIND_RESTORE: Duration = Duration::from_millis(1000);

/// Upper bound on how long the transcript may occupy the clipboard before we settle regardless.
pub const RESTORE_TIMEOUT: Duration = Duration::from_secs(8);

/// When the chord could not be injected at all, nothing can paste it, so settle quickly.
pub const FAILED_INJECTION_TIMEOUT: Duration = Duration::from_millis(500);

/// A new paste waits no longer than this for an unread chord: past it the old one is left unread (its words kept),
/// so a dead target never holds the sidecar's loop, and his key presses, for the full restore timeout.
pub const UNREAD_TAKEOVER: Duration = Duration::from_millis(1500);

/// How long after a chord the field may take to show the words before it counts as missed.
pub const VERIFY_WINDOW: Duration = Duration::from_millis(500);

/// What the focused field showed after the chord.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Seen {
    Landed,
    /// Readable before and after, and unchanged: nothing was pasted.
    Missed,
    /// UI Automation could not read it, before or after.
    Unknown,
}

/// The text before the caret, read just before the chord and again after it.
pub fn compare(before: Option<&str>, after: Option<&str>) -> Seen {
    match (before, after) {
        (Some(before), Some(after)) if before == after => Seen::Missed,
        (Some(_), Some(_)) => Seen::Landed,
        _ => Seen::Unknown,
    }
}

/// One resend, only for a chord the field did not take while another process held the clipboard (Windows clipboard
/// history had it at the chord on his laptop, 16 Nov), and only while the clipboard is still our transcript. A slow
/// target with nobody else on the clipboard is left alone: a second chord there would paste the words twice.
pub fn retry_chord(seen: Seen, foreign_hold: bool, retried: bool, still_ours: bool) -> bool {
    seen == Seen::Missed && foreign_hold && !retried && still_ours
}

/// Shared, cross-thread record of one paste transaction.
#[derive(Debug)]
pub struct TxState {
    /// When the transcript was published to the clipboard.
    pub published_at: Instant,
    /// When the paste chord was injected.
    pub injected_at: Option<Instant>,
    /// The chord could not be sent; short-circuit the wait.
    pub injection_failed: bool,
    /// What the field showed after the chord (and its one resend), and when that was known.
    pub seen: Option<(Seen, Instant)>,
    /// Someone else took clipboard ownership (user copied elsewhere, ...).
    pub ownership_lost: bool,
    /// Settled: restored, left or handed on. Set once.
    pub cancelled: bool,
    /// A newer paste settled it; its own timer only tears down.
    pub taken_over: bool,
}

impl TxState {
    pub fn new(now: Instant) -> Self {
        Self {
            published_at: now,
            injected_at: None,
            injection_failed: false,
            seen: None,
            ownership_lost: false,
            cancelled: false,
            taken_over: false,
        }
    }

    /// Read unless the field showed it was not: a field that cannot be read is taken to have pasted.
    pub fn read(&self) -> bool {
        matches!(self.seen, Some((Seen::Landed | Seen::Unknown, _)))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum WaitDecision {
    KeepWaiting,
    /// Stop waiting; settle the transaction (guarded restore).
    Finish,
}

/// Given the current transaction state, keep waiting for the field to show the words, or finish now.
pub fn evaluate(state: &TxState, now: Instant) -> WaitDecision {
    if state.ownership_lost || state.cancelled {
        return WaitDecision::Finish;
    }
    let done = match state.seen {
        Some((Seen::Landed, at)) => now.duration_since(at) >= QUIET_PERIOD,
        Some((Seen::Unknown, at)) => now.duration_since(state.injected_at.unwrap_or(at)) >= BLIND_RESTORE,
        Some((Seen::Missed, _)) => true,
        None => false,
    };
    if done {
        return WaitDecision::Finish;
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
    /// It is done (shown and quiet, timed out, or his copy replaced it): let it settle as it would on its own.
    Settle,
    /// Its chord has gone unconfirmed too long: leave its words where he can get them and go on.
    LeaveUnread,
}

/// Settling the previous paste before its target had read it put his old clipboard back under a Ctrl+V still on its
/// way, so that is what got pasted (0.1.79). A new paste waits as the previous one would on its own, but never more
/// than `UNREAD_TAKEOVER` for a chord nothing has confirmed.
pub fn take_over(previous: &TxState, now: Instant) -> TakeOver {
    if evaluate(previous, now) == WaitDecision::Finish {
        return TakeOver::Settle;
    }
    match previous.injected_at {
        Some(injected) if !previous.read() && now.duration_since(injected) >= UNREAD_TAKEOVER => TakeOver::LeaveUnread,
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

/// Clipboard watchers (Windows clipboard history, Ditto, Wispr Flow) open the clipboard the moment the transcript is
/// published. A chord landing then pastes nothing: on his laptop 22 of 50 dictations (16 Nov). So the chord waits at
/// least `SETTLE_MIN` and until nobody holds the clipboard, at most `SETTLE_MAX`.
pub const SETTLE_MIN: Duration = Duration::from_millis(60);
pub const SETTLE_MAX: Duration = Duration::from_millis(300);
const SETTLE_STEP: Duration = Duration::from_millis(5);

/// Waits out the watchers; returns how long it waited. `held` says whether another window has the clipboard open.
pub fn settle_before_chord(mut held: impl FnMut() -> bool, mut sleep: impl FnMut(Duration)) -> Duration {
    let mut waited = Duration::ZERO;
    while waited < SETTLE_MAX && (waited < SETTLE_MIN || held()) {
        sleep(SETTLE_STEP);
        waited += SETTLE_STEP;
    }
    waited
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_chord_waits_for_clipboard_watchers_then_goes() {
        let none = settle_before_chord(|| false, |_| {});
        assert_eq!(none, SETTLE_MIN);
        let mut asks = 0;
        let busy = settle_before_chord(
            || {
                asks += 1;
                asks <= 10
            },
            |_| {},
        );
        assert_eq!(busy, SETTLE_MIN + SETTLE_STEP * 10);
        assert_eq!(settle_before_chord(|| true, |_| {}), SETTLE_MAX);
    }

    fn sent(at: Instant) -> TxState {
        let mut state = TxState::new(at);
        state.injected_at = Some(at);
        state
    }

    #[test]
    fn the_field_before_and_after_the_chord_says_whether_it_landed() {
        assert_eq!(compare(Some("hello "), Some("hello world")), Seen::Landed);
        assert_eq!(compare(Some("hello "), Some("hello ")), Seen::Missed);
        // An empty field that reads back empty took nothing either.
        assert_eq!(compare(Some(""), Some("")), Seen::Missed);
        assert_eq!(compare(None, Some("hello")), Seen::Unknown);
        assert_eq!(compare(Some("hello "), None), Seen::Unknown);
    }

    #[test]
    fn a_missed_chord_is_resent_once_and_only_when_a_watcher_held_the_clipboard() {
        assert!(retry_chord(Seen::Missed, true, false, true));
        // Nobody else on the clipboard: the target may just be slow, and a resend would paste twice.
        assert!(!retry_chord(Seen::Missed, false, false, true));
        assert!(!retry_chord(Seen::Missed, true, true, true));
        // He copied something since: the chord would paste that.
        assert!(!retry_chord(Seen::Missed, true, false, false));
        assert!(!retry_chord(Seen::Landed, true, false, true));
        assert!(!retry_chord(Seen::Unknown, true, false, true));
    }

    #[test]
    fn it_settles_after_the_quiet_period_once_shown_and_blind_after_a_second() {
        let t0 = Instant::now();
        let mut shown = sent(t0);
        shown.seen = Some((Seen::Landed, t0 + Duration::from_millis(80)));
        assert_eq!(evaluate(&shown, t0 + Duration::from_millis(200)), WaitDecision::KeepWaiting);
        assert_eq!(evaluate(&shown, t0 + Duration::from_millis(280)), WaitDecision::Finish);
        assert!(shown.read());
        let mut blind = sent(t0);
        blind.seen = Some((Seen::Unknown, t0));
        assert_eq!(evaluate(&blind, t0 + Duration::from_millis(900)), WaitDecision::KeepWaiting);
        assert_eq!(evaluate(&blind, t0 + BLIND_RESTORE), WaitDecision::Finish);
        assert!(blind.read());
        let mut missed = sent(t0);
        missed.seen = Some((Seen::Missed, t0 + Duration::from_millis(500)));
        assert_eq!(evaluate(&missed, t0 + Duration::from_millis(500)), WaitDecision::Finish);
        assert!(!missed.read());
    }

    #[test]
    fn a_new_paste_waits_while_the_last_chord_is_unconfirmed() {
        let t0 = Instant::now();
        let previous = sent(t0);
        // The second flush arrives 100 ms after the first Ctrl+V, which the field does not show yet.
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(100)), TakeOver::Wait);
    }

    #[test]
    fn a_new_paste_waits_until_the_shown_paste_goes_quiet() {
        let t0 = Instant::now();
        let mut previous = sent(t0);
        previous.seen = Some((Seen::Landed, t0 + Duration::from_millis(40)));
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(100)), TakeOver::Wait);
        assert_eq!(take_over(&previous, t0 + Duration::from_millis(260)), TakeOver::Settle);
    }

    #[test]
    fn an_unconfirmed_chord_is_left_unread_after_a_second_and_a_half_not_restored_over() {
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
    fn only_our_own_unchanged_clipboard_is_pasted() {
        assert_eq!(held_at_chord(7, 7, true), Held::Ours);
        // He copied something between our write and the chord, or a clipboard manager rewrote it.
        assert_eq!(held_at_chord(7, 8, true), Held::Other);
        assert_eq!(held_at_chord(7, 7, false), Held::Other);
    }
}
