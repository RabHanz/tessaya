/**
 * Emergency broadcasts (COMMS-DESIGN §8.7, C-2): the owner defines the kinds and who may trigger each; a trigger
 * overrides quiet hours and do-not-disturb on every vessel and repeats until each person acknowledges. Pure rules.
 */
import type { CommsEmergencyKind } from "@t3tools/tessaya-contracts";

/** It sounds again this often until each person says okay. */
export const EMERGENCY_REPEAT_MS = 20_000;
/** One trigger of a kind this often at most, so a stuck sensor or a game can't keep the house ringing. */
export const EMERGENCY_MIN_GAP_MS = 2 * 60_000;
/** Repeats stop after this long even unanswered; the Record keeps who never answered. */
export const EMERGENCY_MAX_MS = 30 * 60_000;

/**
 * Why this caller may not trigger this kind, or null. A service (an agent, Home Assistant's call) may only where the
 * owner allowed automations; a guest never; a child only a kind open to anyone.
 */
export const emergencyRefusal = (
  kind: CommsEmergencyKind,
  caller: { readonly role: string | null; readonly service: boolean },
): string | null => {
  if (caller.service)
    return kind.automations ? null : `${kind.label} can't be set off by an automation.`;
  const role = caller.role;
  if (role === null || role === "guest") return "Only members of this home can do that.";
  if (kind.who === "owner" && role !== "owner" && role !== "admin")
    return `Only the owner sets off ${kind.label}.`;
  if (kind.who === "adults" && role === "child")
    return `A grown-up sets off ${kind.label}; I'll tell your parents you need them.`;
  return null;
};

/** Whether this kind may sound now, from when it last did. */
export const emergencyRateOk = (lastAt: number | null, now: number): boolean =>
  lastAt === null || now - lastAt >= EMERGENCY_MIN_GAP_MS;
