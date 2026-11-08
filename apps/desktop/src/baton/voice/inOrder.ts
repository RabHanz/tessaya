/**
 * Runs tasks one at a time, in the order they were given; a failed one does not stop the next. Every paste of his
 * words goes through one of these, so a slow clean-up of an earlier dictation never lands after a newer one (0.1.79).
 */
export const createInOrder = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
};
