import { assert, it } from "@effect/vitest";

import { makeMicBuffer, makePhoneVessel, nearBy, parsePhoneText } from "./PhoneLink.ts";

it("is near only on the R1's own network", () => {
  const cases: Array<[string | null, string | null, string | null, boolean]> = [
    // R1's address, phone's Wi-Fi address, phone's address as the server sees it
    ["192.168.10.40", "192.168.10.23", "198.51.100.7", true],
    ["::ffff:192.168.10.40", "192.168.10.23", null, true],
    ["192.168.10.40", "192.168.1.23", "198.51.100.7", false],
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

it("reads the phone's route, its motor and its button, as data", () => {
  assert.deepStrictEqual(
    parsePhoneText(
      '{"t":"route","kind":"headphones","name":"AirPods","ip":"1.2.3.4","haptic":{"kind":"core-haptics"},"gain":1.2}',
    ),
    {
      kind: "headphones",
      name: "AirPods",
      ip: "1.2.3.4",
      haptic: { kind: "core-haptics" },
      gain: 1.2,
    },
  );
  assert.deepStrictEqual(
    parsePhoneText(
      '{"t":"route","kind":"rocket","haptic":{"kind":"android","primitives":["CLICK","BOOM"],"amplitude":true},"gain":9}',
    ),
    {
      kind: "speaker",
      name: null,
      ip: null,
      haptic: { kind: "android", primitives: ["CLICK"], amplitude: true },
      gain: 2,
    },
  );
  assert.deepStrictEqual(parsePhoneText('{"t":"route","haptic":{"kind":"erm"}}'), {
    kind: "speaker",
    name: null,
    ip: null,
    haptic: null,
    gain: 1,
  });
  assert.strictEqual(parsePhoneText('{"t":"talk"}'), "talk");
  // its body's moments, in a Tessel's words; anything else of that kind is dropped
  assert.deepStrictEqual(parsePhoneText('{"t":"motion","kind":"lift"}'), {
    tail: "event/motion",
    body: '{"kind":"lift","conf":1,"intensity":60}',
  });
  assert.deepStrictEqual(parsePhoneText('{"t":"placement","placement":"face_down"}'), {
    tail: "state/placement",
    body: '{"placement":"face_down"}',
  });
  assert.isNull(parsePhoneText('{"t":"motion","kind":"teleport"}'));
  assert.isNull(parsePhoneText('{"t":"placement","placement":"moon"}'));
  assert.isNull(parsePhoneText("nope"));
});

it("is a vessel of its own with no Tessel near: a talk opens a session, its mic goes up in frames, her voice plays", () => {
  const up: Array<string> = [];
  const phone: Array<string> = [];
  let deliver: (tail: string, payload: Buffer) => void = () => undefined;
  let binds = 0;
  const v = makePhoneVessel({
    bind: (d) => {
      binds += 1;
      deliver = d;
      return {
        publish: (tail, p) => up.push(`${tail}:${p.length}`),
        close: () => up.push("closed"),
      };
    },
    play: (pcm) => phone.push(`play:${pcm.length}`),
    flush: () => phone.push("flush"),
    listen: (on) => phone.push(`listen:${on}`),
  });
  // Not bound (a Tessel near): its button is the Tessel's, and its mic goes nowhere.
  assert.isFalse(v.talk());
  v.mic(new Uint8Array(4000));
  v.set(true);
  v.set(true);
  assert.strictEqual(binds, 1);
  // No session open: nothing of his goes up.
  v.mic(new Uint8Array(4000));
  assert.isTrue(v.talk());
  v.mic(new Uint8Array(1000));
  v.mic(new Uint8Array(3000));
  deliver("voice/down", Buffer.alloc(640));
  deliver("voice/ctl", Buffer.from('{"ev":"flush"}'));
  deliver("cmd/voice/stop", Buffer.from("{}"));
  v.mic(new Uint8Array(4000));
  // The loop opens a session itself (a notice): he may answer it.
  deliver("cmd/voice/start", Buffer.from("{}"));
  // its body's moment goes onto the hub as a Tessel's would
  v.moment({ tail: "event/motion", body: '{"kind":"lift","conf":1,"intensity":60}' });
  v.set(false);
  // let go (a Tessel near): its moments are that Tessel's business, nothing goes up
  v.moment({ tail: "state/placement", body: '{"placement":"desk"}' });
  assert.deepStrictEqual(up, [
    "cmd/voice/start:2",
    "voice/up:1920",
    "voice/up:1920",
    "event/motion:39",
    "closed",
  ]);
  assert.deepStrictEqual(phone, [
    "listen:true",
    "play:640",
    "flush",
    "listen:false",
    "listen:true",
    "listen:false",
  ]);
});
