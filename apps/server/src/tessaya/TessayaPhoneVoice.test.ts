import { describe, expect, it } from "vite-plus/test";

import { NOT_AVAILABLE, parseTranscript, transcribeWav } from "./TessayaPhoneVoice.ts";

const wav = new Uint8Array(64);

describe("the phone's push-to-talk", () => {
  it("reads the sidecar's text line and skips its other lines", () => {
    expect(
      parseTranscript(
        '{"ev":"loaded","loadMs":900}\n{"file":"/t/say.wav","text":" what needs me ","audioMs":2000}\n',
      ),
    ).toBe("what needs me");
    expect(parseTranscript('{"file":"/t/say.wav","error":"bad"}')).toBeNull();
  });
  it("says plainly when the server has no sidecar or model", async () => {
    const out = await transcribeWav({ wav, env: {}, userdataDir: "/x", exists: () => false });
    expect(out).toEqual({ ok: false, why: NOT_AVAILABLE });
  });
  it("runs the sidecar's transcribe on the recording and returns the words", async () => {
    const seen: string[][] = [];
    const out = await transcribeWav({
      wav,
      env: { BATON_DICTATION: "/bin/side", BATON_STT_MODEL: "/m/model.gguf" },
      userdataDir: "/x",
      exists: () => true,
      run: async (_b, args) => (seen.push([...args]), '{"file":"f","text":"approve the plan"}'),
    });
    expect(out).toEqual({ ok: true, text: "approve the plan" });
    expect(seen[0]!.slice(0, 3)).toEqual(["transcribe", "--model", "/m/model.gguf"]);
  });
  it("tells him when the model fails or hears nothing", async () => {
    const base = {
      wav,
      env: { BATON_DICTATION: "/b", BATON_STT_MODEL: "/m" },
      userdataDir: "/x",
      exists: () => true,
    };
    expect(
      (await transcribeWav({ ...base, run: async () => Promise.reject(new Error("x")) })).ok,
    ).toBe(false);
    expect(
      await transcribeWav({ ...base, run: async () => '{"file":"f","text":""}' }),
    ).toMatchObject({ ok: false, why: "I could not hear anything in that." });
  });
});
