import { describe, expect, it } from "vite-plus/test";

import { checkWrite, valueText, withFloor } from "./deviceItems.ts";

const item = (over: Record<string, unknown>) =>
  ({ id: "x", label: "X", type: "number", access: "read,write", safety: "free", ...over }) as never;

describe("withFloor", () => {
  it("raises a private item's write to his owner yes and never lowers a stricter class", () => {
    expect(
      withFloor(item({ id: "camera.capture", type: "action", access: "write" })),
    ).toMatchObject({
      safety: "owner",
      privacy: true,
    });
    expect(withFloor(item({ id: "presence.hello", type: "bool", access: "read" }))).toMatchObject({
      safety: "free",
      privacy: true,
    });
    expect(withFloor(item({ id: "mic.route", access: "read,write", safety: "never" })).safety).toBe(
      "never",
    );
    expect(withFloor(item({ id: "audio.volume" }))).not.toHaveProperty("privacy");
  });
});

describe("checkWrite", () => {
  it.each([
    [item({ range: [0, 100] }), "40", { ok: true, value: 40 }],
    [item({ range: [0, 100] }), 140, { ok: false }],
    [item({ type: "bool" }), "on", { ok: true, value: true }],
    [item({ type: "enum", values: ["speaker", "bt"] }), "auto", { ok: false }],
    [item({ type: "action", range: [10, 1500] }), 5000, { ok: false }],
    [item({ type: "action" }), { mac: "AA" }, { ok: true, value: { mac: "AA" } }],
    [item({ access: "read" }), 1, { ok: false }],
    [item({ type: "matrix" }), 1, { ok: false }],
  ])("checks %j against %j", (it_, value, expected) => {
    expect(checkWrite(it_, value)).toMatchObject(expected);
  });
  it("says values in words", () => {
    expect(valueText({ type: "number", unit: "%" }, 15)).toBe("15 %");
    expect(valueText({ type: "bool" }, false)).toBe("off");
  });
});
