import { describe, expect, it } from "vite-plus/test";

import { phonePairingLink } from "@t3tools/tessaya-contracts";

import { buildPairingUrl, extractPairingUrlsFromQrPayload, parsePairingUrl } from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlsFromQrPayload", () => {
  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlsFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toEqual(["https://remote.example.com/pair#token=pairing-token"]);
  });

  it("reads every machine from a Tessaya Add a phone code, in order", () => {
    const machines = [
      "https://laptop.example.ts.net/pair#token=AAAA",
      "https://app.t3.codes/pair?host=https%3A%2F%2Fhetzner.example.ts.net#token=BBBB",
      "http://100.64.0.3:3773/pair#token=CCCC",
    ];
    const scanned = extractPairingUrlsFromQrPayload(phonePairingLink(machines));
    expect(scanned).toEqual(machines);
    expect(scanned.map((url) => parsePairingUrl(url))).toEqual([
      { host: "https://laptop.example.ts.net", code: "AAAA" },
      { host: "https://hetzner.example.ts.net", code: "BBBB" },
      { host: "http://100.64.0.3:3773", code: "CCCC" },
    ]);
  });

  it("keeps a plain pairing URL as the one machine", () => {
    expect(extractPairingUrlsFromQrPayload(" https://remote.example.com/#token=x ")).toEqual([
      "https://remote.example.com/#token=x",
    ]);
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
