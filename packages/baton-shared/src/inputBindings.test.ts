import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_BINDINGS,
  IDLE_MOUSE,
  parseInputBindings,
  reduceMouse,
  type MouseAction,
  type MouseEvent,
} from "./inputBindings.ts";

const middle = parseInputBindings({
  bindings: [{ id: "m", action: "listen_start", trigger: { kind: "button", button: "middle" } }],
});
const chord = parseInputBindings({
  bindings: [
    { id: "c", action: "listen_start", trigger: { kind: "chord", buttons: ["right", "left"] } },
  ],
});

/** Feeds events and returns what happened to each, as short strings: the vectors the sidecar port must meet. */
const run = (cfg: typeof chord, events: ReadonlyArray<MouseEvent>) => {
  let state = IDLE_MOUSE;
  return events.map((event) => {
    const step = reduceMouse(state, event, cfg);
    state = step.state;
    return step.actions.map((a: MouseAction) =>
      a.kind === "fire"
        ? `fire:${a.id}`
        : a.kind === "release"
          ? `release:${a.id}`
          : a.kind === "replay_down"
            ? `replay:${a.button}`
            : a.kind,
    );
  });
};

describe("bindings file", () => {
  it("keeps good bindings, refuses plain left or right, and normalises a chord", () => {
    const cfg = parseInputBindings({
      chordWindowMs: 500,
      bindings: [
        { id: "a", action: "mute", trigger: { kind: "button", button: "left" } },
        { id: "b", action: "ask", trigger: { kind: "chord", buttons: ["right", "left"] } },
        { id: "b2", action: "dictate", trigger: { kind: "chord", buttons: ["left", "right"] } },
        { id: "k", action: "dictate", trigger: { kind: "key", accelerator: "Ctrl+Alt+D" } },
        { id: "x", action: "nope", trigger: { kind: "button", button: "middle" } },
      ],
    });
    expect(cfg.bindings.map((b) => b.id)).toEqual(["b", "k"]);
    expect(cfg.bindings[0]!.trigger).toEqual({ kind: "chord", buttons: ["left", "right"] });
    expect(cfg.chordWindowMs).toBe(50);
    expect(parseInputBindings("junk")).toEqual(EMPTY_BINDINGS);
  });
});

describe("the mouse reducer", () => {
  it("lets an unbound middle click through, and takes a bound one", () => {
    const events: MouseEvent[] = [
      { type: "down", t: 0, button: "middle" },
      { type: "up", t: 30, button: "middle" },
    ];
    expect(run(EMPTY_BINDINGS, events)).toEqual([["pass"], ["pass"]]);
    // Its release is reported too, so a button held to dictate ends when he lets go.
    expect(run(middle, events)).toEqual([
      ["fire:m", "consume"],
      ["release:m", "consume"],
    ]);
  });

  it("passes every click at once when no chord is bound, so nothing is delayed", () => {
    expect(
      run(middle, [
        { type: "down", t: 0, button: "left" },
        { type: "up", t: 90, button: "left" },
        { type: "down", t: 200, button: "right" },
        { type: "up", t: 260, button: "right" },
      ]),
    ).toEqual([["pass"], ["pass"], ["pass"], ["pass"]]);
  });

  it("fires on both buttons inside the window, with no stray click before or after", () => {
    expect(
      run(chord, [
        { type: "down", t: 0, button: "left" },
        { type: "down", t: 35, button: "right" },
        { type: "up", t: 200, button: "left" },
        { type: "up", t: 210, button: "right" },
      ]),
    ).toEqual([["consume"], ["fire:c", "consume"], ["consume"], ["consume"]]);
  });

  it("replays the held press when the second never comes, and a quick click keeps its order", () => {
    // Held, then the window passes with another event: the press is replayed first.
    expect(
      run(chord, [
        { type: "down", t: 0, button: "left" },
        { type: "tick", t: 60 },
        { type: "up", t: 400, button: "left" },
      ]),
    ).toEqual([["consume"], ["replay:left"], ["pass"]]);
    // Released at 20 ms: press and release in order, nothing lost.
    expect(
      run(chord, [
        { type: "down", t: 0, button: "right" },
        { type: "up", t: 20, button: "right" },
      ]),
    ).toEqual([["consume"], ["replay:right", "pass"]]);
  });

  it("does not take a second press after the window for a chord, and drag-select survives", () => {
    expect(
      run(chord, [
        { type: "down", t: 0, button: "left" },
        { type: "down", t: 80, button: "right" },
        { type: "up", t: 90, button: "right" },
        { type: "up", t: 500, button: "left" },
      ]),
    ).toEqual([["consume"], ["replay:left", "pass"], ["pass"], ["pass"]]);
  });
});
