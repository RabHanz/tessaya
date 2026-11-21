/**
 * Her own state, in detail, for "what about your other bodies?" or "how are you?" (the Director, 20 Nov): every body she
 * is in and who wears it, her one mood, what each face shows, what her desk body is doing, who is around and her devices.
 * Each part says where it came from. The turn carries the compact part (bodies, mood, presence); this is the rest.
 */
import { alsoLine, type BodyNow } from "@t3tools/tessaya-shared/embodiment";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { PRESENCE_BARS } from "@t3tools/tessaya-shared/presence";
import { whatsNewLine } from "@t3tools/tessaya-shared/whatsNew";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { bodyHolderLine } from "./TessayaBody.ts";
import { TessayaCast } from "./TessayaCast.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { whatsNew } from "./TessayaWhatsNew.ts";
import { TessayaPresence } from "./TessayaPresence.ts";
import { TessayaSessionInsight } from "./TessayaSessionInsight.ts";

/** Her state as lines, each ending with its source; `asker` is the member asking (only he hears whom a face was for). */
export const myState = Effect.fn("TessayaSelf.myState")(function* (input: {
  readonly persona: string | undefined;
  readonly asker: string | null;
}) {
  const lines: Array<string> = [];
  const cast = yield* Effect.serviceOption(TessayaCast);
  const view = Option.isNone(cast)
    ? null
    : yield* cast.value.view.pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (view !== null) {
    const nameOf = (id: string) => view.personas.find((p) => p.id === id)?.name ?? id;
    const bodies = view.bodies.map((b): BodyNow => ({
      name: b.name,
      kind: b.kind,
      online: b.online,
      wearer: b.wearing === null ? null : nameOf(b.wearing),
      you: b.wearing !== null && b.wearing === input.persona,
      ...(b.shown === undefined ? {} : { shown: b.shown }),
      ...(b.screen === undefined ? {} : { screen: b.screen }),
    }));
    const line = alsoLine(bodies, []).replace("Your other bodies", "Your bodies");
    if (line !== "") lines.push(`${line} (from the Cast on her brain)`);
  }
  const mood = yield* Effect.serviceOption(TessayaMood);
  if (Option.isSome(mood)) {
    const now = yield* mood.value.view(input.persona);
    lines.push(`Your mood: ${now.label}, ${Math.round(now.intensity * 100)}% (from her one mood).`);
    if (view !== null)
      for (const b of view.bodies) {
        const face = (yield* mood.value.facesOn(b.id))[0];
        if (face === undefined) continue;
        // whom a face was for is his alone, and a private moment is never named (M-094)
        const forWhom =
          input.asker === OWNER_MEMBER_ID && !face.private ? ` for ${face.faceFor}` : "";
        lines.push(`${b.name} shows ${face.label}${forWhom} (from that body's last face).`);
      }
  }
  if (input.asker === OWNER_MEMBER_ID) lines.push(`${yield* bodyHolderLine()} (from body focus)`);
  const presence = yield* Effect.serviceOption(TessayaPresence);
  if (Option.isSome(presence)) {
    const around = (yield* presence.value.estimate()).members.filter(
      (m) => m.confidence >= PRESENCE_BARS.around,
    ).length;
    lines.push(`People around: ${around} (from presence).`);
  }
  const news = whatsNewLine(yield* whatsNew(), yield* Clock.currentTimeMillis);
  if (news !== "") lines.push(`${news} (from her releases, kept on her brain)`);
  const registry = yield* Effect.serviceOption(DeviceRegistry);
  if (Option.isSome(registry)) {
    const all = (yield* registry.value.list).filter((d) => d.stale !== true);
    lines.push(
      `Devices: ${all.filter((d) => d.online).length} online of ${all.length} (from the device registry here).`,
    );
  }
  const sessions = yield* Effect.serviceOption(TessayaSessionInsight);
  const talking = Option.isNone(sessions) ? null : yield* sessions.value.talkingWith;
  if (talking !== null)
    lines.push(
      `You are talking with ${talking} for him: what he tells it goes straight to it (from his session conversation).`,
    );
  return lines.join("\n");
});
