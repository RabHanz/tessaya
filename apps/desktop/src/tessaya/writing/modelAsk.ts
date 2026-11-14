// @effect-diagnostics globalTimers:off
/**
 * One question to his own `claude` with no tools, for a rewrite that is not dictation clean-up
 * (a transform, a spoken command on a selection). A fresh session each time, disposed after, and it
 * gives up on its own.
 */
import { startVisionSession, type VisionSession } from "../screen/claudeVision.ts";

export type ModelAsk = (system: string, user: string) => Promise<string>;

export const createModelAsk = (input: {
  readonly claudeBinary: () => string;
  readonly model: () => string;
  readonly workDir: string;
  readonly env: () => NodeJS.ProcessEnv;
  readonly platform: string;
  readonly timeoutMs?: number;
  readonly start?: typeof startVisionSession;
}): ModelAsk => {
  const limit = input.timeoutMs ?? 40_000;
  return async (system, user) => {
    const session: VisionSession = (input.start ?? startVisionSession)({
      claudeBinary: input.claudeBinary(),
      model: input.model(),
      systemPrompt: system,
      workDir: input.workDir,
      env: input.env(),
      platform: input.platform,
      timeoutMs: limit,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (
        await Promise.race([
          session.ask([{ type: "text", text: user }]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timed out")), limit);
          }),
        ])
      ).trim();
    } finally {
      clearTimeout(timer);
      session.dispose();
    }
  };
};
