//! The modifier-only hold keys (`chord.rs`) from a low-level keyboard hook of their own, on their own thread. It never
//! blocks a key. Injected events are skipped, so our paste's Ctrl+V and the menu mask never start, end or spoil a hold,
//! and no injected event makes it re-read the keyboard (handy-keys' listener did, and dropped a held chord within 4 ms).
//! When a chord starts, an unassigned key is sent so the shell does not take letting go of Win as a lone tap (Start) or
//! of Alt as one (the menu bar), as AutoHotkey's MenuMaskKey does.

use std::cell::RefCell;
use std::sync::mpsc::{channel, Sender};
use std::thread;
use std::time::Instant;

use handy_keys::Modifiers;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLKHF_UP, MSG, WH_KEYBOARD_LL, WM_QUIT,
};

use crate::chord::{Chord, ChordOut, Ev};
use crate::Msg;

struct State {
    chords: Vec<Chord>,
    tx: Sender<Msg>,
    clock: Instant,
}

// LL hooks run on the thread that installed them, so each hook thread owns its chords.
thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// AutoHotkey's default mask key; handy-keys' marker, so its own hook passes it through untouched too.
const MASK_VK: u16 = 0xE8;
const MASK_EXTRA: usize = 0x484B_4D4D;

fn side(vk: u32) -> Option<(Modifiers, u16)> {
    Some(match vk {
        0xA0 | 0x10 => (Modifiers::SHIFT_LEFT, 0xA0),
        0xA1 => (Modifiers::SHIFT_RIGHT, 0xA1),
        0xA2 | 0x11 => (Modifiers::CTRL_LEFT, 0xA2),
        0xA3 => (Modifiers::CTRL_RIGHT, 0xA3),
        0xA4 | 0x12 => (Modifiers::OPT_LEFT, 0xA4),
        0xA5 => (Modifiers::OPT_RIGHT, 0xA5),
        0x5B => (Modifiers::CMD_LEFT, 0x5B),
        0x5C => (Modifiers::CMD_RIGHT, 0x5C),
        _ => return None,
    })
}

fn vk_of(side_bit: Modifiers) -> u16 {
    [0xA0u32, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C]
        .into_iter()
        .find_map(|vk| side(vk).filter(|(m, _)| *m == side_bit).map(|(_, v)| v))
        .unwrap_or(0)
}

fn mask() {
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(MASK_VK), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: MASK_EXTRA },
        },
    };
    let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let pressed = info.flags.0 & LLKHF_UP.0 == 0;
            let modifier = side(info.vkCode).map(|(m, _)| m);
            let ev = match modifier {
                Some(m) => Ev::Mod(m, pressed),
                None => Ev::Key(info.vkCode, pressed),
            };
            let mut started = false;
            STATE.with_borrow_mut(|slot| {
                if let Some(state) = slot.as_mut() {
                    let at = state.clock.elapsed().as_secs_f64() * 1000.0;
                    let is_down = |m: Modifiers| unsafe { GetAsyncKeyState(vk_of(m) as i32) } as u16 & 0x8000 != 0;
                    for chord in &mut state.chords {
                        let outs = [chord.stale(&is_down, modifier), chord.step(ev)];
                        for out in outs.into_iter().flatten() {
                            let msg = match out {
                                ChordOut::Down => {
                                    started = true;
                                    Msg::Key { hold: true, pressed: true, at }
                                }
                                ChordOut::Up => Msg::Key { hold: true, pressed: false, at },
                                ChordOut::Cancel => Msg::ChordJoined,
                            };
                            let _ = state.tx.send(msg);
                        }
                    }
                }
            });
            if started {
                mask();
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// The hook runs until the returned thread id is sent `WM_QUIT` (`stop`). None: Windows refused the hook.
pub fn start(wants: Vec<Modifiers>, tx: Sender<Msg>, clock: Instant) -> Option<u32> {
    let state = State { chords: wants.into_iter().map(Chord::new).collect(), tx, clock };
    let (ready_tx, ready) = channel::<u32>();
    thread::spawn(move || unsafe {
        STATE.set(Some(state));
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
    ready.recv().ok().filter(|id| *id != 0)
}

pub fn stop(thread: u32) {
    unsafe {
        let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
    }
}
