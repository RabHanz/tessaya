/** The pending question cards of a live thread that no longer show on its pane: every one except the one shown now. */
export const staleAskIds = (
  pending: ReadonlyArray<{ readonly id: string }>,
  askPrefix: string,
  keepId: string | null,
): ReadonlyArray<string> =>
  pending.filter((r) => r.id.startsWith(askPrefix) && r.id !== keepId).map((r) => r.id);
