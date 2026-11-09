//! The real element behind a guess: Windows UI Automation, searched inside the top-level window
//! under the model's point. A pointer lands on something that exists or says it could not check.
use serde_json::{json, Value};
use windows::Win32::Foundation::{POINT, RECT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationCondition, IUIAutomationElement, IUIAutomationElementArray,
    IUIAutomationExpandCollapsePattern, IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern,
    IUIAutomationTogglePattern, IUIAutomationValuePattern, PropertyConditionFlags_IgnoreCase, TreeScope_Descendants,
    ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded, ToggleState_Off, ToggleState_On,
    UIA_PaneControlTypeId, UIA_WindowControlTypeId, UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId,
    UIA_HyperlinkControlTypeId, UIA_ImageControlTypeId, UIA_ListControlTypeId, UIA_MenuItemControlTypeId,
    UIA_RadioButtonControlTypeId, UIA_TreeControlTypeId,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_DataItemControlTypeId, UIA_DocumentControlTypeId,
    UIA_EditControlTypeId, UIA_ExpandCollapseExpandCollapseStatePropertyId, UIA_ExpandCollapsePatternId,
    UIA_HasKeyboardFocusPropertyId, UIA_InvokePatternId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
    UIA_IsPasswordPropertyId, UIA_ListItemControlTypeId, UIA_LocalizedControlTypePropertyId, UIA_NamePropertyId,
    UIA_SelectionItemIsSelectedPropertyId, UIA_SelectionItemPatternId, UIA_TabItemControlTypeId, UIA_TextControlTypeId,
    UIA_ToggleToggleStatePropertyId, UIA_TogglePatternId, UIA_TreeItemControlTypeId, UIA_ValuePatternId,
    UIA_ValueValuePropertyId, IUIAutomationTextPattern, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start,
    TextUnit_Character, UIA_TextPatternId, UIA_FontSizeAttributeId,
};
use windows::Win32::System::Com::SAFEARRAY;
use windows::Win32::System::Ole::SafeArrayDestroy;
use windows::core::{BOOL, BSTR};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId,
    IsWindow, IsWindowVisible, WindowFromPoint, GA_ROOT, GW_OWNER,
};

const MAX_ELEMENTS: i32 = 4000;
const MIN_SIDE: i32 = 8;

/// Lowercase words, so "Export..." and "export" are the same name.
fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// How well an element's name fits the label: every label word present scores by how little else
/// the name holds. Zero is no match.
pub fn name_score(label: &str, name: &str) -> f32 {
    let wanted = tokens(label);
    let have = tokens(name);
    if wanted.is_empty() || have.is_empty() || !wanted.iter().all(|w| have.contains(w)) {
        return 0.0;
    }
    wanted.len() as f32 / have.len() as f32
}

fn centre(rect: &RECT) -> (f32, f32) {
    ((rect.left + rect.right) as f32 / 2.0, (rect.top + rect.bottom) as f32 / 2.0)
}

struct Snap {
    name: String,
    rect: RECT,
    offscreen: bool,
    kind: String,
    focused: bool,
    /// UIA control type id; 50020 is Text, which is never what a name should be pressed on.
    control: i32,
}

/// One cross-process fetch per element (cached) or five (live). Offscreen is true when unreadable.
unsafe fn snap(element: &IUIAutomationElement, cached: bool) -> Snap {
    if cached {
        Snap {
            name: element.CachedName().map(|n| n.to_string()).unwrap_or_default(),
            rect: element.CachedBoundingRectangle().unwrap_or_default(),
            offscreen: element.CachedIsOffscreen().map(|o| o.as_bool()).unwrap_or(true),
            kind: element.CachedLocalizedControlType().map(|k| k.to_string()).unwrap_or_default(),
            focused: element.CachedHasKeyboardFocus().map(|f| f.as_bool()).unwrap_or(false),
            control: element.CachedControlType().map(|c| c.0).unwrap_or(0),
        }
    } else {
        Snap {
            name: element.CurrentName().map(|n| n.to_string()).unwrap_or_default(),
            rect: element.CurrentBoundingRectangle().unwrap_or_default(),
            offscreen: element.CurrentIsOffscreen().map(|o| o.as_bool()).unwrap_or(true),
            kind: element.CurrentLocalizedControlType().map(|k| k.to_string()).unwrap_or_default(),
            focused: element.CurrentHasKeyboardFocus().map(|f| f.as_bool()).unwrap_or(false),
            control: element.CurrentControlType().map(|c| c.0).unwrap_or(0),
        }
    }
}

