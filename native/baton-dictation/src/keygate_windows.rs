//! The Windows side of the key gate (`keygate.rs`): a low-level keyboard hook on its own thread, installed when the
//! ghost starts playing and removed when its dictation's paste lands, another window comes to the front, or CAP_MS
//! passes. The hook only decides and queues; a worker thread does every write and ends the hook.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, MSG,
    WH_KEYBOARD_LL, WM_QUIT,
};

use crate::emit;
use crate::keygate::{Gate, Mods, Verdict, CAP_MS};

struct Live {
    gate: Gate,
    started: Instant,
}

enum Note {
    Held(u64),
    Lost(u64),
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);
static NOTES: Mutex<Option<Sender<Note>>> = Mutex::new(None);
static THREAD: AtomicU64 = AtomicU64::new(0);

fn down(vk: u16) -> bool {
    unsafe { GetAsyncKeyState(vk as i32) < 0 }
}

/// Windows will not let this process send keys into an elevated window, so keys are never held for one.
fn elevated(window: HWND) -> bool {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid as *mut u32));
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return true };
        let mut token = HANDLE::default();
        let mut info = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let read = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok()
            && GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut info as *mut _ as *mut core::ffi::c_void),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
            .is_ok();
        if !token.is_invalid() {
            let _ = CloseHandle(token);
        }
        let _ = CloseHandle(process);
        !read || info.TokenIsElevated != 0
    }
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let mods = Mods {
            shift: down(VK_SHIFT.0),
            command: down(VK_CONTROL.0) || down(VK_MENU.0) || down(VK_LWIN.0) || down(VK_RWIN.0),
        };
        let front = GetForegroundWindow().0 as isize;
        let decided = LIVE.lock().ok().and_then(|mut live| {
            let l = live.as_mut()?;
            let verdict = l.gate.key(
                info.vkCode as u16,
                info.flags.0 & LLKHF_UP.0 != 0,
                info.flags.0 & LLKHF_INJECTED.0 != 0,
                mods,
                front,
                l.started.elapsed().as_millis() as u64,
            );
            let owner = l.gate.owner;
            if verdict == Verdict::Lost {
                *live = None;
            }
            Some((verdict, owner))
        });
        let note = |n: Note| {
            if let Some(tx) = NOTES.lock().ok().and_then(|t| t.clone()) {
                let _ = tx.send(n);
            }
        };
        match decided {
            Some((Verdict::First, owner)) => {
                note(Note::Held(owner));
                return LRESULT(1);
            }
            Some((Verdict::Hold, _)) => return LRESULT(1),
            Some((Verdict::Lost, owner)) => note(Note::Lost(owner)),
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Keys wait for dictation `owner`'s paste into `target` from now, unless that window is elevated or not in front.
pub fn hold(owner: u64, target: isize) {
    let front = unsafe { GetForegroundWindow() };
    if front.0 as isize != target || elevated(front) {
        return;
    }
    // A hold still up belongs to an older dictation: its keys go before this one starts.
    if let Some(old) = LIVE.lock().ok().and_then(|live| live.as_ref().map(|l| l.gate.owner)) {
        release(old);
    }
    let (tx, notes) = channel::<Note>();
    if let Ok(mut slot) = NOTES.lock() {
        *slot = Some(tx);
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
    let Ok(id) = ready.recv() else { return };
    if id == 0 {
        return;
    }
    THREAD.store(id as u64, Ordering::SeqCst);
    if let Ok(mut live) = LIVE.lock() {
        *live = Some(Live { gate: Gate::new(owner, target), started: Instant::now() });
    }
    // Every write happens here, never in the hook; at the cap the held keys go and everything passes.
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_millis(CAP_MS);
        loop {
            match notes.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Note::Held(o)) => emit(json!({"ev": "held_key", "id": o})),
                Ok(Note::Lost(o)) => {
                    emit(json!({"ev": "held_lost", "id": o}));
                    unhook(id);
                    return;
                }
                Err(_) => return release(owner),
            }
        }
    });
}

fn unhook(thread: u32) {
    let _ = THREAD.compare_exchange(thread as u64, 0, Ordering::SeqCst, Ordering::SeqCst);
    unsafe {
        let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
    }
}

/// Dictation `owner`'s paste has landed: its held keys go, in order, and the hook ends. Another's id does nothing.
pub fn release(owner: u64) {
    let events = match LIVE.lock() {
        Ok(mut live) => match live.as_mut().and_then(|l| l.gate.release(owner, down(VK_SHIFT.0))) {
            Some(events) => {
                *live = None;
                events
            }
            None => return,
        },
        Err(_) => return,
    };
    if let Ok(mut slot) = NOTES.lock() {
        *slot = None;
    }
    let thread = THREAD.load(Ordering::SeqCst) as u32;
    if thread != 0 {
        unhook(thread);
    }
    if !events.is_empty() {
        if let Err(message) = crate::input_windows::replay(&events) {
            emit(json!({"ev": "error", "message": message}));
        }
    }
}
