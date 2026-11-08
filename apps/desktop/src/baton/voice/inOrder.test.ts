import { describe, expect, it } from "vite-plus/test";

import { createInOrder } from "./inOrder.ts";

describe("dictations paste in the order he spoke them (0.1.79)", () => {
  it("a slow clean-up of the first never lets the second paste before it, and a failure does not stop the next", async () => {
    const inOrder = createInOrder();
    const pasted: string[] = [];
    let finishFirst: () => void = () => undefined;
    const firstCleanup = new Promise<void>((resolve) => (finishFirst = resolve));
    const first = inOrder(async () => {
      await firstCleanup;
      pasted.push("first");
    });
    const second = inOrder(async () => {
      pasted.push("second");
    });
    // The second's clean-up came back at once; it still waits for the first.
    await Promise.resolve();
    expect(pasted).toEqual([]);
    finishFirst();
    await Promise.all([first, second]);
    expect(pasted).toEqual(["first", "second"]);

    const failed = inOrder(async () => {
      throw new Error("the window went away");
    });
    await expect(failed).rejects.toThrow("the window went away");
    expect(await inOrder(async () => "third")).toBe("third");
  });
});
