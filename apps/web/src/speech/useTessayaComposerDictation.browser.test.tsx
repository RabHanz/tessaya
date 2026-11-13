import type { ComposerDictationMessage, ComposerDictationReply } from "@t3tools/baton-contracts";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import type { SpeechStreamText } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
function Composer(props: {
  readonly speech: Speech;
  readonly commitTo?: string;
  readonly name?: string;
}) {
  const label = (what: string) => (props.name === undefined ? what : `${what} ${props.name}`);
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
      <textarea aria-label={label("Draft")} readOnly value={draft.text} />
      <output aria-label={label("Phase")}>{dictation.state.phase}</output>
      {/* Like the composer's microphone: pressing it leaves the keyboard where it was. */}
      <button type="button" onPointerDown={(event) => event.preventDefault()}>
        {label("Mic")}
      </button>
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

it("tells the desktop when its chat box takes the next dictation, so it is claimed before any pill shows", async () => {
  using channel = desktop();
  await using screen = await render(
    <>
      <Composer speech={idle} />
      <button type="button">Elsewhere</button>
      <input aria-label="Search" />
    </>,
    { router: false },
  );
  (screen.getByLabelText("Draft").element() as HTMLTextAreaElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(true);
  // A button takes the keyboard without being somewhere to write: the chat box still takes it.
  (screen.getByRole("button", { name: "Elsewhere" }).element() as HTMLButtonElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(true);
  (screen.getByLabelText("Search").element() as HTMLInputElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(false);
});

/** Two thread panes side by side, each with its transcript and chat box, and a text field outside both. */
const twoPanes = (
  <>
    <section>
      <p>Transcript A</p>
      <Composer speech={idle} name="A" />
    </section>
    <section>
      <p>Transcript B</p>
      <Composer speech={idle} name="B" />
    </section>
    <input aria-label="Search" />
  </>
);

it("dictates into the pane he pressed, not the one that still has the keyboard", async () => {
  using channel = desktop();
  await using screen = await render(twoPanes, { router: false });
  const draftA = screen.getByLabelText("Draft A").element() as HTMLTextAreaElement;
  draftA.focus();
  channel.send({ type: "start", id: 1, mode: "free" });
  expect(channel.send({ type: "commit", id: 1, text: "First." })).toMatchObject({ ok: true });
  await expect
    .element(screen.getByLabelText("Draft A"))
    .toHaveValue(expect.stringContaining("First."));

  // B's microphone: the keyboard stays in A's editor, yet B is where he asked for it.
  await userEvent.click(screen.getByRole("button", { name: "Mic B" }));
  expect(document.activeElement).toBe(draftA);
  expect(channel.send({ type: "start", id: 2, mode: "free" })).toEqual({
    type: "claimed",
    id: 2,
    ok: true,
  });
  await expect.element(screen.getByLabelText("Phase B")).toHaveTextContent("listening");
  await expect.element(screen.getByLabelText("Phase A")).not.toHaveTextContent("listening");
  channel.send({ type: "cancel", id: 2 });

  // The hotkey after a click on A's transcript: the keyboard went nowhere, the pane under it is A.
  await userEvent.click(screen.getByText("Transcript A"));
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(true);
  expect(channel.send({ type: "start", id: 3, mode: "held" })).toMatchObject({ ok: true });
  await expect.element(screen.getByLabelText("Phase A")).toHaveTextContent("listening");
  await expect.element(screen.getByLabelText("Phase B")).toHaveTextContent("idle");
});

it("keeps a dictation in its pane when the keyboard moves away mid-dictation", async () => {
  using channel = desktop();
  await using screen = await render(twoPanes, { router: false });
  await userEvent.click(screen.getByText("Transcript B"));
  expect(channel.send({ type: "start", id: 4, mode: "held" })).toMatchObject({ ok: true });

  (screen.getByLabelText("Draft A").element() as HTMLTextAreaElement).focus();
  (screen.getByLabelText("Search").element() as HTMLInputElement).focus();
  channel.send({ type: "words", id: 4, text: "still here" });
  expect(channel.send({ type: "commit", id: 4, text: "Still here." })).toMatchObject({ ok: true });
  await expect
    .element(screen.getByLabelText("Draft B"))
    .toHaveValue(expect.stringContaining("Still here."));
  await expect.element(screen.getByLabelText("Draft A")).toHaveValue(DRAFT);
});

it("leaves the dictation to the desktop when no chat box was chosen or another field has the keyboard", async () => {
  using channel = desktop();
  await using screen = await render(twoPanes, { router: false });
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(false);
  expect(channel.send({ type: "start", id: 5, mode: "free" })).toMatchObject({ ok: false });

  (screen.getByLabelText("Draft A").element() as HTMLTextAreaElement).focus();
  (screen.getByLabelText("Search").element() as HTMLInputElement).focus();
  expect(channel.bridge.setComposerFocus).toHaveBeenLastCalledWith(false);
  expect(channel.send({ type: "start", id: 6, mode: "free" })).toMatchObject({ ok: false });
  await expect.element(screen.getByLabelText("Phase A")).toHaveTextContent("idle");
  await expect.element(screen.getByLabelText("Phase B")).toHaveTextContent("idle");
});
