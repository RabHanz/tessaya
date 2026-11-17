// @effect-diagnostics globalConsole:off globalTimers:off
/**
 * A sample whose `claude` gave no answer at all is run again after a wait, never scored as the model's. Its auto-updater
 * reinstalls the binary while a run goes on, and a failed start takes milliseconds, so without the wait one outage of a
 * few seconds fails every case after it.
 */
export const retried = async <A>(
  label: string,
  run: () => Promise<A>,
  waitsMs: ReadonlyArray<number> = [10_000, 30_000, 60_000],
): Promise<A> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      console.error(`error  ${label}: ${error instanceof Error ? error.message : String(error)}`);
      const wait = waitsMs[attempt];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
};

/** A `claude -p --output-format stream-json` run's output, or why it is not an answer: no result, or an error result. */
export const answerOf = (stdout: string, code: number | null, stderr: string): string => {
  const result = stdout
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; is_error?: boolean; result?: string };
      } catch {
        return {};
      }
    })
    .find((event) => event.type === "result");
  if (result === undefined || result.is_error === true)
    throw new Error(
      `claude gave no answer (exit ${code ?? "signal"}): ${(result?.result ?? stderr).trim().split("\n").at(-1) ?? ""}`,
    );
  return stdout;
};
