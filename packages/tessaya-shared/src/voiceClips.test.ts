import { describe, expect, it } from "vite-plus/test";

import { affectReference, cloneReference, registerReferences } from "./voiceClips.ts";

describe("voice references (VOXTA G1)", () => {
  it("gives Pocket a clone's tone or the clone itself only as a URL, and forgets ones re-listed away", () => {
    registerReferences("c1", {
      embedding: "http://127.0.0.1:3773/tessaya/voice/embedding/k/c1.safetensors",
      "affect-tender":
        "http://127.0.0.1:3773/tessaya/voice/embedding/k/c1.affect-tender.safetensors",
      "affect-whisper": "/local/path.safetensors",
    });
    expect(affectReference("c1", "tender")).toMatch(/c1\.affect-tender\.safetensors$/);
    expect(cloneReference("c1")).toMatch(/c1\.safetensors$/);
    // Pocket refuses a local path, so such a reference is never handed to it.
    expect(affectReference("c1", "whisper")).toBeUndefined();
    registerReferences("c1", {});
    expect(affectReference("c1", "tender")).toBeUndefined();
    expect(cloneReference("c1")).toBeUndefined();
  });
});
