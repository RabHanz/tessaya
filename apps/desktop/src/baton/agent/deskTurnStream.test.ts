import { describe, expect, it } from "vite-plus/test";

import { readDeskTurn } from "./deskTurnStream.ts";

const streamOf = (parts: ReadonlyArray<string>) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });

describe("her words from the server's desk turn", () => {
  it("reads words split across chunks, in order, up to the end", async () => {
    const said: Array<string> = [];
    await readDeskTurn(
      streamOf([
        'data: {"words":"It\'s ',
        'Notepad. "}\n\ndata: {"words":"Done."}\n',
        "\ndata: [DONE]\n\n",
      ]),
      (w) => said.push(w),
    );
    expect(said).toEqual(["It's Notepad. ", "Done."]);
  });

  it("fails when the stream ends before her turn did", async () => {
    await expect(
      readDeskTurn(streamOf(['data: {"words":"It"}\n\n']), () => undefined),
    ).rejects.toThrow("stopped before");
  });
});
