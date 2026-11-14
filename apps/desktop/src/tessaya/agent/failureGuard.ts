/**
 * The hands loop's stop rule, in code (D144). The prompt asks the model not to repeat a failed action more
 * than twice; this makes it true: a call that has failed twice in a row with the same arguments is
 * refused the third time, with the instruction to tell him instead. Any success of that call resets it,
 * and so does the caller clearing `failures` at the start of each turn.
 */
import type { TessayaTool } from "./tessayaMcp.ts";

export const MAX_SAME_FAILURES = 2;

export const withFailureGuard = (
  tools: ReadonlyArray<TessayaTool>,
  failures = new Map<string, number>(),
): ReadonlyArray<TessayaTool> =>
  tools.map((tool) => ({
    ...tool,
    run: async (args) => {
      const key = `${tool.name}:${JSON.stringify(args)}`;
      if ((failures.get(key) ?? 0) >= MAX_SAME_FAILURES) {
        throw new Error(
          `Stopped: ${tool.name} has failed ${MAX_SAME_FAILURES} times in a row with these same arguments. Do not try it again. Tell him what blocked you, or take a different route.`,
        );
      }
      try {
        const out = await tool.run(args);
        failures.delete(key);
        return out;
      } catch (error) {
        failures.set(key, (failures.get(key) ?? 0) + 1);
        throw error;
      }
    },
  }));
