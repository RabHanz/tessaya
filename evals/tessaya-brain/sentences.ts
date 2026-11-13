import { roomCases } from "../tessaya-room/cases.ts";

/**
 * What he says to a device: the room suite's sentences (its live cases with their device slots filled in),
 * plus the everyday asks the suite does not cover.
 */
const LIVE = [
  "Can you see the study fan?",
  "Is the desk lamp on right now?",
  "Turn off the study fan.",
  "Set the study fan to 40 percent.",
  "Set the desk lamp to 30 percent brightness.",
  "Open the study blinds.",
  "Set the study heater to 22 degrees.",
  "Turn the study fan on for just one minute.",
  "Undo the last thing you changed in the house.",
  "Which automations do I have?",
  "Check the record: what happened in the last five minutes?",
  "What's on the team board?",
  "What's in flight right now?",
  "Which of my sessions are open?",
  "Which jobs are you working on for me right now?",
  "What do you remember about how I take my tea?",
  "Send me a question on my phone: should I order more coffee?",
  "Can you speak louder?",
  "What do you see in front of you?",
  "What's on my laptop screen?",
];

const EVERYDAY = [
  "What time is it?",
  "Good morning.",
  "Thanks, that's all.",
  "How are you today?",
  "Remind me what Freya is good at.",
  "Should I take the Lahore meeting on Monday or push it to Wednesday?",
  "Plan my Saturday: gym, groceries, and two hours of deep work.",
  "Why would a Node server's memory keep growing after a deploy?",
  "Explain the difference between a cache read and a cache write in one sentence.",
  "Is anything stuck that needs me?",
];

export const SENTENCES: ReadonlyArray<string> = [
  ...new Set([...roomCases.flatMap((c) => c.said), ...LIVE, ...EVERYDAY]),
];
