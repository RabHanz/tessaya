/** Where a memory-sync credential may be sent (MEMORY.md section 6): https, or plain http only on this machine or the tailnet. */

const isPrivateTailnet = (host: string): boolean => {
  const parts = host.split(".").map(Number);
  // The /10 block Tailscale gives its machines: first octet 100, second 64 to 127.
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
};

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || host.startsWith("127.");

export const syncOriginAllowed = (url: URL): boolean =>
  url.protocol === "https:" ||
  (url.protocol === "http:" && (isLoopback(url.hostname) || isPrivateTailnet(url.hostname)));
