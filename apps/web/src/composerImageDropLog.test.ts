import { describe, expect, it } from "vite-plus/test";
import { create } from "zustand";

import { DRAFT_IMAGE_DROP_LOG_PREFIX, watchDraftImageDrops } from "./composerImageDropLog";

type Drafts = Record<string, { prompt: string; images: ReadonlyArray<{ id: string }> }>;
const chip = "![image.png](t3-context://v1/image/image_img-1)";

describe("draft image drop log", () => {
  it("logs one line when an image vanishes while its chip stays, and none for a send", () => {
    const store = create<{ draftsByThreadKey: Drafts }>(() => ({
      draftsByThreadKey: { "draft-1": { prompt: `look ${chip}`, images: [{ id: "img-1" }] } },
    }));
    const lines: string[] = [];
    const stop = watchDraftImageDrops(store, (line) => lines.push(line));

    store.setState({ draftsByThreadKey: { "draft-1": { prompt: `look ${chip}`, images: [] } } });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!.slice(DRAFT_IMAGE_DROP_LOG_PREFIX.length));
    expect(entry).toMatchObject({ key: "draft-1", imageId: "img-1", chip: "yes", path: "setter" });
    expect(typeof entry.sinceAttachMs).toBe("number");
    expect(lines[0]).not.toContain("look");

    // A send clears the chip with the image: nothing to explain.
    store.setState({
      draftsByThreadKey: {
        "draft-2": { prompt: chip.replace("img-1", "img-2"), images: [{ id: "img-2" }] },
      },
    });
    store.setState({ draftsByThreadKey: {} });
    expect(lines).toHaveLength(1);
    stop();
  });
});
