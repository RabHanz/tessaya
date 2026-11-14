import { describe, expect, it } from "vite-plus/test";

import { checkRewrite, rewriteMessage } from "./dictationCleanup.ts";
import { makeStyleIndex, pairsFromWispr } from "./stylePairs.ts";

const row = (
  id: string,
  asrText: string,
  formattedText: string,
  editedText: string | null = null,
) => ({
  transcriptEntityId: id,
  asrText,
  formattedText,
  editedText,
  app: "chrome",
  url: null,
});

describe("his past dictations as examples", () => {
  const pairs = pairsFromWispr([
    row(
      "a",
      "pick up a few things from the shop bread oat milk and apples",
      "Pick up a few things from the shop:\n\n<ul>\n<li>Bread</li>\n<li>Oat milk</li>\n<li>Apples</li>\n</ul>",
    ),
    row(
      "b",
      "the deploy failed again on the staging box tonight",
      "The deploy failed again on the staging box tonight.",
    ),
    row(
      "c",
      "send the invoice to the client by friday please",
      "Send the invoice to the client by Friday, please.",
      "Send the invoice by Friday.",
    ),
    row("d", "ok", "OK"),
  ]);

  it("keeps what he kept, lists as pasted text, and skips the ones too short to teach anything", () => {
    expect(pairs.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(pairs[0]!.kept).toBe(
      "Pick up a few things from the shop:\n\n- Bread\n- Oat milk\n- Apples",
    );
    expect(pairs[2]!.kept).toBe("Send the invoice by Friday.");
  });

  it("finds the most alike, never the dictation itself or the pair it is told to leave out", () => {
    const index = makeStyleIndex(pairs);
    const near = index.nearest(
      "can you pick up a few things from the shop on the way",
      "default",
      2,
    );
    expect(near[0]!.id).toBe("a");
    expect(index.nearest(pairs[1]!.raw, "default", 3).map((p) => p.id)).not.toContain("b");
    expect(
      index.nearest("pick up a few things from the shop", "default", 3, "a").map((p) => p.id),
    ).not.toContain("a");
    // Nothing in common: no example at all, rather than a random one.
    expect(index.nearest("zebra quantum violin", "default")).toEqual([]);
  });

  it("puts them before the dictation, and refuses an answer that copies their wrapper", () => {
    const message = rewriteMessage("buy some eggs", "default", {}, [pairs[0]!]);
    expect(message).toContain("<said>pick up a few things");
    expect(message.endsWith("<dictation>buy some eggs</dictation>")).toBe(true);
    expect(rewriteMessage("buy some eggs", "default")).toBe(
      "Mode: default\n<dictation>buy some eggs</dictation>",
    );
    expect(checkRewrite("Buy some eggs.", "<kept>Buy some eggs.</kept>").ok).toBe(false);
  });
});
