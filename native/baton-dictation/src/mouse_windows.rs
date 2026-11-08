//! The Windows side of the mouse hook: a low-level hook (WH_MOUSE_LL) on its own thread, feeding the
//! rules in `mouse.rs`. It is installed only while at least one mouse button is bound, so with no
//! bindings no hook exists and nothing is delayed. Presses it held back are replayed with SendInput,
//! tagged so the hook ignores them. Nothing is consumed unless the rules say so.

use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::json;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::emit;
use crate::mouse::{reduce, Action, Button, Config, Ev, State};

/// Marks the clicks this module sends, so the hook never reads its own.
const MARK: usize = 0x4241_544F;

struct Live {
    cfg: Config,
    state: State,
    started: Instant,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);
static THREAD: Mutex<Option<(u32, JoinHandle<()>)>> = Mutex::new(None);

fn send(button: Button, down: bool) {
    let (flag, data): (MOUSE_EVENT_FLAGS, u32) = match (button, down) {
        (Button::Left, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (Button::Left, false) => (MOUSEEVENTF_LEFTUP, 0),
        (Button::Right, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (Button::Right, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (Button::Middle, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (Button::Middle, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (Button::X1, true) => (MOUSEEVENTF_XDOWN, 1),
        (Button::X1, false) => (MOUSEEVENTF_XUP, 1),
        (Button::X2, true) => (MOUSEEVENTF_XDOWN, 2),
        (Button::X2, false) => (MOUSEEVENTF_XUP, 2),
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data, dwFlags: flag, time: 0, dwExtraInfo: MARK },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
}

fn decode(message: u32, info: &MSLLHOOKSTRUCT) -> Option<(Button, bool)> {
    let x = if (info.mouseData >> 16) & 0xFFFF == 2 { Button::X2 } else { Button::X1 };
    Some(match message {
        WM_LBUTTONDOWN => (Button::Left, true),
        WM_LBUTTONUP => (Button::Left, false),
        WM_RBUTTONDOWN => (Button::Right, true),
        WM_RBUTTONUP => (Button::Right, false),
        WM_MBUTTONDOWN => (Button::Middle, true),
        WM_MBUTTONUP => (Button::Middle, false),
        WM_XBUTTONDOWN => (x, true),
        WM_XBUTTONUP => (x, false),
        _ => return None,
    })
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        if info.dwExtraInfo != MARK {
            if let Some((button, down)) = decode(wparam.0 as u32, info) {
                let actions = match LIVE.lock() {
                    Ok(mut guard) => match guard.as_mut() {
                        Some(live) => {
                            let t = live.started.elapsed().as_millis() as u64;
                            let ev = if down { Ev::Down(button, t) } else { Ev::Up(button, t) };
                            let Live { cfg, state, .. } = live;
                            reduce(state, ev, cfg)
                        }
                        None => vec![Action::Pass],
                    },
                    Err(_) => vec![Action::Pass],
                };
                let replays = actions.iter().any(|a| matches!(a, Action::ReplayDown(_)));
                let consumed = actions.iter().any(|a| matches!(a, Action::Consume));
                for action in &actions {
                    match action {
                        Action::ReplayDown(b) => send(*b, true),
                        Action::Fire(id) => emit(json!({"ev": "binding", "id": id})),
                        Action::Release(id) => emit(json!({"ev": "binding", "id": id, "up": true})),
                        _ => {}
                    }
                }
                // A replayed press must reach the app before this event, so this one is sent
                // after it instead of being passed ahead of it.
                if replays && !consumed {
                    send(button, down);
                    return LRESULT(1);
                }
                if consumed {
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Installs, replaces or removes the hook to match the bindings in `path`.
pub fn configure(path: Option<&std::path::Path>) {
    let cfg = path
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map(|value| Config::parse(&value))
        .filter(|cfg| !cfg.is_empty());
    match cfg {
        None => stop(),
        Some(cfg) => {
            let running = THREAD.lock().map(|t| t.is_some()).unwrap_or(false);
            if let Ok(mut live) = LIVE.lock() {
                let started = live.as_ref().map(|l| l.started).unwrap_or_else(Instant::now);
                *live = Some(Live { cfg, state: State::default(), started });
            }
            if !running {
                start();
            }
        }
    }
}

fn start() {
    let (tx, rx) = channel::<u32>();
    let handle = thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).map(|m| HINSTANCE(m.0)).ok();
        let Ok(installed) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), module, 0) else {
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
                *thread = Some((id, handle));
            }
            // A held press whose partner never came is replayed when its window runs out, even
            // with no further mouse event to wake the hook.
            thread::spawn(|| loop {
                thread::sleep(Duration::from_millis(10));
                let actions = match LIVE.lock() {
                    Ok(mut guard) => match guard.as_mut() {
                        Some(live) => {
                            let t = live.started.elapsed().as_millis() as u64;
                            let Live { cfg, state, .. } = live;
                            reduce(state, Ev::Tick(t), cfg)
                        }
                        None => return,
                    },
                    Err(_) => return,
                };
                for action in actions {
                    if let Action::ReplayDown(b) = action {
                        send(b, true);
                    }
                }
            });
        }
        _ => emit(json!({"ev": "error", "message": "The mouse hook could not start."})),
    }
}

pub fn stop() {
    if let Ok(mut live) = LIVE.lock() {
        *live = None;
    }
    if let Ok(mut thread) = THREAD.lock() {
        if let Some((id, handle)) = thread.take() {
            unsafe {
                let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            let _ = handle.join();
        }
    }
}
