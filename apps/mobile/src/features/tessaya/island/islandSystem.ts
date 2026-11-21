/**
 * The island outside the app (M-126): when the app goes to the background, the lock screen (an iOS Live Activity)
 * and the notification shade (Android's ongoing card) carry what the pill showed, minus her own moment-to-moment
 * state. Both are T3's one agent card, extended: a card the relay already keeps for agent work is left to it, since
 * its rows hold the same jobs.
 */
import { systemIslandItems, type IslandItem } from "@t3tools/tessaya-shared/island";
import { Platform } from "react-native";

import {
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "../../agent-awareness/agentLiveActivity";
import { showAndroidShowcaseAgentActivity } from "../../agent-awareness/androidNotifications";
import { loadPreferences } from "../../../persistence/imperative";

const CHIP: Readonly<Record<IslandItem["kind"], string>> = {
  her: "Tessaya",
  needsYou: "Needs",
  timer: "Timer",
  upcoming: "Next",
  working: "Working",
};

/** The card's text for these items, or null when there is nothing to carry. */
export const islandCard = (items: ReadonlyArray<IslandItem>) => {
  const shown = systemIslandItems(items);
  const top = shown[0];
  if (top === undefined) return null;
  return {
    title: [top.label, top.detail].filter(Boolean).join(" · "),
    body: shown
      .slice(1)
      .map((i) => [i.label, i.detail].filter(Boolean).join(" "))
      .join(" · "),
    chip: CHIP[top.kind],
    href: top.href ?? "/",
  };
};

let lastCard = "";

// shortcut: posted only as the app leaves the front, so the lock screen shows what was true then; a server-sent
// island (the relay carrying timers and Coming up) is the upgrade once the brain pushes it
export const postIslandOutside = async (items: ReadonlyArray<IslandItem>) => {
  const card = islandCard(items);
  const key = JSON.stringify(card);
  if (card === null || key === lastCard) return;
  const preferences = await loadPreferences().catch(() => null);
  if (preferences?.liveActivitiesEnabled === false) return;
  lastCard = key;
  if (Platform.OS === "android") {
    showAndroidShowcaseAgentActivity({
      active: "true",
      activity_title: card.title,
      activity_body: card.body,
      activity_chip: card.chip,
      activity_path: card.href,
    });
    return;
  }
  if (getAgentLiveActivities().length > 0) return;
  const now = new Date().toISOString();
  startAgentLiveActivity({
    title: "Tessaya",
    subtitle: card.title,
    activeCount: 0,
    updatedAt: now,
    activities: [],
    island: { line: card.title, more: card.body, chip: card.chip, href: card.href },
  });
};
