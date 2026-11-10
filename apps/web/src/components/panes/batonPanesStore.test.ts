import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { adoptStoredComposerDrafts, startedAtHome, useBatonPanesStore } from "./batonPanesStore";

describe("pane restore", () => {
  it("is decided by the page the window opened on", () => {
    expect(startedAtHome("")).toBe(true);
    expect(startedAtHome("#/")).toBe(true);
    expect(startedAtHome("#/box/thread")).toBe(false);
    expect(startedAtHome("#/pair")).toBe(false);
  });

  it("is dropped once any page but home shows, so a later visit home starts fresh", () => {
    // Off the desktop app nothing resumes: web tabs share one layout.
    expect(useBatonPanesStore.getState().restorePending).toBe(false);
    useBatonPanesStore.setState({ restorePending: true });
    useBatonPanesStore.getState().noteLocation("/");
    expect(useBatonPanesStore.getState().restorePending).toBe(true);
    for (const pathname of ["/box/thread", "/pair", "/connect", "/welcome"]) {
      useBatonPanesStore.setState({ restorePending: true });
      useBatonPanesStore.getState().noteLocation(pathname);
      expect(useBatonPanesStore.getState().restorePending).toBe(false);
    }
  });
});

describe("another window writing the drafts", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const threadId = ThreadId.make("thread-held");
  const draftId = DraftId.make("draft-held");
  const threadRef = scopeThreadRef(environmentId, threadId);

  const holdDraftWithImage = () => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(
      scopeProjectRef(environmentId, ProjectId.make("project-a")),
      draftId,
      { threadId },
    );
    const file = new File(["png"], "image.png", { type: "image/png" });
    store.addImages(threadRef, [
      {
        type: "image",
        id: "img-held",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: file.size,
        previewUrl: "blob:img-held",
        file,
      },
    ]);
    useBatonPanesStore.setState({
      slots: [{ id: "a", target: { kind: "server", threadRef } }],
      focusedSlotId: "a",
    });
  };

  // What another window wrote, read back the way a storage event rehydrates it.
  const otherWindowWrote = (written: ReturnType<typeof useComposerDraftStore.getState>) => {
    const stored = partializeComposerDraftStoreState(written);
    const { merge } = useComposerDraftStore.persist.getOptions();
    return vi.spyOn(useComposerDraftStore.persist, "rehydrate").mockImplementation(() => {
      useComposerDraftStore.setState(
        merge!(stored, useComposerDraftStore.getState()) as ReturnType<
          typeof useComposerDraftStore.getState
        >,
      );
    });
  };

  it("keeps an image in a held thread whose draft still sits under its draft id", async () => {
    holdDraftWithImage();
    // The image never reached localStorage: blobs serialize late, and large ones miss the quota.
    using _rehydrate = otherWindowWrote(useComposerDraftStore.getState());

    await adoptStoredComposerDrafts();

    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(threadRef)
        ?.images.map(({ id }) => id),
    ).toEqual(["img-held"]);
  });

  it("does not bring back a draft the other window sent", async () => {
    holdDraftWithImage();
    const held = useComposerDraftStore.getState();
    const store = useComposerDraftStore.getState();
    store.markDraftThreadPromoting(draftId, threadRef);
    store.finalizePromotedDraftThread(draftId);
    store.clearComposerContent(draftId);
    const sent = useComposerDraftStore.getState();
    useComposerDraftStore.setState(held);
    using _rehydrate = otherWindowWrote(sent);

    await adoptStoredComposerDrafts();

    const after = useComposerDraftStore.getState();
    expect(after.draftThreadsByThreadKey[draftId]).toBeUndefined();
    expect(after.draftsByThreadKey[draftId]).toBeUndefined();
  });
});
