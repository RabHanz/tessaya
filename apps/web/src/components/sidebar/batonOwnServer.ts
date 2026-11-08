/** This app's own server among the connected ones; the first connection only while its own is not connected. */
export const ownServerOf = <Id extends string>(
  environmentIds: ReadonlyArray<Id>,
  primaryEnvironmentId: string | null,
): Id | undefined => environmentIds.find((id) => id === primaryEnvironmentId) ?? environmentIds[0];