/// UFO reads every element's properties in one call (FindAllBuildCache); BATON_UIA_CACHE=0 is the old per-property path.
fn cache_on() -> bool {
    std::env::var("BATON_UIA_CACHE").map(|v| v != "0").unwrap_or(true)
}

unsafe fn descendants(automation: &IUIAutomation, root: &IUIAutomationElement, cached: bool) -> windows::core::Result<IUIAutomationElementArray> {
    search(automation, root, cached, false, &automation.ControlViewCondition()?)
}

/// Only the controls whose whole name is the label, filtered inside the provider: one small answer instead of every
/// element of a big window. A miss falls back to the scored search over everything.
unsafe fn named(automation: &IUIAutomation, root: &IUIAutomationElement, label: &str, cached: bool) -> windows::core::Result<IUIAutomationElementArray> {
    let name = automation.CreatePropertyConditionEx(UIA_NamePropertyId, &VARIANT::from(label), PropertyConditionFlags_IgnoreCase)?;
    let condition = automation.CreateAndCondition(&automation.ControlViewCondition()?, &name)?;
    search(automation, root, cached, false, &condition)
}

/// `rich` also caches what `detail` reads (values and states), which only the tree shows.
unsafe fn cache_request(automation: &IUIAutomation, rich: bool) -> windows::core::Result<IUIAutomationCacheRequest> {
    let request = automation.CreateCacheRequest()?;
    for property in [
        UIA_NamePropertyId,
        UIA_BoundingRectanglePropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_LocalizedControlTypePropertyId,
        UIA_HasKeyboardFocusPropertyId,
        UIA_ControlTypePropertyId,
    ] {
        request.AddProperty(property)?;
    }
    if rich {
        for property in [
            UIA_IsEnabledPropertyId,
            UIA_IsPasswordPropertyId,
            UIA_ValueValuePropertyId,
            UIA_ToggleToggleStatePropertyId,
            UIA_ExpandCollapseExpandCollapseStatePropertyId,
            UIA_SelectionItemIsSelectedPropertyId,
        ] {
            request.AddProperty(property)?;
        }
        for pattern in [UIA_ValuePatternId, UIA_TogglePatternId, UIA_ExpandCollapsePatternId, UIA_SelectionItemPatternId] {
            request.AddPattern(pattern)?;
        }
    }
    Ok(request)
}

unsafe fn search(
    automation: &IUIAutomation,
    root: &IUIAutomationElement,
    cached: bool,
    rich: bool,
    condition: &IUIAutomationCondition,
) -> windows::core::Result<IUIAutomationElementArray> {
    if !cached {
        return root.FindAll(TreeScope_Descendants, condition);
    }
    root.FindAllBuildCache(TreeScope_Descendants, condition, &cache_request(automation, rich)?)
}

/// A value as one short line: control characters become spaces, and a long one keeps its start and its end (where
/// typing usually lands).
pub fn clip(value: &str) -> String {
    let flat: Vec<char> = value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.len() <= 80 {
        return flat.into_iter().collect();
    }
    let head: String = flat[..40].iter().collect();
    let tail: String = flat[flat.len() - 40..].iter().collect();
    format!("{head} … {tail}")
}

/// A box whose name says it holds a secret (a PIN or one-time code box is rarely marked as a password box).
pub fn secret_name(name: &str) -> bool {
    tokens(name).iter().any(|t| t.starts_with("pass") || ["pin", "otp", "cvv", "cvc"].contains(&t.as_str()))
}

