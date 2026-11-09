//! The Windows side of the key gate (`keygate.rs`): a low-level keyboard hook on its own thread, installed when the
//! desktop asks keys to wait for a paste and removed when it says the paste landed (or after MAX_HOLD), when the keys
//! it held are sent again with SendInput. Injected keys, the paste's own chord included, always pass.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::json;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, MSG, WH_KEYBOARD_LL, WM_QUIT,
};

use crate::emit;
use crate::keygate::{Gate, Verdict, MODIFIERS};

/// A desktop that never says the paste landed cannot keep his keys longer than this.
const MAX_HOLD: Duration = Duration::from_secs(8);

static GATE: Mutex<Option<Gate>> = Mutex::new(None);
static THREAD: Mutex<Option<u32>> = Mutex::new(None);
/// Which gate a MAX_HOLD timer belongs to, so an old timer never ends a newer gate.
static EPOCH: AtomicU64 = AtomicU64::new(0);

fn modifiers_down() -> Vec<u16> {
    MODIFIERS.iter().copied().filter(|&vk| unsafe { GetAsyncKeyState(vk as i32) } < 0).collect()
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let up = info.flags.0 & LLKHF_UP.0 != 0;
        let injected = info.flags.0 & LLKHF_INJECTED.0 != 0;
        let verdict = match GATE.lock() {
            Ok(mut guard) => guard.as_mut().map(|gate| gate.key(info.vkCode as u16, up, injected, &modifiers_down())),
            Err(_) => None,
        };
        match verdict {
            Some(Verdict::First) => {
                emit(json!({"ev": "held_key"}));
                return LRESULT(1);
            }
            Some(Verdict::Swallow) => return LRESULT(1),
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// On: keys wait from now. Off: the hook goes and the held keys are sent, in order.
pub fn hold(on: bool) {
    if !on {
        return release();
    }
    match GATE.lock() {
        Ok(mut gate) if gate.is_none() => *gate = Some(Gate::default()),
        _ => return,
    }
    let epoch = EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = channel::<u32>();
    thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).ok();
        let Ok(installed) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) else {
            let _ = tx.send(0);
            return;
        };
        let _ = tx.send(GetCurrentThreadId());
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(installed);
    });
    match rx.recv() {
        Ok(id) if id != 0 => {
            if let Ok(mut thread) = THREAD.lock() {
                *thread = Some(id);
            }
            thread::spawn(move || {
                thread::sleep(MAX_HOLD);
                if EPOCH.load(Ordering::SeqCst) == epoch {
                    release();
                }
            });
        }
        // No hook, no gate: keys go straight through, as before.
        _ => {
            if let Ok(mut gate) = GATE.lock() {
                *gate = None;
            }
        }
    }
}

fn release() {
    let gate = GATE.lock().ok().and_then(|mut gate| gate.take());
    EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Some(id) = THREAD.lock().ok().and_then(|mut thread| thread.take()) {
        unsafe {
            let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    let Some(mut gate) = gate else { return };
    let events = gate.release(&modifiers_down());
    if !events.is_empty() {
        if let Err(message) = crate::input_windows::replay(&events) {
            emit(json!({"ev": "error", "message": message}));
        }
    }
}
