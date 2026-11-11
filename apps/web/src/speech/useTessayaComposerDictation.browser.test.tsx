import type { ComposerDictationMessage, ComposerDictationReply } from "@t3tools/baton-contracts";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { SpeechStreamText } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { BatonDictationWords } from "../components/chat/BatonComposerDictation";
import { useTessayaComposerDictation } from "./useTessayaComposerDictation";

const DRAFT = "Let's ship the retry on Friday. Also add a test.";
const CARET = 32;

interface Speech {
  readonly state: VoiceInputState;
  readonly preview: SpeechStreamText | null;
}
const idle: Speech = { state: { phase: "idle", error: null, errorAction: null }, preview: null };
const recording = (committed: string, tentative = ""): Speech => ({
  state: { phase: "recording", error: null, errorAction: null },
  preview: { committed, tentative } as SpeechStreamText,
});

/** A chat box: its draft in state, the dictation hook over it, the words drawn where the editor is. */
function Composer(props: { readonly speech: Speech; readonly commitTo?: string }) {
  const [draft, setDraft] = useState({ text: DRAFT, selection: { start: CARET, end: CARET } });
  const root = useRef<HTMLFormElement>(null);
  const dictation = useTessayaComposerDictation({
    speech: {
      ...props.speech,
      level: 0,
      stop: async () => {},
      cancel: () => {},
      skipPostProcessing: () => {},
    },
    readDraft: () =>
      props.commitTo !== undefined
        ? { text: props.commitTo, selection: { start: 0, end: 0 } }
        : draft,
    commitDraft: (text, selection) => setDraft({ text, selection }),
    rootRef: root,
    disabled: false,
  });
  return (
    <form ref={root}>
      <textarea aria-label="Draft" readOnly value={draft.text} />
      <output aria-label="Phase">{dictation.state.phase}</output>
      <div style={{ position: "relative" }}>
        <BatonDictationWords state={dictation.state} />
      </div>
    </form>
  );
}

it("draws T3's live words at the caret and a cancel leaves the draft exactly as it was", async () => {
  await using screen = await render(<Composer speech={idle} />, { router: false });
  await screen.rerender(<Composer speech={recording("can you also", "check")} />);
  await expect
    .element(screen.getByLabelText("Dictation"))
    .toHaveTextContent("Let's ship the retry on Friday. can you also check Also add a test.");
  await expect.element(screen.getByLabelText("Draft")).toHaveValue(DRAFT);
  await screen.rerender(<Composer speech={idle} />);
  await expect.element(screen.getByLabelText("Phase")).toHaveTextContent("idle");
  await expect.element(screen.getByLabelText("Draft")).toHaveValue(DRAFT);
  expect(screen.container.querySelector("[data-tdc-words]")).toBeNull();
});

/** The desktop's channel, as the preload exposes it, installed until disposed. */
const desktop = () => {
  let handler: ((m: ComposerDictationMessage) => ComposerDictationReply | null) | null = null;
  const bridge = {
    onComposerDictation: (h: typeof handler) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    replyComposerDictation: vi.fn(),
    setComposerFocus: vi.fn(),
  };
  const host = globalThis as { batonDesktopBridge?: unknown };
  host.batonDesktopBridge = bridge;
  return {
    bridge,
    send: (m: ComposerDictationMessage) => handler?.(m) ?? null,
    [Symbol.dispose]: () => {
      delete host.batonDesktopBridge;
    },
  };
};

it("takes the desktop's dictation, commits its words at the caret in one go, and cancels to the same draft", async () => {
  using channel = desktop();
  await using screen = await render(<Composer speech={idle} />, { router: false });
  (screen.getByLabelText("Draft").element() as HTMLTextAreaElement).focus();

  expect(channel.send({ type: "start", id: 1, mode: "free" })).toEqual({
    type: "claimed",
    id: 1,
    ok: true,
  });
  channel.send({ type: "words", id: 1, text: "never mind" });
  await expect
    .element(screen.getByLabelText("Dictation"))
    .toHaveTextContent("Let's ship the retry on Friday. never mind Also add a test.");
  channel.send({ type: "cancel", id: 1 });
  await expect.element(screen.getByLabelText("Phase")).toHaveTextContent("idle");
  await expect.element(screen.getByLabelText("Draft")).toHaveValue(DRAFT);

  channel.send({ type: "start", id: 2, mode: "held" });
  channel.send({ type: "words", id: 2, text: "um can you check the cold start" });
  expect(channel.send({ type: "commit", id: 2, text: "Can you check the cold start?" })).toEqual({
    type: "took",
    id: 2,
    ok: true,
  });
  await expect
    .element(screen.getByLabelText("Draft"))
    .toHaveValue("Let's ship the retry on Friday. Can you check the cold start? Also add a test.");
  await expect.element(screen.getByLabelText("Phase")).toHaveTextContent("idle");
});

it("leaves the words to the desktop's paste when the draft changed under the dictation", async () => {
  using channel = desktop();
  await using screen = await render(<Composer speech={idle} />, { router: false });
  (screen.getByLabelText("Draft").element() as HTMLTextAreaElement).focus();
  channel.send({ type: "start", id: 3, mode: "held" });
  await screen.rerender(<Composer speech={idle} commitTo="Someone else typed this" />);
  expect(channel.send({ type: "commit", id: 3, text: "Hello" })).toEqual({
    type: "took",
    id: 3,
    ok: false,
  });
  await expect.element(screen.getByLabelText("Draft")).toHaveValue(DRAFT);
});

it("tells the desktop when its chat box has the keyboard, so a dictation is claimed before any pill shows", async () => {
  using channel = desktop();
  await using screen = await render(
    <>
      <Composer speech={idle} />
      <button type="button">Elsewhere</button>
    </>,
    { router: false },
  );
  (screen.getByLabelText("Draft").element() as HTMLTextAreaElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(true);
  (screen.getByRole("button", { name: "Elsewhere" }).element() as HTMLButtonElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(false);
});