/// What a control holds and how it stands: ` = "value"` (never a password box's, nor one named like a secret), then
/// its states.
unsafe fn detail(element: &IUIAutomationElement, cached: bool, name: &str) -> String {
    let mut out = String::new();
    let password = if cached { element.CachedIsPassword() } else { element.CurrentIsPassword() };
    if !password.map(|p| p.as_bool()).unwrap_or(true) && !secret_name(name) {
        let value = if cached {
            element.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).and_then(|p| p.CachedValue())
        } else {
            element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).and_then(|p| p.CurrentValue())
        };
        if let Ok(value) = value {
            let value = value.to_string();
            if !value.trim().is_empty() {
                out.push_str(&format!(" = \"{}\"", clip(&value)));
            }
        }
    }
    let toggle = if cached {
        element.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).and_then(|p| p.CachedToggleState())
    } else {
        element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId).and_then(|p| p.CurrentToggleState())
    };
    match toggle {
        Ok(t) if t == ToggleState_On => out.push_str(" [checked]"),
        Ok(t) if t == ToggleState_Off => out.push_str(" [unchecked]"),
        Ok(_) => out.push_str(" [mixed]"),
        Err(_) => {}
    }
    let expand = if cached {
        element.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).and_then(|p| p.CachedExpandCollapseState())
    } else {
        element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId).and_then(|p| p.CurrentExpandCollapseState())
    };
    match expand {
        Ok(e) if e == ExpandCollapseState_Expanded => out.push_str(" [expanded]"),
        Ok(e) if e == ExpandCollapseState_Collapsed => out.push_str(" [collapsed]"),
        _ => {}
    }
    let selected = if cached {
        element.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).and_then(|p| p.CachedIsSelected())
    } else {
        element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).and_then(|p| p.CurrentIsSelected())
    };
    if selected.map(|s| s.as_bool()).unwrap_or(false) {
        out.push_str(" [selected]");
    }
    let enabled = if cached { element.CachedIsEnabled() } else { element.CurrentIsEnabled() };
    if !enabled.map(|e| e.as_bool()).unwrap_or(true) {
        out.push_str(" [disabled]");
    }
    out
}

/// The best-named element of `all` for the label, nearest the point among equals, and how many were read.
unsafe fn best_of(all: &IUIAutomationElementArray, label: &str, x: i32, y: i32, cached: bool) -> windows::core::Result<(Option<Found>, i32)> {
    let count = all.Length()?.min(MAX_ELEMENTS);
    let mut best: Option<(f32, Found)> = None;
    for i in 0..count {
        let Ok(element) = all.GetElement(i) else { continue };
        let s = snap(&element, cached);
        let score = name_score(label, &s.name);
        if score == 0.0 || s.offscreen {
            continue;
        }
        // A window's own 1 px title element has the right name and is nothing to point at.
        if s.rect.right - s.rect.left < MIN_SIDE || s.rect.bottom - s.rect.top < MIN_SIDE {
            continue;
        }
        let (cx, cy) = centre(&s.rect);
        let distance = ((cx - x as f32).powi(2) + (cy - y as f32).powi(2)).sqrt();
        // Name first; among equals the one nearest the model's point.
        // A display that shows "1" is not the button "1": static text ranks below any control of the same name.
        let rank = score * 10_000.0 - distance - if s.control == UIA_TextControlTypeId.0 { 5_000.0 } else { 0.0 };
        if best.as_ref().map(|(r, _)| rank > *r).unwrap_or(true) {
            best = Some((rank, Found { name: s.name, rect: s.rect, element }));
        }
    }
    Ok((best.map(|(_, f)| f), count))
}

struct Found {
    name: String,
    rect: RECT,
    element: IUIAutomationElement,
}

/// The element under the model's point, or an ancestor of it, when it carries the label.
unsafe fn at_point(automation: &IUIAutomation, label: &str, x: i32, y: i32) -> windows::core::Result<Option<Found>> {
    let walker = automation.ControlViewWalker()?;
    let mut element = automation.ElementFromPoint(POINT { x, y })?;
    for _ in 0..4 {
        let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        let rect = element.CurrentBoundingRectangle().unwrap_or_default();
        if name_score(label, &name) > 0.0 && rect.right - rect.left >= MIN_SIDE && rect.bottom - rect.top >= MIN_SIDE {
            return Ok(Some(Found { name, rect, element }));
        }
        // The top of the tree answers with no element, which is simply the end of the walk.
        let Ok(parent) = walker.GetParentElement(&element) else { break };
        element = parent;
    }
    Ok(None)
}

/// The name of what is on top at the element's centre when that is not the element or inside it; None when a click
/// there reaches the element (or the hit test cannot tell, which counts as reachable).
unsafe fn covered_by(automation: &IUIAutomation, element: &IUIAutomationElement, rect: &RECT) -> Option<String> {
    let (cx, cy) = centre(rect);
    let walker = automation.ControlViewWalker().ok()?;
    let top = automation.ElementFromPoint(POINT { x: cx as i32, y: cy as i32 }).ok()?;
    let mut hit = top.clone();
    for _ in 0..8 {
        if automation.CompareElements(&hit, element).map(|b| b.as_bool()).unwrap_or(false) {
            return None;
        }
        let Ok(parent) = walker.GetParentElement(&hit) else { break };
        hit = parent;
    }
    let name = top.CurrentName().map(|n| n.to_string()).unwrap_or_default();
    Some(if name.is_empty() { "another window".to_string() } else { name })
}

