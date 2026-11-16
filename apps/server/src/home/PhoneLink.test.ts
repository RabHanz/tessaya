import { assert, it } from "@effect/vitest";

import { makeMicBuffer, nearBy, parseRoute } from "./PhoneLink.ts";

it("is near only on the R1's own network", () => {
  const cases: Array<[string | null, string | null, string | null, boolean]> = [
    // R1's address, phone's Wi-Fi address, phone's address as the server sees it
    ["192.168.10.40", "192.168.10.23", "100.70.1.2", true],
    ["::ffff:192.168.10.40", "192.168.10.23", null, true],
    ["192.168.10.40", "192.168.1.23", "100.70.1.2", false],
    ["203.0.113.9", null, "203.0.113.9", true],
    ["203.0.113.9", "10.0.0.4", "198.51.100.1", false],
    [null, "192.168.10.23", "192.168.10.23", false],
  ];
  for (const [r1, ip, remote, want] of cases)
    assert.strictEqual(nearBy(r1, { ip, remote }), want, JSON.stringify({ r1, ip, remote }));
});

it("feeds the R1's frames from the phone's mic, silence when dry, never more than it keeps", () => {
  const mic = makeMicBuffer(10);
  mic.push(new Uint8Array([1, 2, 3, 4]));
  assert.deepStrictEqual([...mic.take(6)], [1, 2, 3, 4, 0, 0]);
  mic.push(new Uint8Array(400).fill(5));
  mic.push(new Uint8Array(4).fill(6));
  // 10 ms is 320 bytes: the oldest went.
  const got = mic.take(400);
  assert.deepStrictEqual([got[0], got[315], got[316], got[319], got[320]], [5, 5, 6, 6, 0]);
});

it("reads the phone's route, as data", () => {
  assert.deepStrictEqual(
    parseRoute('{"t":"route","kind":"headphones","name":"AirPods","ip":"1.2.3.4"}'),
    { kind: "headphones", name: "AirPods", ip: "1.2.3.4" },
  );
  assert.deepStrictEqual(parseRoute('{"t":"route","kind":"rocket"}'), {
    kind: "speaker",
    name: null,
    ip: null,
  });
  assert.isNull(parseRoute("nope"));
});
