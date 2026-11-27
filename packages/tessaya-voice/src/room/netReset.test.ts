import { expect, it } from "vite-plus/test";

import { createLinkWatch, parseArp, resetFrame } from "./netReset.ts";

it("builds the frame the firmware checks (tessel-fw tools/test_netreset.py vector)", () => {
  const key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
  expect(resetFrame(key, "c8:47:8c:3d:57:b3", 1795612345678).toString("hex")).toBe(
    "54534c52535401c8478c3d57b3000001a212d6054ee261e23e8b98addfd220b37e9cae6524598d2b63a33336b0e393fe857ba7db32",
  );
});

const ARP_HEAD = "IP address       HW type     Flags       HW address            Mask     Device\n";
const row = (flags: string) =>
  `${ARP_HEAD}192.168.10.220   0x1         ${flags}         c8:47:8c:3d:57:b3     *        enp1s0\n`;

it("resets a silent Tessel that still answers ARP, backs off, and stops once it is heard", () => {
  let now = 0;
  let arp = row("0x2");
  const sent: Array<string> = [];
  const reports: Array<object> = [];
  const w = createLinkWatch({
    now: () => now,
    arp: () => parseArp(arp),
    send: (ip) => sent.push(ip),
    report: (_id, body) => reports.push(body),
    log: () => {},
    deviceKey: "00".repeat(32),
  });
  w.heard("r1-3d57b3");
  now = 149_000;
  w.tick();
  expect(sent).toEqual([]);
  now = 150_000;
  w.tick();
  expect(sent).toEqual(["192.168.10.220"]);
  now = 180_000;
  w.tick(); // still answers ARP after the send: a wedged link, reported once
  expect(reports).toEqual([{ silent_s: 180, try: 1, arp: true }]);
  now = 150_000 + 5 * 60_000;
  w.tick();
  expect(sent).toHaveLength(2);
  now += 10 * 60_000;
  w.tick();
  now += 60 * 60_000;
  w.tick();
  expect(sent).toHaveLength(3); // three in all, then quiet
  w.heard("r1-3d57b3");
  arp = row("0x0");
  now += 150_000;
  w.tick();
  now += 30_000;
  w.tick(); // off: the send's probe got no answer, so no wedged-link row
  expect(sent).toHaveLength(4);
  expect(reports).toHaveLength(3);
});