/// The first visible top-level window whose title contains `title` (case-insensitive): a window to work on without
/// bringing it forward.
pub fn find_window(title: &str) -> Option<HWND> {
    struct Search {
        want: String,
        found: Option<HWND>,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
        if String::from_utf16_lossy(&buf[..n]).to_lowercase().contains(&search.want) {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }
    let mut search = Search { want: title.to_lowercase(), found: None };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

/// A control acted on by its own pattern, with no pointer and no focus change. Invoke on a list item opens it (a
/// double click), so items are only ever selected; None means a plain click is the right action.
unsafe fn act(element: &IUIAutomationElement) -> Option<&'static str> {
    let kind = element.CurrentControlType().map(|k| k.0).unwrap_or(0);
    if [UIA_ListItemControlTypeId, UIA_DataItemControlTypeId, UIA_TreeItemControlTypeId, UIA_TabItemControlTypeId]
        .iter()
        .any(|k| k.0 == kind)
    {
        let p = element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId).ok()?;
        return p.Select().ok().map(|_| "select");
    }
    if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
        return p.Invoke().ok().map(|_| "invoke");
    }
    if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
        return p.Toggle().ok().map(|_| "toggle");
    }
    if let Ok(p) = element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
        return p.Expand().ok().map(|_| "expand");
    }
    // A text box is clicked to put the keyboard in it: its own focus does that without the pointer.
    if kind == UIA_EditControlTypeId.0 || kind == UIA_DocumentControlTypeId.0 {
        return element.SetFocus().ok().map(|_| "focus");
    }
    None
}

/// A click by position without the pointer: the control at the point, or the nearest of two ancestors that is not a
/// whole pane or window, acted on by its own pattern. found: false means only a real click can do it.
unsafe fn press_at(automation: &IUIAutomation, x: i32, y: i32) -> windows::core::Result<Value> {
    let walker = automation.ControlViewWalker()?;
    let mut element = automation.ElementFromPoint(POINT { x, y })?;
    for _ in 0..3 {
        let kind = element.CurrentControlType().map(|k| k.0).unwrap_or(0);
        if kind == UIA_PaneControlTypeId.0 || kind == UIA_WindowControlTypeId.0 {
            break;
        }
        if let Some(how) = act(&element) {
            let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
            let rect = element.CurrentBoundingRectangle().unwrap_or_default();
            return Ok(json!({
                "found": true, "name": name, "invoked": how,
                "x": (rect.left + rect.right) / 2, "y": (rect.top + rect.bottom) / 2,
                "state": detail(&element, false, &name).trim(),
            }));
        }
        let Ok(parent) = walker.GetParentElement(&element) else { break };
        element = parent;
    }
    Ok(json!({"found": false}))
}

/// Physical pixels in and out. `found: false` means the tree has no such element. `foreground`
/// searches the window with the keyboard, wherever the pointer is; otherwise the window under (x, y). `reference` is a
/// line number of the last tree instead of a label: found only while that control still has its name and place.
pub fn locate(label: &str, x: i32, y: i32, foreground: bool, window: Option<&str>, invoke: bool, reference: Option<(u64, usize)>) -> Result<Value, String> {
    if !invoke {
        return locate_here(label, x, y, foreground, window, false, reference);
    }
    // Invoke can block while a modal dialog it opens is up, so it runs apart and is reported pending after two seconds.
    let (tx, rx) = std::sync::mpsc::channel();
    let (label_owned, window_owned) = (label.to_string(), window.map(str::to_string));
    std::thread::spawn(move || {
        let _ = tx.send(locate_here(&label_owned, x, y, foreground, window_owned.as_deref(), true, reference));
    });
    match rx.recv_timeout(std::time::Duration::from_millis(2000)) {
        Ok(done) => done,
        Err(_) => Ok(json!({"found": true, "name": label, "invoked": "pending"})),
    }
}

/// The listed control behind a line number of the numbered tree `tree`, or None when that tree is no longer the
/// last numbered one (another caller numbered a list since) or has no such line.
fn listed((tree, line): (u64, usize)) -> Option<(String, RECT, isize)> {
    let kept = LISTED.lock().ok()?;
    if kept.0 != tree {
        return None;
    }
    kept.1.get(line.checked_sub(1)?).map(|l| (l.name.clone(), l.rect, l.window))
}

/// The control found for a line number must still be where the line said, or it is another control of the same name.
fn same_place(listed: &RECT, found: &RECT) -> bool {
    let (x, y) = centre(found);
    x >= listed.left as f32 - 4.0 && x <= listed.right as f32 + 4.0 && y >= listed.top as f32 - 4.0 && y <= listed.bottom as f32 + 4.0
}

