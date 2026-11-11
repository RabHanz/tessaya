import { describe, expect, it } from "vite-plus/test";

import {
  connectPacket,
  createDecoder,
  parsePublish,
  publishPacket,
  subscribePacket,
  topicMatches,
} from "./mqtt.ts";

describe("the room's MQTT client", () => {
  it("frames a 1920-byte voice publish with a two-byte remaining length and reads it back across split chunks", () => {
    const payload = new Uint8Array(1920).fill(7);
    const bytes = publishPacket("freya/r1/r1-3d57b3/voice/down", payload);
    expect(bytes[0]).toBe(0x30);
    expect(bytes[1]! & 0x80).toBe(0x80);
    const decode = createDecoder();
    expect(decode(bytes.subarray(0, 100))).toEqual([]);
    const [p] = decode(Buffer.concat([bytes.subarray(100), Buffer.from([0xd0, 0])]));
    const { topic, payload: back } = parsePublish(p!);
    expect(topic).toBe("freya/r1/r1-3d57b3/voice/down");
    expect(back.length).toBe(1920);
  });

  it("decodes several packets in one chunk and skips a QoS 1 packet id", () => {
    const qos1 = Buffer.from(publishPacket("a/b", Buffer.from("hi")));
    qos1[0] = 0x32;
    const withId = Buffer.concat([
      qos1.subarray(0, 2),
      qos1.subarray(2, 7),
      Buffer.from([0, 9]),
      qos1.subarray(7),
    ]);
    withId[1] = withId[1]! + 2;
    const packets = createDecoder()(Buffer.concat([Buffer.from([0x20, 2, 0, 0]), withId]));
    expect(packets.map((p) => p.type)).toEqual([2, 3]);
    expect(String(parsePublish(packets[1]!).payload)).toBe("hi");
  });

  it("puts the credentials flags and fields in CONNECT, and QoS 0 on each subscription", () => {
    const c = connectPacket({ clientId: "x", user: "voice", pass: "p", keepAliveS: 30 });
    expect(c[9]).toBe(0xc2);
    const s = subscribePacket(1, ["a/+", "b/#"]);
    expect([...s.subarray(-1)]).toEqual([0]);
  });

  it("matches + and # filters", () => {
    expect(topicMatches("freya/r1/+/voice/up", "freya/r1/r1-3d57b3/voice/up")).toBe(true);
    expect(topicMatches("freya/r1/+/voice/up", "freya/r1/x/voice/down")).toBe(false);
    expect(topicMatches("freya/#", "freya/r1/x/voice/down")).toBe(true);
  });
});
