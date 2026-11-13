import { roomData, type R1Context } from "../../apps/server/src/home/R1Device.ts";
import { DEFAULT_OS_PACK, rosterLine } from "../../packages/baton-shared/src/osPack.ts";

// A memory block of the size `TessayaTurn.begin` gives a device turn (standing plus this sentence's), so the user
// message is as long as a real one.
const MEMORY = [
  "- He takes his tea strong with a splash of milk, no sugar.",
  "- He works from the study most mornings; the study lamp and fan are his.",
  "- He prefers short spoken answers unless he asks for detail.",
  "- His time zone is Asia/Karachi; his companies' accounts run on UK time.",
  "- Freya handles writing; Alfred handles planning; Tessaya leads.",
  "- He wants risky house changes (locks, heaters) confirmed on his phone.",
  "- The R1 is on his desk in the study.",
  "- He said Tessaya is pronounced tess-AY-ya.",
].join("\n");

/** His sentence as the device turn sends it (`roomData`), with no house devices in view. */
export const roomUser = (
  heard: string,
  history: ReadonlyArray<{ role: string; content: string }> = [],
) => {
  const context: R1Context = {
    heard,
    privateBlock: "",
    history,
    devices: [],
    lastAction: null,
    automations: null,
    memory: MEMORY,
    preferences: {},
    voice: { speaker: { kind: "owner", personId: "owner", verified: true, inherited: false } },
    now: "Friday, 13 November 2026 at 10:15 (Asia/Karachi)",
    persona: null,
    switched: false,
    roster: rosterLine(DEFAULT_OS_PACK.personas, ""),
  };
  return roomData(context);
};