fn locate_here(label: &str, x: i32, y: i32, foreground: bool, window: Option<&str>, invoke: bool, reference: Option<(u64, usize)>) -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    let cached = cache_on();
    let line = match reference {
        Some(n) => match listed(n) {
            Some(line) => Some(line),
            None => return Ok(json!({"found": false, "stale": true})),
        },
        None => None,
    };
    // No name and no line: the model clicked a point it saw, so the control there is pressed in place.
    if invoke && line.is_none() && label.trim().is_empty() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
            return press_at(&automation, x, y).map_err(err);
        }
    }
    let (label, x, y) = match &line {
        Some((name, rect, _)) => (name.as_str(), centre(rect).0 as i32, centre(rect).1 as i32),
        None => (label, x, y),
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let top = if let Some((_, _, listed_in)) = &line {
            let hwnd = HWND(*listed_in as *mut _);
            if !IsWindow(Some(hwnd)).as_bool() {
                return Ok(json!({"found": false, "stale": true}));
            }
            hwnd
        } else if let Some(title) = window {
            find_window(title).ok_or_else(|| format!("No window is titled like \"{title}\"."))?
        } else if foreground {
            GetForegroundWindow()
        } else {
            GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT)
        };
        // 0x80040201 can come from the window or any one provider in it, and fails the whole
        // search, so ask for the element at the point instead.
        let searched = automation.ElementFromHandle(top).and_then(|root| {
            if let Ok((Some(found), count)) = named(&automation, &root, label, cached).and_then(|all| best_of(&all, label, x, y, cached)) {
                return Ok((Some(found), count));
            }
            descendants(&automation, &root, cached).and_then(|all| best_of(&all, label, x, y, cached))
        });
        let (found, count) = match searched {
            Ok(done) => done,
            Err(whole) => (
                at_point(&automation, label, x, y)
                    .map_err(|inner| format!("{whole}; at the point: {inner}"))?,
                1,
            ),
        };
        if let Some((_, rect, _)) = &line {
            if !found.as_ref().is_some_and(|f| same_place(rect, &f.rect)) {
                return Ok(json!({"found": false, "stale": true, "elements": count}));
            }
        }
        Ok(match found {
            Some(f) => {
                let mut out = json!({
                    "found": true, "name": f.name, "elements": count,
                    "x": (f.rect.left + f.rect.right) / 2, "y": (f.rect.top + f.rect.bottom) / 2,
                    "width": f.rect.right - f.rect.left, "height": f.rect.bottom - f.rect.top,
                });
                // A control acted on by its pattern needs no clear spot to click, so only a click can be covered.
                if invoke {
                    if let Some(how) = act(&f.element) {
                        out["invoked"] = json!(how);
                        // A press does not move the keyboard, so the control's own state is the evidence it worked.
                        out["state"] = json!(detail(&f.element, false, &f.name).trim());
                        return Ok(out);
                    }
                }
                if let Some(by) = covered_by(&automation, &f.element, &f.rect) {
                    out["covered_by"] = json!(by);
                }
                out
            }
            None => json!({"found": false, "elements": count}),
        })
    }
}

/// Text added to a box in a window by its UI Automation value, with no keyboard, clipboard or focus change: the box
/// with the keyboard in that window, else its first editable text box. It is added at the end of what the box holds.
pub fn set_value(window: &str, text: &str) -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let top = find_window(window).ok_or_else(|| format!("No window is titled like \"{window}\"."))?;
        let root = automation.ElementFromHandle(top).map_err(err)?;
        let all = descendants(&automation, &root, false).map_err(err)?;
        let count = all.Length().map_err(err)?.min(MAX_ELEMENTS);
        let mut pick: Option<(IUIAutomationValuePattern, String)> = None;
        for i in 0..count {
            let Ok(element) = all.GetElement(i) else { continue };
            let kind = element.CurrentControlType().map(|k| k.0).unwrap_or(0);
            if kind != UIA_EditControlTypeId.0 && kind != UIA_DocumentControlTypeId.0 {
                continue;
            }
            let Ok(value) = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) else { continue };
            if value.CurrentIsReadOnly().map(|r| r.as_bool()).unwrap_or(true) {
                continue;
            }
            let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
            let focused = element.CurrentHasKeyboardFocus().map(|f| f.as_bool()).unwrap_or(false);
            if focused || pick.is_none() {
                pick = Some((value, name));
            }
            if focused {
                break;
            }
        }
        let Some((value, name)) = pick else { return Ok(json!({"set": false})) };
        let before = value.CurrentValue().map(|v| v.to_string()).unwrap_or_default();
        value.SetValue(&BSTR::from(format!("{before}{text}"))).map_err(err)?;
        Ok(json!({"set": true, "name": name}))
    }
}

