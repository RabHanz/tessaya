/**
 * File writes off the loop thread, in call order. A sync write on the voice host's busy disk held the room loop for
 * seconds (27 Nov: 27 s of io stall in 85 min, lag max up to 15 s), and every audio frame waits behind it.
 * @module baton-voice/room/writeQueue
 */
export const createWriteQueue = (onError: (e: unknown) => void) => {
  let tail: Promise<void> = Promise.resolve();
  return {
    /** Runs `io` after every write queued before it; a failure is reported and never stops the next. */
    run: (io: () => Promise<unknown>) => {
      tail = tail.then(io).then(() => undefined, onError);
    },
    /** Resolves once every write queued so far has finished. */
    drained: () => tail,
  };
};
