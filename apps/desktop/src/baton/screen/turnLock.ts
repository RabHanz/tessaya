/**
 * Turns never overlap a paired device's. His turn stops a device turn that is running and then goes ahead; a device
 * turn waits until he is done and runs after the device turns before it. His own turns may still overlap each other.
 */
export const INTERRUPTED = "interrupted" as const;

export const createTurnLock = () => {
  let his = 0;
  const idle: Array<() => void> = [];
  let device: { readonly cancel: () => void; readonly done: Promise<unknown> } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  /** Bumped by his Stop: a device turn queued before it never starts. */
  let stops = 0;
  const hisDone = () =>
    his === 0 ? Promise.resolve() : new Promise<void>((resolve) => idle.push(resolve));
  return {
    /** Starts his turn, ending any device turn first; call the returned function once his turn is over. */
    his: async (): Promise<() => void> => {
      his += 1;
      const running = device;
      if (running !== null) {
        running.cancel();
        await running.done.catch(() => undefined);
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        his -= 1;
        if (his === 0) for (const resolve of idle.splice(0)) resolve();
      };
    },
    /** Runs a device turn in its place; `onCancel` names how to stop it when he speaks. */
    device: <A>(
      run: (onCancel: (stop: () => void) => void) => Promise<A>,
    ): Promise<A | typeof INTERRUPTED> => {
      const queuedAt = stops;
      const next = chain.then(async () => {
        while (his > 0) await hisDone();
        if (stops !== queuedAt) return INTERRUPTED;
        let interrupted = false;
        let stop = () => {};
        // A cancel that came before the turn named its stop (a cold start) takes effect when it does.
        const done = run((s) => {
          stop = s;
          if (interrupted) s();
        });
        device = {
          cancel: () => {
            interrupted = true;
            stop();
          },
          done,
        };
        try {
          const value = await done;
          return interrupted ? INTERRUPTED : value;
        } catch (error) {
          if (interrupted) return INTERRUPTED;
          throw error;
        } finally {
          device = null;
        }
      });
      chain = next.catch(() => undefined);
      return next;
    },
    /** His Stop: ends the device turn that is running and those queued behind it, without starting a turn of his. */
    stopDevice: (): void => {
      stops += 1;
      device?.cancel();
    },
    /** Whether a device turn holds the lock now: only then is the running turn a device's. */
    deviceRunning: (): boolean => device !== null,
  };
};

/** A confirm as he sees and hears it: a device's says so in the box and aloud; his phone's says so in the box. */
export const labelPrompt = <B extends { readonly detail: string }>(
  box: B,
  spoken: string,
  from: { readonly device: boolean; readonly phone: boolean },
): { readonly box: B; readonly spoken: string } =>
  from.device
    ? {
        box: { ...box, detail: `${box.detail}\n\n(A paired device asked this, not you.)` },
        spoken: `A paired device asks. ${spoken}`,
      }
    : from.phone
      ? { box: { ...box, detail: `${box.detail}\n\n(You asked this from your phone.)` }, spoken }
      : { box, spoken };