/// A line of the last tree, so the model can name a control by its number: what it was called, where it was and in
/// which window. Plain data, so any command thread can read it.
struct Listed {
    name: String,
    rect: RECT,
    window: isize,
}

/// The last numbered tree: its id and its lines. Only a tree read for the model is numbered and kept, so an internal
/// read (a window check, a browser route) never renumbers what the model is looking at.
static LISTED: std::sync::Mutex<(u64, Vec<Listed>)> = std::sync::Mutex::new((0, Vec::new()));

/// The visible popups a window has open (menus, flyouts, owned dialogs): their own top-level windows on its thread.
fn popups_of(top: HWND) -> Vec<HWND> {
    struct Search {
        top: HWND,
        thread: u32,
        found: Vec<HWND>,
    }
    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam.0 as *mut Search);
        if hwnd == search.top || !IsWindowVisible(hwnd).as_bool() || GetWindowThreadProcessId(hwnd, None) != search.thread {
            return BOOL(1);
        }
        let mut class = [0u16; 16];
        let n = GetClassNameW(hwnd, &mut class).max(0) as usize;
        let menu = String::from_utf16_lossy(&class[..n]) == "#32768";
        if menu || GetWindow(hwnd, GW_OWNER).map(|owner| owner == search.top).unwrap_or(false) {
            search.found.push(hwnd);
        }
        BOOL(1)
    }
    unsafe {
        let mut search = Search { top, thread: GetWindowThreadProcessId(top, None), found: Vec::new() };
        if search.thread != 0 {
            let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }
}

/// What the keyboard's window and its open popups offer, one numbered line per named control with its value and
/// states: the agent reads this before it takes a screenshot, and clicks a line by its number with `locate`. No
/// coordinates leave here; the numbers stay in the sidecar until the next tree. `find` keeps only names that contain it.
pub fn tree(max: usize, window: Option<&str>, find: Option<&str>, numbered: bool) -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    let cached = cache_on();
    let want = find.map(|f| f.trim().to_lowercase()).filter(|f| !f.is_empty());
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let top = match window {
            Some(title) => find_window(title).ok_or_else(|| format!("No window is titled like \"{title}\"."))?,
            None => GetForegroundWindow(),
        };
        let root = automation.ElementFromHandle(top).map_err(err)?;
        let title = root.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        let (mut lines, mut listed, mut shown, mut read) = (Vec::new(), Vec::new(), 0usize, 0);
        let mut last = String::new();
        for hwnd in std::iter::once(top).chain(popups_of(top)) {
            let all = match automation.ElementFromHandle(hwnd).and_then(|r| search(&automation, &r, cached, true, &automation.ControlViewCondition()?)) {
                Ok(all) => all,
                Err(e) if hwnd == top => return Err(err(e)),
                Err(_) => continue,
            };
            let count = all.Length().map_err(err)?.min(MAX_ELEMENTS);
            read += count;
            for i in 0..count {
                let Ok(element) = all.GetElement(i) else { continue };
                let s = snap(&element, cached);
                let name = s.name.trim();
                if name.is_empty() || s.offscreen {
                    continue;
                }
                if s.rect.right - s.rect.left < MIN_SIDE || s.rect.bottom - s.rect.top < MIN_SIDE {
                    continue;
                }
                if want.as_ref().is_some_and(|w| !name.to_lowercase().contains(w)) {
                    continue;
                }
                let body = format!(
                    "{}: {}{}{}",
                    s.kind,
                    name.chars().take(80).collect::<String>(),
                    detail(&element, cached, &s.name),
                    if s.focused { " (focused)" } else { "" }
                );
                if body == last {
                    continue;
                }
                shown += 1;
                if lines.len() < max {
                    lines.push(if numbered { format!("[{}] {body}", lines.len() + 1) } else { body.clone() });
                    listed.push(Listed { name: s.name.clone(), rect: s.rect, window: hwnd.0 as isize });
                }
                last = body;
            }
        }
        let mut out = json!({"window": title, "controls": lines, "total": read, "shown": shown});
        if numbered {
            if let Ok(mut kept) = LISTED.lock() {
                let id = kept.0 + 1;
                *kept = (id, listed);
                out["tree"] = json!(id);
            }
        }
        Ok(out)
    }
}

