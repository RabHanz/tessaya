//! Esc while the hold key is down. Windows delivers it as Ctrl+Shift+Win+Esc, which the desktop's Esc shortcut never
//! sees, so while a hold records a low-level hook on its own thread takes every Esc (it never reaches the focused app)
//! and tells the loop, which drops the recording. Installed after the hotkey hooks, it runs before them.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread;

use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, MSG, WH_KEYBOARD_LL, WM_QUIT,
};

use crate::Msg;

static TX: Mutex<Option<Sender<Msg>>> = Mutex::new(None);
static THREAD: AtomicU32 = AtomicU32::new(0);

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.vkCode == VK_ESCAPE.0 as u32 && info.flags.0 & LLKHF_INJECTED.0 == 0 {
            if info.flags.0 & LLKHF_UP.0 == 0 {
                if let Some(tx) = TX.lock().ok().and_then(|t| t.clone()) {
                    let _ = tx.send(Msg::HeldEscape);
                }
            }
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// A hold began recording: Esc is ours until `disarm`.
pub fn arm(tx: &Sender<Msg>) {
    if THREAD.load(Ordering::SeqCst) != 0 {
        return;
    }
    if let Ok(mut slot) = TX.lock() {
        *slot = Some(tx.clone());
    }
    let (ready_tx, ready) = channel::<u32>();
    thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).ok();
        let Ok(installed) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), module, 0) else {
            let _ = ready_tx.send(0);
            return;
        };
        let _ = ready_tx.send(GetCurrentThreadId());
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = UnhookWindowsHookEx(installed);
    });
    if let Ok(id) = ready.recv() {
        THREAD.store(id, Ordering::SeqCst);
    }
}

/// The hold ended (released, latched, joined or failed): Esc is his again.
pub fn disarm() {
    if let Ok(mut slot) = TX.lock() {
        *slot = None;
    }
    let id = THREAD.swap(0, Ordering::SeqCst);
    if id != 0 {
        unsafe {
            let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}
