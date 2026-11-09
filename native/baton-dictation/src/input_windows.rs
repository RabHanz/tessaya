//! The hands' clicks and keys, sent from this process: it is already per-monitor DPI aware, so a
//! physical point is the point clicked on any display. Replaces the PowerShell helper the desktop
//! used to start. A chord holds its modifiers 100 ms, as the paste does (keys.rs), and the arrow,
//! Home/End, Page, Insert and Delete keys go as extended keys, or some apps read the numpad ones.
use std::{thread, time::Duration};

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
    MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

const HOLD: Duration = Duration::from_millis(100);

fn mouse(dx: i32, dy: i32, flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

fn key(vk: u16, up: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Page Up/Down, End, Home, the arrows, Insert and Delete.
pub fn is_extended(vk: u16) -> bool {
    (0x21..=0x28).contains(&vk) || vk == 0x2D || vk == 0x2E
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows refused the input (another app may be running as administrator).".to_string())
    }
}

/// Where a physical point lands on the 0..65535 scale of the whole virtual desktop.
pub fn normalised(p: i32, origin: i32, size: i32) -> i32 {
    ((p - origin) as f64 * 65535.0 / (size - 1).max(1) as f64).ceil() as i32
}

/// The pointer to a physical point and the button flags after it, in one SendInput call so his own
/// mouse cannot land between them. With no point, only the buttons (a wheel where the pointer is).
pub fn at(point: Option<(i32, i32)>, buttons: &[u32], wheel: i32) -> Result<(), String> {
    let mut list = Vec::with_capacity(buttons.len() + 1);
    if let Some((x, y)) = point {
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        list.push(mouse(
            normalised(x, vx, vw),
            normalised(y, vy, vh),
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            0,
        ));
    }
    for &flag in buttons {
        let flags = MOUSE_EVENT_FLAGS(flag);
        list.push(mouse(0, 0, flags, if flags == MOUSEEVENTF_WHEEL { wheel } else { 0 }));
    }
    send(&list)
}

/// A key or a chord by virtual-key code, in press order; released in reverse.
pub fn keys(vks: &[u16]) -> Result<(), String> {
    let down: Vec<INPUT> = vks.iter().map(|&vk| key(vk, false)).collect();
    send(&down)?;
    if vks.len() > 1 {
        thread::sleep(HOLD);
    }
    let up: Vec<INPUT> = vks.iter().rev().map(|&vk| key(vk, true)).collect();
    send(&up)
}

/// Keys held for a paste, sent again in one call as (code, up) events, so his typing cannot land between them.
pub fn replay(events: &[(u16, bool)]) -> Result<(), String> {
    send(&events.iter().map(|&(vk, up)| key(vk, up)).collect::<Vec<INPUT>>())
}

#[cfg(test)]
mod tests {
    use super::{is_extended, normalised};

    #[test]
    fn arrows_and_delete_are_extended_letters_are_not() {
        assert!(is_extended(0x25) && is_extended(0x2E) && is_extended(0x24));
        assert!(!is_extended(0x41) && !is_extended(0x0D));
    }

    #[test]
    fn a_point_maps_onto_the_whole_virtual_desktop() {
        assert_eq!(normalised(0, 0, 1920), 0);
        assert_eq!(normalised(1919, 0, 1920), 65535);
        assert_eq!(normalised(-1920, -1920, 3840), 0);
    }
}
