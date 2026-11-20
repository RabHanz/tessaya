import { biasTranscript } from "@t3tools/tessaya-shared/vocabulary";
import { describe, expect, it } from "vite-plus/test";

import { servedVocabulary } from "./vocabulary.ts";

const URL = "http://brain.test/api/devices/r1/v1/chat/completions";
const answering =
  (status: number, body: unknown, seen: Array<string> = []): typeof fetch =>
  async (input, init) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    return new Response(JSON.stringify(body), { status });
  };

describe("his dictionary in the room", () => {
  it("is fetched on the device key and reaches the room's correction", async () => {
    const seen: Array<string> = [];
    const served = await servedVocabulary(
      URL,
      "key-1",
      answering(
        200,
        {
          entries: [
            { phrase: "Kubernetes", replacement: null },
            { phrase: "Optima", replacement: null },
            { bad: 1 },
          ],
          ordinary: ["optimal", 7],
        },
        seen,
      ),
    );
    expect(seen).toEqual(["http://brain.test/api/devices/r1/v1/vocabulary Bearer key-1"]);
    expect(served?.entries).toEqual([
      expect.objectContaining({ phrase: "Kubernetes" }),
      expect.objectContaining({ phrase: "Optima" }),
    ]);
    expect(
      biasTranscript("restart the Kubernetis pods, it is optimal", served?.entries ?? [], {
        ordinary: served?.ordinary ?? new Set(),
      }),
    ).toBe("restart the Kubernetes pods, it is optimal");
  });

  it("is null from an older or failing server, so the loop keeps what it had", async () => {
    expect(await servedVocabulary(URL, "k", answering(404, {}))).toBeNull();
    expect(await servedVocabulary(URL, "k", answering(200, { other: [] }))).toBeNull();
    expect(
      await servedVocabulary(URL, "k", async () => {
        throw new Error("down");
      }),
    ).toBeNull();
  });
});
