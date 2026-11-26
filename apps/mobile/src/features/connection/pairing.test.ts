import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
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

  it("pairs with the address's own origin when the address carries a query", () => {
    const pairingUrl = buildPairingUrl(
      "https://remote.example.com/?host=https%3A%2F%2Fother.example.com",
      "pairing-token",
    );

    expect(pairingUrl).toBe("https://remote.example.com/#token=pairing-token");
    expect(resolveRemotePairingTarget({ pairingUrl })).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
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
      "https://laptop.example.com/pair#token=AAAA",
      "https://app.t3.codes/pair?host=https%3A%2F%2Fstudio.example.com#token=BBBB",
      "http://192.168.1.20:3773/pair#token=CCCC",
    ];
    const scanned = extractPairingUrlsFromQrPayload(phonePairingLink(machines));
    expect(scanned).toEqual(machines);
    expect(scanned.map((url) => parsePairingUrl(url))).toEqual([
      { host: "https://laptop.example.com", code: "AAAA" },
      { host: "https://studio.example.com", code: "BBBB" },
      { host: "http://192.168.1.20:3773", code: "CCCC" },
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
