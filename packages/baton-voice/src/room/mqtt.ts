/**
 * What the room loop reads from its broker beyond the shared client (`@t3tools/baton-shared/mqtt`).
 *
 * @module baton-voice/room/mqtt
 */
/** A real R1's traffic that means he is using it (his voice, anything it reports); null for anything else, online included. */
export const realDeviceActivity = (
  topic: string,
  payload: string,
  replayId: string,
): string | null => {
  const m = /^freya\/r1\/([^/]+)\/(.+)$/.exec(topic);
  if (m === null || m[1] === replayId) return null;
  const [, device, rest] = m;
  if (rest === "voice/up" || rest!.startsWith("event/")) return `${device} sent ${rest}`;
  return null;
};
