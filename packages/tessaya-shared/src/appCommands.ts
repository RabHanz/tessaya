/**
 * Every app command (its keybindings and command palette) by voice, through the desktop assistant's `app_command`.
 * Typed over the commands, so a new command without a voice line, or a reason it has none, does not compile.
 */
import type { KeybindingCommand, STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";

type StaticCommand = (typeof STATIC_KEYBINDING_COMMANDS)[number];

export interface AppCommandVoice {
  /** What it does, as he would ask for it. */
  readonly say: string;
  /** What she says once it ran, briefly. */
  readonly done: string;
  /** It shows or hides something: the same command again undoes it. */
  readonly toggle?: boolean;
  /** It changes or sends something beyond the view, so it waits for his yes; why, in one line. */
  readonly asks?: string;
}
export interface AppCommandNever {
  readonly never: string;
}

const view = (say: string, done: string): AppCommandVoice => ({ say, done });
const toggle = (say: string, done: string): AppCommandVoice => ({ say, done, toggle: true });
const asks = (say: string, done: string, why: string): AppCommandVoice => ({
  say,
  done,
  asks: why,
});
const never = (why: string): AppCommandNever => ({ never: why });

const PICKER_ONLY = never(
  "it works only while the model picker is open under his hand; a model is chosen by name in settings",
);
const jump = (n: number) => view(`go to session ${n} in the sidebar`, `Opened session ${n}.`);

export const APP_COMMAND_VOICE: {
  readonly [K in StaticCommand]: AppCommandVoice | AppCommandNever;
} = {
  "thread.jump.1": jump(1),
  "thread.jump.2": jump(2),
  "thread.jump.3": jump(3),
  "thread.jump.4": jump(4),
  "thread.jump.5": jump(5),
  "thread.jump.6": jump(6),
  "thread.jump.7": jump(7),
  "thread.jump.8": jump(8),
  "thread.jump.9": jump(9),
  "modelPicker.jump.1": PICKER_ONLY,
  "modelPicker.jump.2": PICKER_ONLY,
  "modelPicker.jump.3": PICKER_ONLY,
  "modelPicker.jump.4": PICKER_ONLY,
  "modelPicker.jump.5": PICKER_ONLY,
  "modelPicker.jump.6": PICKER_ONLY,
  "modelPicker.jump.7": PICKER_ONLY,
  "modelPicker.jump.8": PICKER_ONLY,
  "modelPicker.jump.9": PICKER_ONLY,
  "modelPicker.previousProvider": PICKER_ONLY,
  "modelPicker.nextProvider": PICKER_ONLY,
  "modelPicker.toggle": toggle("open the model picker", "The model picker is open."),
  "thread.stop": view("stop the session that is working", "Stopped it."),
  "thread.steerQueuedMessage": asks(
    "send the queued message now, into the running turn",
    "Sent the queued message.",
    "It sends a message to the agent.",
  ),
  "thread.editQueuedMessage": never("it puts the queued message under his cursor to edit by hand"),
  "thread.previous": view("go to the previous session", "Went to the previous session."),
  "thread.next": view("go to the next session", "Went to the next session."),
  "thread.copyReference": view(
    "copy a reference to this session",
    "Copied this session's reference.",
  ),
  "thread.settle": view(
    "settle this session out of the sidebar",
    "Settled it. Say undo to bring it back.",
  ),
  "thread.pin": toggle("pin or unpin this session", "Done. Say it again to undo."),
  "thread.regenerateTitle": view("write this session's title again", "Writing a new title."),
  "thread.undo": view("undo the last session change", "Undone."),
  "workspace.focusNext": view("move to the next panel", "Moved to the next panel."),
  "workspace.focusPrevious": view("move to the previous panel", "Moved to the previous panel."),
  "sidebar.toggle": toggle("show or hide the sidebar", "Sidebar switched."),
  "navigation.back": view("go back", "Went back."),
  "navigation.forward": view("go forward", "Went forward."),
  "terminal.toggle": toggle("show or hide the terminal", "Terminal switched."),
  "terminal.split": view("split the terminal side by side", "Split the terminal."),
  "terminal.splitVertical": view("split the terminal top and bottom", "Split the terminal."),
  "terminal.new": view("open a new terminal", "Opened a new terminal."),
  "terminal.close": asks(
    "close this terminal",
    "Closed the terminal.",
    "It ends what runs in that terminal.",
  ),
  "rightPanel.toggle": toggle("show or hide the right panel", "Right panel switched."),
  "rightPanel.new": view("open a new tab in the right panel", "Opened a new tab."),
  "threadPanel.toggle": toggle("show or hide the session panel", "Session panel switched."),
  "rightPanel.toggleMaximized": toggle(
    "maximise or restore the right panel",
    "Right panel resized.",
  ),
  "rightPanel.close": view(
    "close the right panel's tab",
    "Closed it. Say reopen to bring it back.",
  ),
  "view.reopenClosed": view("reopen what was just closed", "Reopened it."),
  "pullRequest.copyNumber": view("copy the pull request number", "Copied the number."),
  "diff.toggle": toggle("show or hide the diff", "Diff switched."),
  "preview.toggle": toggle("show or hide the browser preview", "Preview switched."),
  "preview.refresh": view("reload the browser preview", "Reloaded the preview."),
  "preview.focusUrl": view("go to the preview's address bar", "The address bar is ready."),
  "preview.zoomIn": view("zoom the preview in", "Zoomed in."),
  "preview.zoomOut": view("zoom the preview out", "Zoomed out."),
  "preview.resetZoom": view("reset the preview's zoom", "Zoom reset."),
  "preview.find": view("find on the preview page", "Find is open."),
  "commandPalette.toggle": toggle("open the command palette", "The command palette is open."),
  "filePicker.toggle": toggle("open the file picker", "The file picker is open."),
  "projectSearch.toggle": toggle("search the project's files", "Project search is open."),
  "usage.open": view("open the usage view", "Opened the usage view."),
  "theme.select": view("choose a theme", "The theme list is open."),
  "appearance.cycle": view(
    "switch light, dark or system appearance",
    "Appearance changed. Say it again for the next one.",
  ),
  "themeEditor.toggle": toggle("open the theme editor", "Theme editor switched."),
  "composer.stash": view(
    "set the draft aside",
    "Set the draft aside. Say it again to bring it back.",
  ),
  "composer.sendAlternate": asks(
    "send the draft the other way: queued or steering",
    "Sent.",
    "It sends a message to the agent.",
  ),
  "composer.sendBackground": asks(
    "send the draft as a background session",
    "Sent in the background.",
    "It sends a message to the agent.",
  ),
  "composer.sendAndNewThread": asks(
    "send the draft and start a new session",
    "Sent, and a new session is open.",
    "It sends a message to the agent.",
  ),
  "composer.dictation": never("dictation_start already starts dictation by voice"),
  "composer.host": view("choose which machine the session runs on", "The machine list is open."),
  "composer.cycleHost": view("switch to the next machine", "Switched machine."),
  "composer.effort": view("choose the effort", "The effort list is open."),
  "composer.increaseEffort": view("raise the effort", "Effort raised. Say lower to undo it."),
  "composer.decreaseEffort": view("lower the effort", "Effort lowered. Say raise to undo it."),
  "composer.mode": view("choose the access mode", "The mode list is open."),
  "composer.workspace": view("choose local or a worktree", "The workspace list is open."),
  "composer.previousWorktree": view(
    "use the previous worktree",
    "Switched to the previous worktree.",
  ),
  "composer.branch": view("choose the branch", "The branch list is open."),
  "chat.new": view("start a new session", "Opened a new session."),
  "chat.newLocal": view("start a new local session", "Opened a new local session."),
  "chat.newWithoutProject": view(
    "start a session without a project",
    "Opened a session without a project.",
  ),
  "chat.find": view("find in this session", "Find is open."),
  "editor.openFavorite": view("open the project in his editor", "Opened it in the editor."),
  "usage.cost": view("show usage as cost", "Showing cost."),
  "usage.tokens": view("show usage as tokens", "Showing tokens."),
  "usage.limits": view("show usage limits", "Showing limits."),
  "usage.period.day": view("show today's usage", "Showing today."),
  "usage.period.week": view("show this week's usage", "Showing this week."),
  "usage.period.month": view("show this month's usage", "Showing this month."),
  "usage.period.quarter": view("show this quarter's usage", "Showing this quarter."),
};

export const isVoiced = (entry: AppCommandVoice | AppCommandNever): entry is AppCommandVoice =>
  !("never" in entry);

/** The commands she may run, in table order: the tool's enum. */
export const VOICED_APP_COMMANDS = (Object.keys(APP_COMMAND_VOICE) as Array<StaticCommand>).filter(
  (c) => isVoiced(APP_COMMAND_VOICE[c]),
);

const SCRIPT = /^script\.([a-z0-9][a-z0-9-]*)\.run$/;
export const scriptCommand = (id: string): KeybindingCommand | null =>
  SCRIPT.test(`script.${id}.run`) ? (`script.${id}.run` as KeybindingCommand) : null;

/** Why this command waits for his yes, or null when it runs at once. */
export const appCommandAsks = (command: string): string | null => {
  if (SCRIPT.test(command)) return "It runs a project script.";
  const entry = APP_COMMAND_VOICE[command as StaticCommand];
  if (entry === undefined) return null;
  return isVoiced(entry) ? (entry.asks ?? null) : null;
};

/** What she says after the app answered: ran, nothing open could take it, or an app too old for it. */
export const appCommandLine = (command: string, result: "ran" | "idle" | "absent"): string => {
  const entry = APP_COMMAND_VOICE[command as StaticCommand];
  const script = SCRIPT.exec(command)?.[1];
  if (result === "absent") return "The app here is too old to take commands by voice.";
  if (result === "idle")
    return script !== undefined
      ? `No open project has a ${script} script.`
      : `Nothing open can ${entry !== undefined && isVoiced(entry) ? entry.say : command} right now.`;
  if (script !== undefined) return `Started the ${script} script.`;
  return entry !== undefined && isVoiced(entry) ? entry.done : "Done.";
};