/// Where the keyboard is now, as one cheap read after an action: the window's title and the focused control's line.
/// With `window`, that window and the control inside it that has the keyboard.
pub fn focus_state(window: Option<&str>) -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let top = match window {
            Some(title) => find_window(title).ok_or_else(|| format!("No window is titled like \"{title}\"."))?,
            None => GetForegroundWindow(),
        };
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(top, &mut buf).max(0) as usize;
        let title = String::from_utf16_lossy(&buf[..n]);
        let request = cache_request(&automation, true).map_err(err)?;
        let focused = match window {
            None => automation.GetFocusedElementBuildCache(&request),
            Some(_) => automation.ElementFromHandle(top).and_then(|root| {
                let has = automation.CreatePropertyCondition(UIA_HasKeyboardFocusPropertyId, &VARIANT::from(true))?;
                root.FindFirstBuildCache(TreeScope_Descendants, &has, &request)
            }),
        };
        let focus = focused.ok().map(|element| {
            let s = snap(&element, true);
            format!("{}: {}{}", s.kind, s.name.trim().chars().take(80).collect::<String>(), detail(&element, true, &s.name))
        });
        Ok(json!({"window": title, "handle": top.0 as isize, "focus": focus}))
    }
}

/// The focused field is a password box or named like a secret: the rule `detail` keeps. A field that will not say
/// whether it is a password box counts as one. Runs on its own thread, with its own STA, never on the helper's loop.
pub fn focused_is_secret() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(automation) => automation,
            Err(_) => return false,
        };
        let Ok(element) = automation.GetFocusedElement() else { return false };
        let password = element.CurrentIsPassword().map(|p| p.as_bool()).unwrap_or(true);
        let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        password || secret_name(&name)
    }
}

/// The keyboard is on something that takes no typing: Explorer's or the desktop's icons, a list, a tree, a button. A
/// paste there does nothing (or pastes files), so the words go on the clipboard with a card instead. Anything that might
/// take text stays a box: an edit, a document, a text pattern, a writable value, and any pane, window or custom
/// control, which is how editors that draw their own text show up.
pub fn focused_takes_no_text() -> bool {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(automation) => automation,
            Err(_) => return false,
        };
        let Ok(element) = automation.GetFocusedElement() else { return false };
        let kind = element.CurrentControlType().map(|k| k.0).unwrap_or(0);
        if element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).is_ok() {
            return false;
        }
        let writable = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|v| v.CurrentIsReadOnly())
            .is_ok_and(|read_only| !read_only.as_bool());
        !writable
            && [
                UIA_ListControlTypeId,
                UIA_ListItemControlTypeId,
                UIA_TreeControlTypeId,
                UIA_TreeItemControlTypeId,
                UIA_DataItemControlTypeId,
                UIA_ButtonControlTypeId,
                UIA_MenuItemControlTypeId,
                UIA_TabItemControlTypeId,
                UIA_HyperlinkControlTypeId,
                UIA_ImageControlTypeId,
                UIA_CheckBoxControlTypeId,
                UIA_RadioButtonControlTypeId,
            ]
            .iter()
            .any(|t| t.0 == kind)
    }
}

/// The words either side of the caret in the focused field, as the desktop's PowerShell read did, without starting
/// PowerShell (300 ms or more) for each dictation. Null when the field does not say.
pub fn caret_context(chars: i32) -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let element = automation.GetFocusedElement().map_err(err)?;
        // A password box, or one named like a secret, is never read: the rule `detail` keeps.
        let password = element.CurrentIsPassword().map(|p| p.as_bool()).unwrap_or(true);
        let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        if password || secret_name(&name) {
            return Ok(json!({"before": null, "after": null}));
        }
        let around = (|| -> windows::core::Result<Option<(String, String)>> {
            let pattern = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)?;
            let selection = pattern.GetSelection()?;
            if selection.Length()? == 0 {
                return Ok(None);
            }
            let range = selection.GetElement(0)?;
            let before = range.Clone()?;
            before.MoveEndpointByRange(TextPatternRangeEndpoint_End, &range, TextPatternRangeEndpoint_Start)?;
            before.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -chars)?;
            let after = range.Clone()?;
            after.MoveEndpointByRange(TextPatternRangeEndpoint_Start, &range, TextPatternRangeEndpoint_End)?;
            after.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, chars)?;
            Ok(Some((before.GetText(chars)?.to_string(), after.GetText(chars)?.to_string())))
        })()
        .ok()
        .flatten();
        if let Some((before, after)) = around {
            return Ok(json!({"before": before, "after": after}));
        }
        // An empty field with no text pattern still says so through its value.
        let empty = element
            .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|v| v.CurrentValue())
            .is_ok_and(|v| v.is_empty());
        Ok(if empty { json!({"before": "", "after": ""}) } else { json!({"before": null, "after": null}) })
    }
}

