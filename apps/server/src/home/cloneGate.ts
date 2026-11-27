// @effect-diagnostics nodeBuiltinImport:off
/**
 * Who may fetch his cloned voice for a room loop on another machine (Director, 21 Nov): a Tessel's key, straight over
 * the tailnet (WireGuard, so encrypted) with no proxy or tunnel in between, from a machine of his linked here with
 * full access. Anything else keeps the loopback-only route, and the persona's Pocket voice.
 */
import * as NodeDnsPromises from "node:dns/promises";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PeerLinks from "../peer/PeerLinks.ts";

/** Tailscale's CGNAT range (100.64/10), also as an IPv4-mapped IPv6 address. Pure. */
export const tailnetIp = (remote: string): string | null => {
  const ip = remote.replace(/^::ffff:/, "");
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(ip);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127 ? ip : null;
};

/** The gate itself. Pure. */
export const mayFetchClone = (input: {
  readonly keyOk: boolean;
  readonly remote: string;
  readonly proxied: boolean;
  readonly fullAccessIps: ReadonlySet<string>;
}): boolean => {
  const ip = tailnetIp(input.remote);
  return input.keyOk && !input.proxied && ip !== null && input.fullAccessIps.has(ip);
};

export const PROXY_HEADERS = [
  "cf-connecting-ip",
  "x-forwarded-for",
  "tailscale-user-login",
] as const;

/** The tailnet IPs of every full-access link here, from its addresses (IPs as they are, names looked up). */
export const fullAccessIps = Effect.gen(function* () {
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  if (Option.isNone(links)) return new Set<string>();
  const full = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
    (l) => l.status !== "expired" && l.access === "full-access",
  );
  const hosts = [...new Set(full.flatMap((l) => l.urls.map((u) => new URL(u).hostname)))];
  const ips = yield* Effect.promise(() =>
    Promise.all(
      hosts.map((h) =>
        tailnetIp(h) !== null
          ? Promise.resolve([h])
          : NodeDnsPromises.lookup(h, { all: true, family: 4 }).then(
              (r) => r.map((a) => a.address),
              () => [],
            ),
      ),
    ),
  );
  return new Set(ips.flat().flatMap((ip) => (tailnetIp(ip) === null ? [] : [ip])));
});
