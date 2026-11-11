/* oxlint-disable t3code/no-low-value-comments, t3code/no-unreasoned-state-sync -- Baton file predating upstream's rule (D82) */
/**
 * One line, above the Fleet: say what you want.
 *
 * This is where the Director's dictation lands today. iOS dictation, Wispr
 * Flow, a DJI receiver through his own speech-to-text — all of them produce
 * text into a focused field, and the fork's job starts at the text. There is no
 * microphone in here and there should not be one: a phone, a laptop and a
 * keyboard should mean the same thing to the environment.
 *
 * The line under the input is the confirmation step, not decoration. A surface
 * fed by dictation mishears, and the difference between a useful assistant and
 * a dangerous one is whether "Tell Claude on Scheduler: run the migration
 * tests" can be read and stopped before it happens.
 *
 * One sentence never leaves this component: dictation. "Dictate: thanks, I'll
 * send the revised contract tomorrow" is an email to somebody else, not work,
 * and an environment has no business receiving it or writing it to an intent
 * log. The client classifies it first and refuses by name when there is
 * nowhere to put the words (§12.3, §18).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  batonDesktopBridge,
  type BatonIntentResolution,
  type BatonJobBridgeRequest,
  type BatonCommitmentBridgeRequest,
  type BatonPhoneBridgeRequest,
  type BatonCloudBridgeRequest,
  type BatonWeaveBridgeRequest,
  type BatonMemoryBridgeRequest,
  type EnvironmentId,
} from "@t3tools/baton-contracts";
import { classifyDictation } from "@t3tools/baton-shared/dictation";

import { cn, randomUUID } from "~/lib/utils";
import { dictationModeLabel, dictationRefusal } from "../../batonContextView";
import { goesToLead, leadAskSettled, previewResolution } from "../../batonIntentView";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { Input } from "../ui/input";
import { useAtomCommand } from "../../state/use-atom-command";

/** Long enough that typing does not round-trip per keystroke. */
const PREVIEW_DEBOUNCE_MS = 400;
/** How often an ask left for the lead is re-read until it is answered. */
const LEAD_POLL_MS = 1_500;

export interface BatonIntentBarProps {
  readonly environmentId: EnvironmentId;
  /** This app's own server, where the desktop assistant's spoken sentences go; they fail while it is not connected. */
  readonly deskEnvironmentId?: EnvironmentId | undefined;
  /** §14 rung 3: what the user is looking at, when the client knows. */
  readonly focusedWorkSessionId: string | null;
  /** Called after a sentence runs, so the log and the fleet re-read. */
  readonly onRan: () => void;
  /** The desktop assistant's job tools (D145), answered with the job RPCs. */
  readonly onJob?: (request: BatonJobBridgeRequest) => Promise<unknown>;
  /** The desktop assistant's memory calls (D150), answered with the memory RPCs. */
  readonly onMemory?: (request: BatonMemoryBridgeRequest) => Promise<unknown>;
  /** The desktop assistant's commitments ledger (D149), answered with the commitments RPCs. */
  /** The desktop assistant's weave calls (D149), answered with the weave RPCs. */
  readonly onWeave?: (request: BatonWeaveBridgeRequest) => Promise<unknown>;
  readonly onPhone?: (request: BatonPhoneBridgeRequest) => Promise<unknown>;
  readonly onCloud?: (request: BatonCloudBridgeRequest) => Promise<unknown>;
  readonly onCommitments?: (request: BatonCommitmentBridgeRequest) => Promise<unknown>;
}

let voiceListenerClaimed = false;

