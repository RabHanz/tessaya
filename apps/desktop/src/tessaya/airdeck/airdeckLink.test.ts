import { describe, expect, it } from "vite-plus/test";

import { claimsFor, deckManifest, parseCoreLine, type Remote } from "./airdeckLink.ts";

const g20s: Remote = {
  id: "g20s",
  name: "G20S",
  connected: true,
  buttons: [
    { id: "mic", label: "Voice", tapOnly: true },
    { id: "ok", label: "OK", tapOnly: false },
    { id: "num_3", label: "3", tapOnly: false },
    { id: "up", label: "Up", tapOnly: false },
  ],
};

describe("airdeckLink", () => {
  it("reads the core's lines and drops what it does not know", () => {
    expect(
      parseCoreLine(
        '{"ev":"hello","version":1,"remotes":[{"id":"g20s","name":"G20S","connected":true,"buttons":[{"id":"mic","label":"Voice","tap_only":true},{"label":"no id"}]}],"claims":{}}',
      ),
    ).toEqual({
      ev: "hello",
      remotes: [
        {
          id: "g20s",
          name: "G20S",
          connected: true,
          buttons: [{ id: "mic", label: "Voice", tapOnly: true }],
        },
      ],
    });
    expect(
      parseCoreLine(
        '{"ev":"button","remote":"g20s","button":"num_3","down":true,"t":5,"owner":"tessaya"}',
      ),
    ).toEqual({ ev: "button", remote: "g20s", button: "num_3", down: true, owner: "tessaya" });
    expect(parseCoreLine('{"ev":"button","remote":"g20s","button":"ok","down":false}')).toEqual({
      ev: "button",
      remote: "g20s",
      button: "ok",
      down: false,
      owner: null,
    });
    expect(parseCoreLine('{"ev":"device","remote":"g20s","connected":false}')).toEqual({
      ev: "device",
      remote: "g20s",
      connected: false,
    });
    expect(parseCoreLine('{"ev":"claimed","buttons":["g20s/ok"]}')).toBeNull();
    expect(parseCoreLine('{"ev":"button","remote":"g20s","button":"ok"}')).toBeNull();
    expect(parseCoreLine("not json")).toBeNull();
  });

  it("claims what is bound on a known remote, plus the buttons whose stock key is useless", () => {
    expect(claimsFor([g20s], ["g20s/ok", "g20s/gone", "g10s/ok"])).toEqual([
      "g20s/mic",
      "g20s/num_3",
      "g20s/ok",
    ]);
    expect(claimsFor([], ["g20s/ok"])).toEqual([]);
  });

  it("describes a remote as a registry device with one event per button", () => {
    const m = deckManifest(g20s);
    expect(m.deviceId).toBe("airdeck-g20s");
    expect(m.items.map((i) => [i.id, i.type])).toEqual([
      ["connected", "bool"],
      ["press.mic", "event"],
      ["press.ok", "event"],
      ["press.num_3", "event"],
      ["press.up", "event"],
    ]);
  });
});