/// The first box of a text range, in physical screen pixels; the array is freed here.
unsafe fn first_box(array: *mut SAFEARRAY) -> Option<(f64, f64, f64, f64)> {
    if array.is_null() {
        return None;
    }
    let a = &*array;
    let found = if a.rgsabound[0].cElements >= 4 && !a.pvData.is_null() {
        let d = std::slice::from_raw_parts(a.pvData as *const f64, 4);
        Some((d[0], d[1], d[2], d[3]))
    } else {
        None
    };
    let _ = SafeArrayDestroy(array);
    found.filter(|b| b.3 > 0.0)
}

/// The caret's box, the field's box (physical px) and the font size (points, 0 when the field does not say), for
/// the words to be drawn where they will land. A password box, or one named like a secret, gives nothing.
pub fn caret_geometry() -> Result<Value, String> {
    let err = |e: windows::core::Error| e.to_string();
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(err)?;
        let element = automation.GetFocusedElement().map_err(err)?;
        let password = element.CurrentIsPassword().map(|p| p.as_bool()).unwrap_or(true);
        let name = element.CurrentName().map(|n| n.to_string()).unwrap_or_default();
        if password || secret_name(&name) {
            return Ok(json!({"caret": null}));
        }
        let field = element.CurrentBoundingRectangle().map_err(err)?;
        let found = (|| -> windows::core::Result<Option<((f64, f64, f64, f64), f64)>> {
            let pattern = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)?;
            let selection = pattern.GetSelection()?;
            if selection.Length()? == 0 {
                return Ok(None);
            }
            let range = selection.GetElement(0)?;
            let mut caret = first_box(range.GetBoundingRectangles()?);
            if caret.is_none() {
                // A collapsed caret has no box in most fields; the character before it does, and the caret is its right edge.
                let before = range.Clone()?;
                before.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -1)?;
                caret = first_box(before.GetBoundingRectangles()?).map(|(x, y, w, h)| (x + w, y, 0.0, h));
            }
            let Some(caret) = caret else { return Ok(None) };
            let size = range.GetAttributeValue(UIA_FontSizeAttributeId).ok().and_then(|v| f64::try_from(&v).ok()).unwrap_or(0.0);
            Ok(Some((caret, size)))
        })()
        .ok()
        .flatten();
        let Some(((x, y, w, h), size)) = found else { return Ok(json!({"caret": null})) };
        Ok(json!({
            "caret": {"x": x, "y": y, "width": w, "height": h},
            "field": {"x": field.left, "y": field.top, "width": field.right - field.left, "height": field.bottom - field.top},
            "fontPt": size,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{clip, listed, name_score, secret_name, Listed, LISTED};
    use windows::Win32::Foundation::RECT;

    #[test]
    fn a_line_number_holds_only_for_the_tree_that_gave_it() {
        *LISTED.lock().unwrap() = (7, vec![Listed { name: "Save".into(), rect: RECT::default(), window: 1 }]);
        assert_eq!(listed((7, 1)).map(|l| l.0), Some("Save".to_string()));
        assert!(listed((6, 1)).is_none());
        assert!(listed((7, 2)).is_none());
        assert!(listed((7, 0)).is_none());
    }

    #[test]
    fn boxes_named_like_secrets_hide_their_value() {
        assert!(secret_name("Password"));
        assert!(secret_name("Enter PIN"));
        assert!(secret_name("OTP code"));
        assert!(secret_name("CVV"));
        assert!(!secret_name("Shopping list"));
        assert!(!secret_name("Spinner"));
        assert!(!secret_name("File name"));
    }

    #[test]
    fn a_long_value_keeps_its_start_and_end_on_one_line() {
        assert_eq!(clip("a\r\nb"), "a  b");
        let long = format!("{}{}", "x".repeat(60), "y".repeat(60));
        assert_eq!(clip(&long), format!("{} … {}", "x".repeat(40), "y".repeat(40)));
    }

    #[test]
    fn matches_whole_words_and_prefers_the_tighter_name() {
        assert_eq!(name_score("export", "Important"), 0.0);
        assert!(name_score("export", "Export") > name_score("export", "Export as PDF"));
        assert!(name_score("Export button", "Export") == 0.0);
    }
}
