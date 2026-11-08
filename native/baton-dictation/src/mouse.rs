//! The click and chord rules of Baton's mouse hook. Pure, so they run (and are tested) on any
//! platform; `mouse_windows.rs` feeds them from a low-level hook. Mirrors `reduceMouse` in
//! `packages/baton-shared/src/inputBindings.ts`: the vectors in the tests below are the same ones.
//! The promise: an unbound button always reaches the app untouched, and a chord never leaks a click.

use serde_json::Value;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Button {
    Left,
    Right,
    Middle,
    X1,
    X2,
}

impl Button {
    fn parse(name: &str) -> Option<Button> {
        Some(match name {
            "left" => Button::Left,
            "right" => Button::Right,
            "middle" => Button::Middle,
            "x1" => Button::X1,
            "x2" => Button::X2,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug)]
pub enum Trigger {
    Button(Button),
    Chord(Vec<Button>),
}

#[derive(Clone, Debug)]
pub struct Binding {
    pub id: String,
    pub trigger: Trigger,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bindings: Vec<Binding>,
    pub window_ms: u64,
}

impl Config {
    /// `input-bindings.json` as the desktop writes it. Keys are the keyboard hook's, not ours.
    pub fn parse(value: &Value) -> Config {
        let window_ms = value["chordWindowMs"].as_u64().filter(|w| (20..=120).contains(w)).unwrap_or(50);
        let bindings = value["bindings"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|b| {
                        let id = b["id"].as_str()?.to_string();
                        let t = &b["trigger"];
                        let trigger = match t["kind"].as_str()? {
                            "button" => Trigger::Button(Button::parse(t["button"].as_str()?)?),
                            "chord" => {
                                let buttons: Vec<Button> = t["buttons"]
                                    .as_array()?
                                    .iter()
                                    .filter_map(|n| Button::parse(n.as_str()?))
                                    .collect();
                                if buttons.len() < 2 {
                                    return None;
                                }
                                Trigger::Chord(buttons)
                            }
                            _ => return None,
                        };
                        // Plain left or right alone is never bound: it is how every app is used.
                        match &trigger {
                            Trigger::Button(Button::Left | Button::Right) => None,
                            _ => Some(Binding { id, trigger }),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        Config { bindings, window_ms }
    }

    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty()
    }

    fn chords(&self) -> impl Iterator<Item = (&str, &Vec<Button>)> {
        self.bindings.iter().filter_map(|b| match &b.trigger {
            Trigger::Chord(buttons) => Some((b.id.as_str(), buttons)),
            _ => None,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Ev {
    Down(Button, u64),
    Up(Button, u64),
    Tick(u64),
}

#[derive(Clone, PartialEq, Debug)]
pub enum Action {
    /// Let the event reach the app.
    Pass,
    /// Swallow the event.
    Consume,
    /// A binding fired.
    Fire(String),
    /// A single-button binding's button came back up, so "hold to dictate" can end when he lets go.
    Release(String),
    /// Send a press the hook held back, now.
    ReplayDown(Button),
}

#[derive(Default, Debug)]
pub struct State {
    held: Option<(Button, u64)>,
    swallow_up: Vec<Button>,
    down: Vec<Button>,
}

pub fn reduce(state: &mut State, ev: Ev, cfg: &Config) -> Vec<Action> {
    let mut actions = Vec::new();
    let t = match ev {
        Ev::Down(_, t) | Ev::Up(_, t) | Ev::Tick(t) => t,
    };
    if let Some((button, at)) = state.held {
        if t.saturating_sub(at) >= cfg.window_ms {
            actions.push(Action::ReplayDown(button));
            state.down.push(button);
            state.held = None;
        }
    }
    match ev {
        Ev::Tick(_) => {}
        Ev::Down(button, t) => {
            if let Some(single) = cfg.bindings.iter().find(|b| matches!(&b.trigger, Trigger::Button(x) if *x == button)) {
                state.swallow_up.push(button);
                actions.push(Action::Fire(single.id.clone()));
                actions.push(Action::Consume);
                return actions;
            }
            if let Some((held, _)) = state.held {
                if held != button {
                    if let Some((id, _)) = cfg.chords().find(|(_, b)| b.contains(&held) && b.contains(&button)) {
                        state.swallow_up.push(held);
                        state.swallow_up.push(button);
                        state.held = None;
                        actions.push(Action::Fire(id.to_string()));
                        actions.push(Action::Consume);
                        return actions;
                    }
                }
            }
            let starts_chord = state.held.is_none()
                && cfg.chords().any(|(_, b)| b.contains(&button) && !b.iter().any(|o| state.down.contains(o)));
            if starts_chord {
                state.held = Some((button, t));
                actions.push(Action::Consume);
                return actions;
            }
            state.down.push(button);
            actions.push(Action::Pass);
        }
        Ev::Up(button, _) => {
            if let Some(i) = state.swallow_up.iter().position(|b| *b == button) {
                state.swallow_up.remove(i);
                if let Some(single) = cfg.bindings.iter().find(|b| matches!(&b.trigger, Trigger::Button(x) if *x == button)) {
                    actions.push(Action::Release(single.id.clone()));
                }
                actions.push(Action::Consume);
                return actions;
            }
            if matches!(state.held, Some((held, _)) if held == button) {
                // Released inside the window: a plain click, press then release, in order.
                state.held = None;
                actions.push(Action::ReplayDown(button));
                actions.push(Action::Pass);
                return actions;
            }
            state.down.retain(|b| *b != button);
            actions.push(Action::Pass);
        }
    }
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(bindings: Value) -> Config {
        Config::parse(&json!({ "bindings": bindings }))
    }
    fn middle() -> Config {
        config(json!([{ "id": "m", "trigger": { "kind": "button", "button": "middle" } }]))
    }
    fn chord() -> Config {
        config(json!([{ "id": "c", "trigger": { "kind": "chord", "buttons": ["left", "right"] } }]))
    }
    fn run(cfg: &Config, events: &[Ev]) -> Vec<Vec<Action>> {
        let mut state = State::default();
        events.iter().map(|e| reduce(&mut state, *e, cfg)).collect()
    }
    use Action::*;
    use Button::*;
    use Ev::*;

    #[test]
    fn unbound_middle_passes_and_bound_middle_is_taken() {
        let events = [Down(Middle, 0), Up(Middle, 30)];
        assert_eq!(run(&config(json!([])), &events), vec![vec![Pass], vec![Pass]]);
        assert_eq!(
            run(&middle(), &events),
            vec![vec![Fire("m".into()), Consume], vec![Release("m".into()), Consume]]
        );
    }

    #[test]
    fn a_bound_back_or_forward_button_fires_and_releases_and_others_pass() {
        let cfg = config(json!([
            {"id": "hold", "trigger": {"kind": "button", "button": "x1"}},
            {"id": "toggle", "trigger": {"kind": "button", "button": "x2"}}
        ]));
        assert_eq!(
            run(&cfg, &[Down(X1, 0), Up(X1, 400)]),
            vec![vec![Fire("hold".into()), Consume], vec![Release("hold".into()), Consume]]
        );
        assert_eq!(run(&cfg, &[Down(X2, 0)]), vec![vec![Fire("toggle".into()), Consume]]);
        // Middle-click is not bound here, so it reaches the app untouched.
        assert_eq!(run(&cfg, &[Down(Middle, 0), Up(Middle, 30)]), vec![vec![Pass], vec![Pass]]);
    }

    #[test]
    fn no_chord_bound_means_no_delay() {
        let events = [Down(Left, 0), Up(Left, 90), Down(Right, 200), Up(Right, 260)];
        assert_eq!(run(&middle(), &events), vec![vec![Pass], vec![Pass], vec![Pass], vec![Pass]]);
    }

    #[test]
    fn chord_inside_the_window_fires_with_no_stray_click() {
        let events = [Down(Left, 0), Down(Right, 35), Up(Left, 200), Up(Right, 210)];
        assert_eq!(
            run(&chord(), &events),
            vec![vec![Consume], vec![Fire("c".into()), Consume], vec![Consume], vec![Consume]]
        );
    }

    #[test]
    fn a_held_press_is_replayed_when_no_second_comes_and_a_quick_click_keeps_its_order() {
        assert_eq!(
            run(&chord(), &[Down(Left, 0), Tick(60), Up(Left, 400)]),
            vec![vec![Consume], vec![ReplayDown(Left)], vec![Pass]]
        );
        assert_eq!(
            run(&chord(), &[Down(Right, 0), Up(Right, 20)]),
            vec![vec![Consume], vec![ReplayDown(Right), Pass]]
        );
    }

    #[test]
    fn a_second_press_after_the_window_is_no_chord_and_drag_select_survives() {
        assert_eq!(
            run(&chord(), &[Down(Left, 0), Down(Right, 80), Up(Right, 90), Up(Left, 500)]),
            vec![vec![Consume], vec![ReplayDown(Left), Pass], vec![Pass], vec![Pass]]
        );
    }

    #[test]
    fn plain_left_or_right_is_never_bound() {
        let cfg = config(json!([{ "id": "x", "trigger": { "kind": "button", "button": "left" } }]));
        assert!(cfg.is_empty());
    }
}
