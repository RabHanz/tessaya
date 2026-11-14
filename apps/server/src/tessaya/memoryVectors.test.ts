import { describe, expect, it } from "vite-plus/test";

import { clsPool, nearest, rrf, vectorFromBytes, vectorToBytes } from "./memoryVectors.ts";

const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs, (x) => x / n);
};

describe("recall by meaning", () => {
  it("takes the first token's vector and scales it to length 1", () => {
    const pooled = clsPool(Float32Array.from([1, 2, 9, 9]), 2);
    expect(Array.from(pooled).map((x) => Number(x.toFixed(4)))).toEqual([0.4472, 0.8944]);
  });

  it("ranks by cosine, nearest first, leaving out what is below the floor", () => {
    const query = unit(1, 0, 0);
    const hits = nearest(
      query,
      [
        { key: "far", vector: unit(0, 1, 0) },
        { key: "close", vector: unit(1, 0.1, 0) },
        { key: "closer", vector: unit(1, 0.01, 0) },
        { key: "middling", vector: unit(1, 1, 0) },
      ],
      3,
      0.5,
    );
    expect(hits.map((h) => h.key)).toEqual(["closer", "close", "middling"]);
  });

  it("blends two rankings: an item in both beats one at the top of only one", () => {
    const score = rrf([
      ["keyword-top", "both", "keyword-only"],
      ["meaning-top", "both"],
    ]);
    const order = [...score.entries()].toSorted((a, b) => b[1] - a[1]).map(([key]) => key);
    expect(order[0]).toBe("both");
    expect(order).toContain("meaning-top");
  });

  it("keeps a vector as bytes and reads the same numbers back", () => {
    const v = unit(0.3, -0.2, 0.9);
    expect(Array.from(vectorFromBytes(vectorToBytes(v)))).toEqual(Array.from(v));
  });
});
