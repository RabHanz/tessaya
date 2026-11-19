import { describe, expect, it } from "vite-plus/test";

import {
  FOCUS_IDLE_MS,
  HANDOVER_MS,
  mayDrive,
  nextFocus,
  REST,
  SCENE_RESUME_MS,
  type Focus,
  type FocusEvent,
} from "./bodyFocus.ts";

const run = (events: ReadonlyArray<FocusEvent>, from: Focus = REST) =>
  events.reduce<{ focus: Focus; handovers: Array<string> }>(
    (acc, e) => {
      const step = nextFocus(acc.focus, e);
      return {
        focus: step.focus,
        handovers:
          step.handover === null
            ? acc.handovers
            : [...acc.handovers, `${step.handover.from}>${step.handover.to}`],
      };
    },
    { focus: from, handovers: [] },
  );

describe("bodyFocus", () => {
  it("two threads he alternates between: only the one he is present in drives her body", () => {
    const { focus, handovers } = run([
      { kind: "presence", thread: "A", signal: "type", at: 0 },
      // typing in B a moment later is not yet a handover; past the hysteresis it is
      { kind: "presence", thread: "B", signal: "type", at: HANDOVER_MS - 1 },
      { kind: "presence", thread: "B", signal: "type", at: HANDOVER_MS + 10 },
    ]);
    expect(handovers).toEqual(["null>A", "A>B"]);
    expect(mayDrive(focus, "B")).toBe(true);
    expect(mayDrive(focus, "A")).toBe(false);
    // his voice outranks typing at once
    expect(
      nextFocus(focus, { kind: "presence", thread: "A", signal: "speak", at: HANDOVER_MS + 20 })
        .focus,
    ).toMatchObject({ thread: "A" });
  });

  it("a scene holds the body; he interrupts it, and it resumes where it was if he comes back in time", () => {
    const started = run([
      { kind: "presence", thread: "A", signal: "type", at: 0 },
      { kind: "sceneStart", thread: "A", scene: "dance", at: 1_000, ms: 60_000 },
    ]).focus;
    expect(
      nextFocus(started, { kind: "sceneStart", thread: "B", scene: "wave", at: 2_000, ms: 1_000 })
        .refused,
    ).toBeDefined();
    // a glance elsewhere leaves it playing; speaking elsewhere pauses it and B has her body
    expect(
      nextFocus(started, { kind: "presence", thread: "B", signal: "look", at: 2_000 }).focus.state,
    ).toBe("scene");
    const paused = nextFocus(started, {
      kind: "presence",
      thread: "B",
      signal: "speak",
      at: 11_000,
    }).focus;
    expect(paused).toMatchObject({ state: "paused", engaged: "B", left: 50_000 });
    expect(mayDrive(paused, "B")).toBe(true);
    expect(mayDrive(paused, "A")).toBe(false);
    const back = nextFocus(paused, {
      kind: "presence",
      thread: "A",
      signal: "type",
      at: 20_000,
    }).focus;
    expect(back).toEqual({ state: "scene", thread: "A", scene: "dance", until: 70_000 });
    // a scene that played out gives the body back to its thread
    expect(
      nextFocus(back, { kind: "presence", thread: "B", signal: "type", at: 80_000 }).focus,
    ).toMatchObject({ state: "engaged", thread: "B" });
  });

  it("a barge-in pauses a scene; 'carry on' resumes it, and a pause left too long closes it", () => {
    const scene: Focus = { state: "scene", thread: "A", scene: "s", until: 30_000 };
    const paused = nextFocus(scene, { kind: "interrupt", at: 10_000 }).focus;
    expect(paused).toMatchObject({ state: "paused", left: 20_000, engaged: null });
    expect(nextFocus(paused, { kind: "resume", at: 15_000 }).focus).toEqual({
      ...scene,
      until: 35_000,
    });
    expect(nextFocus(paused, { kind: "resume", at: 10_000 + SCENE_RESUME_MS + 1 }).focus).toEqual(
      REST,
    );
    expect(nextFocus(paused, { kind: "sceneEnd", thread: "A", at: 12_000 }).focus).toMatchObject({
      state: "engaged",
      thread: "A",
    });
  });

  it("idle rests her, and a private lease ending takes the body from its threads at once", () => {
    const engaged: Focus = { state: "engaged", thread: "A", signal: "type", at: 0 };
    expect(nextFocus(engaged, { kind: "idle", thread: "A", at: 1 }).focus).toEqual(REST);
    expect(nextFocus(engaged, { kind: "idle", thread: "B", at: 1 }).focus).toEqual(engaged);
    // a conversation he left holds her no more: time alone brings her to rest, and the handover says so
    const quiet = nextFocus(engaged, { kind: "tick", at: FOCUS_IDLE_MS + 1 });
    expect(quiet.focus).toEqual(REST);
    expect(quiet.handover).toEqual({ from: "A", to: null, reason: "idle" });
    const privateScene: Focus = { state: "scene", thread: "P", scene: "s", until: 99_000 };
    const step = nextFocus(privateScene, { kind: "privateEnd", threads: ["P"], at: 5 });
    expect(step.focus).toEqual(REST);
    expect(step.handover).toEqual({ from: "P", to: null, reason: "private ended" });
    const pausedForPublic: Focus = {
      state: "paused",
      thread: "P",
      scene: "s",
      at: 0,
      left: 1,
      engaged: "A",
    };
    expect(
      nextFocus(pausedForPublic, { kind: "privateEnd", threads: ["P"], at: 5 }).focus,
    ).toMatchObject({ state: "engaged", thread: "A" });
  });
});
