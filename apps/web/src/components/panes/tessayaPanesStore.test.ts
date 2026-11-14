import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  adoptStoredComposerDrafts,
  startedAtHome,
  useTessayaPanesStore,
} from "./tessayaPanesStore";

describe("pane restore", () => {
  it("is decided by the page the window opened on", () => {
    expect(startedAtHome("")).toBe(true);
    expect(startedAtHome("#/")).toBe(true);
    expect(startedAtHome("#/box/thread")).toBe(false);
    expect(startedAtHome("#/pair")).toBe(false);
  });

  it("is dropped once any page but home shows, so a later visit home starts fresh", () => {
    // Off the desktop app nothing resumes: web tabs share one layout.
    expect(useTessayaPanesStore.getState().restorePending).toBe(false);
    useTessayaPanesStore.setState({ restorePending: true });
    useTessayaPanesStore.getState().noteLocation("/");
    expect(useTessayaPanesStore.getState().restorePending).toBe(true);
    for (const pathname of ["/box/thread", "/pair", "/connect", "/welcome"]) {
      useTessayaPanesStore.setState({ restorePending: true });
      useTessayaPanesStore.getState().noteLocation(pathname);
      expect(useTessayaPanesStore.getState().restorePending).toBe(false);
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
    useTessayaPanesStore.setState({
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

  const typedDraft = (ref: typeof threadRef) => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(ref, "typed earlier");
    const file = new File(["png"], "old.png", { type: "image/png" });
    store.addImages(ref, [
      {
        type: "image",
        id: "img-old",
        name: "old.png",
        mimeType: "image/png",
        sizeBytes: file.size,
        previewUrl: "blob:img-old",
        file,
      },
    ]);
    return useComposerDraftStore.getState();
  };

  it("keeps a draft he cleared cleared when the other window still had it", async () => {
    const ref = scopeThreadRef(environmentId, ThreadId.make("thread-cleared"));
    useTessayaPanesStore.setState({
      slots: [{ id: "a", target: { kind: "server", threadRef: ref } }],
    });
    const stale = typedDraft(ref);
    useComposerDraftStore.getState().clearComposerContent(ref);
    using _rehydrate = otherWindowWrote(stale);

    await adoptStoredComposerDrafts();

    expect(useComposerDraftStore.getState().getComposerDraft(ref)).toBeNull();
  });

  it("a page that only mirrors the drafts (Tessaya's embedded page) takes what the window he types in wrote", async () => {
    const ref = scopeThreadRef(environmentId, ThreadId.make("thread-mirrored"));
    // Same pane key as the main window, so it holds his threads without ever showing a composer.
    const slots = [{ id: "a" as const, target: { kind: "server" as const, threadRef: ref } }];
    useTessayaPanesStore.setState({ slots });
    const stale = partializeComposerDraftStoreState(typedDraft(ref));
    useComposerDraftStore.getState().clearComposerContent(ref);
    const cleared = partializeComposerDraftStoreState(useComposerDraftStore.getState());

    vi.resetModules();
    const mirror = await import("../../composerDraftStore");
    const mirrorPanes = await import("./tessayaPanesStore");
    mirrorPanes.useTessayaPanesStore.setState({ slots });
    const { merge } = mirror.useComposerDraftStore.persist.getOptions();
    const storageHas = (stored: typeof stale) =>
      vi.spyOn(mirror.useComposerDraftStore.persist, "rehydrate").mockImplementation(() => {
        mirror.useComposerDraftStore.setState(
          merge!(stored, mirror.useComposerDraftStore.getState()) as ReturnType<
            typeof mirror.useComposerDraftStore.getState
          >,
        );
      });
    {
      using _loaded = storageHas(stale);
      await mirrorPanes.adoptStoredComposerDrafts();
    }
    expect(mirror.useComposerDraftStore.getState().getComposerDraft(ref)?.prompt).toBe(
      "typed earlier",
    );

    using _deleted = storageHas(cleared);
    await mirrorPanes.adoptStoredComposerDrafts();

    // Kept, it would write the old text and image back and the composer would take them again.
    expect(mirror.useComposerDraftStore.getState().getComposerDraft(ref)).toBeNull();
  });
});