export function BatonIntentBar(props: BatonIntentBarProps): ReactNode {
  const [text, setText] = useState("");
  // The words the preview belongs to travel with it. A preview for a sentence
  // the user has since changed is worse than no preview: this line is the
  // confirmation step, and it must never describe something else.
  const [resolution, setResolution] = useState<{
    readonly text: string;
    readonly resolution: BatonIntentResolution;
  } | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  /** An ask left for the lead (the one assistant) on this bar's server, re-read until it settles. */
  const [leadAsk, setLeadAsk] = useState<{ readonly id: string; readonly at: number } | null>(null);
  /** §12.3's mode. While it is on, ordinary words are text, not instructions. */
  const [dictating, setDictating] = useState(false);
  const resolveIntent = useAtomCommand(batonWorkSessions.intentResolve, { reportFailure: false });
  const runIntent = useAtomCommand(batonWorkSessions.intentRun, { reportFailure: false });
  const phoneCall = useAtomCommand(batonWorkSessions.phoneCall, { reportFailure: false });
  const latest = useRef(0);

  // Resolve while typing. `intentResolve` is a read: it decides what the words
  // would mean and does none of it, which is why the preview can be live.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const ticket = latest.current + 1;
    latest.current = ticket;
    const timer = setTimeout(() => {
      void resolveIntent({
        environmentId: props.environmentId,
        input: {
          text: trimmed,
          focusedWorkSessionId: props.focusedWorkSessionId as never,
        },
      }).then((result) => {
        // A slower answer to an older sentence must not overwrite a newer one.
        if (latest.current !== ticket) return;
        setResolution(
          result._tag === "Success" ? { text: trimmed, resolution: result.value.resolution } : null,
        );
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, props.environmentId, props.focusedWorkSessionId, resolveIntent]);

  const {
    deskEnvironmentId,
    focusedWorkSessionId,
    onRan,
    onJob,
    onMemory,
    onCommitments,
    onWeave,
    onPhone,
    onCloud,
  } = props;
  const ownsVoice = useRef(false);
  // The desktop voice core's intent calls, answered with this bar's own RPCs:
  // spoken sentences meet the same grammar and gates as typed ones. Dictation
  // never arrives here (the desktop pastes it and the words stay local).
  useEffect(() => {
    const subscribe = batonDesktopBridge()?.onBatonVoiceRequest;
    // The bar can be on screen twice (landing and sidebar); one must answer.
    if (subscribe === undefined || voiceListenerClaimed) return;
    voiceListenerClaimed = true;
    ownsVoice.current = true;
    const unsubscribe = subscribe(async (request) => {
      if (request.kind === "memory") {
        if (onMemory === undefined) throw new Error("Memory is not available here.");
        return onMemory(request);
      }
      if (request.kind === "phone") {
        if (onPhone === undefined) throw new Error("The phone relay is not available here.");
        return onPhone(request);
      }
      if (request.kind === "cloud") {
        if (onCloud === undefined) throw new Error("Cloud tasks are not available here.");
        return onCloud(request);
      }
      if (request.kind === "weave") {
        if (onWeave === undefined) throw new Error("Weaving is not available here.");
        return onWeave(request);
      }
      if (request.kind === "commitments") {
        if (onCommitments === undefined) throw new Error("Commitments are not available here.");
        return onCommitments(request);
      }
      if (request.kind === "job") {
        if (onJob === undefined) throw new Error("Jobs are not available here.");
        return onJob(request);
      }
      if (deskEnvironmentId === undefined)
        throw new Error("This app's own server is not connected.");
      const environmentId = deskEnvironmentId;
      const input = {
        text: request.text,
        focusedWorkSessionId: request.focusedWorkSessionId as never,
      };
      if (request.kind === "resolve") {
        const result = await resolveIntent({
          environmentId,
          input: { ...input, allowModel: request.allowModel },
        });
        if (result._tag !== "Success") throw new Error("That could not be read.");
        return result.value.resolution;
      }
      const result = await runIntent({ environmentId, input });
      if (result._tag !== "Success") throw new Error("That could not be done. Nothing changed.");
      setReply(result.value.reply);
      onRan();
      return result.value;
    });
    return () => {
      unsubscribe();
      voiceListenerClaimed = false;
      ownsVoice.current = false;
    };
  }, [
    deskEnvironmentId,
    onRan,
    onJob,
    onMemory,
    onCommitments,
    onWeave,
    onPhone,
    onCloud,
    resolveIntent,
    runIntent,
  ]);
  useEffect(() => {
    if (ownsVoice.current) batonDesktopBridge()?.setBatonVoiceFocus?.(focusedWorkSessionId);
  }, [focusedWorkSessionId]);

  const submit = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || running) return;

    // Dictation first, and it stops here. Nothing about these words reaches an
    // environment — not the text, not the fact that they were said.
    const dictation = classifyDictation(trimmed, { dictating });
    if (dictation.kind === "stop") {
      setDictating(false);
      setText("");
      setResolution(null);
      setReply("Stopped dictating.");
      return;
    }
    if (dictation.kind === "start" || dictation.kind === "text") {
      setDictating(dictation.kind === "start");
      setText("");
      setResolution(null);
      // This client has no field of its own to type into and cannot reach
      // another application's. Saying so by name is the whole of §18's
      // honesty requirement; saying nothing is the failure it is written
      // against.
      setReply(
        dictationRefusal({
          report: null,
          targetReason: "This client cannot type into another application from here.",
        }),
      );
      return;
    }

    setRunning(true);
    void (async () => {
      // The grammar checks every sentence: what it places runs here, what it cannot place goes to the lead.
      const grammar =
        resolution?.text === trimmed
          ? resolution.resolution
          : await resolveIntent({
              environmentId: props.environmentId,
              input: { text: trimmed, focusedWorkSessionId: props.focusedWorkSessionId as never },
            }).then((result) => (result._tag === "Success" ? result.value.resolution : null));
      if (grammar !== null && goesToLead(grammar)) {
        const id = `web-${randomUUID()}`;
        // The same server the grammar just checked against: its own desktop answers.
        const result = await phoneCall({
          environmentId: props.environmentId,
          input: { op: "ask", args: { id, text: trimmed } },
        });
        const made =
          result._tag === "Success"
            ? (result.value.value as { ok?: boolean; line?: string })
            : null;
        setRunning(false);
        setReply(made?.line ?? "Tessaya is not reachable from here.");
        if (made?.ok !== true) return;
        setText("");
        setResolution(null);
        setLeadAsk({ id, at: Date.now() });
        return;
      }
      if (grammar?.outcome === "refused") {
        setRunning(false);
        setReply(grammar.refusal.message);
        return;
      }
      const result = await runIntent({
        environmentId: props.environmentId,
        input: { text: trimmed, focusedWorkSessionId: props.focusedWorkSessionId as never },
      });
      setRunning(false);
      if (result._tag === "Success") {
        setReply(result.value.reply);
        setResolution(null);
        setText("");
        props.onRan();
        return;
      }
      // The sentence resolved and the command failed. Saying so beats an empty
      // input that looks like it worked.
      setReply("That could not be done. Nothing changed.");
    })();
  };

  const { environmentId: askEnvironment } = props;
  // Reads the lead's answer from the server until it settles; the server expires an undelivered ask in minutes.
  useEffect(() => {
    if (leadAsk === null) return;
    const timer = setInterval(() => {
      void phoneCall({
        environmentId: askEnvironment,
        input: { op: "askGet", args: { id: leadAsk.id } },
      }).then((result) => {
        const got =
          result._tag === "Success"
            ? (result.value.value as { status?: string; line?: string } | null)
            : undefined;
        if (got?.line !== undefined) setReply(got.line);
        if (leadAskSettled(got, leadAsk.at, Date.now())) setLeadAsk(null);
      });
    }, LEAD_POLL_MS);
    return () => clearInterval(timer);
  }, [leadAsk, askEnvironment, phoneCall]);

  const trimmedText = text.trim();
  const shown =
    resolution !== null && resolution.text === trimmedText ? resolution.resolution : null;
  const preview = shown === null ? null : previewResolution(shown);

  return (
    <div className="px-2 pb-1 pt-1">
      {dictating ? (
        <p
          data-testid="sidebar-intent-dictating"
          className="pb-0.5 text-2xs leading-4 text-sidebar-foreground"
        >
          {/* The mode is never invisible: dictation the user has forgotten is
              on is how a sentence meant for an agent ends up in an email. */}
          {dictationModeLabel(null)}
        </p>
      ) : null}
      <Input
        nativeInput
        size="compact"
        type="text"
        data-testid="sidebar-intent-input"
        // What arms this field from a hotkey, a mic button, or an external
        // dictation tool that types into whatever has focus.
        // Legacy names (D71): this attribute and the id below keep "fabric" so
        // spots and tools set up before the rename still find the field.
        data-fabric-intent-input="true"
        // Chromium exposes the id as the UI Automation id: Airdeck's imported
        // spot finds this box by it (public/baton/airdeck-spots.json, D64).
        id="fabric-intent-input"
        value={text}
        disabled={running}
        placeholder="What needs me?"
        aria-label="Say what you want"
        // A phone keyboard says "go" rather than "return", and a spoken
        // sentence is a sentence: capitalised, spell-checked, not autocompleted
        // against a form history it has no business in.
        enterKeyHint="go"
        inputMode="text"
        autoCapitalize="sentences"
        autoComplete="off"
        autoCorrect="on"
        spellCheck
        onChange={(event) => {
          setText(event.target.value);
          setReply(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          submit();
        }}
      />
      {preview === null ? null : (
        <p
          data-testid="sidebar-intent-preview"
          className={cn(
            "truncate pt-0.5 text-2xs leading-4",
            preview.tone === "refused" ? "text-destructive" : "text-sidebar-muted-foreground",
            preview.weighty && "text-sidebar-foreground",
          )}
        >
          {preview.tone === "will" ? `↵ ${preview.line}` : preview.line}
        </p>
      )}
      {preview?.unplaced === null || preview === null ? null : (
        <p className="truncate text-2xs leading-4 text-sidebar-muted-foreground">
          {`could not place: ${preview.unplaced}`}
        </p>
      )}
      {reply === null ? null : (
        <p
          data-testid="sidebar-intent-reply"
          className="pt-0.5 text-2xs leading-4 text-sidebar-foreground"
        >
          {reply}
        </p>
      )}
    </div>
  );
}
