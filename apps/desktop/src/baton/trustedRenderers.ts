/**
 * T3's desktop IPC answers only its main window's top frame (DesktopIpc, since T3 32882540fb). Tessaya's other
 * renderers of the same app are trusted too: detached thread windows (D96) and the T3 pages her window shows inline.
 * Each is added when it is created and leaves when it is destroyed; only its top frame counts.
 */
interface Renderer {
  readonly id: number;
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

const trusted = new Set<Renderer>();

export const trustRenderer = (contents: Renderer): void => {
  trusted.add(contents);
  contents.once("destroyed", () => trusted.delete(contents));
};

export const isTrustedBatonRenderer = (event: {
  readonly sender: { readonly id: number };
  readonly senderFrame?: unknown;
}): boolean => {
  for (const contents of trusted)
    if (
      !contents.isDestroyed() &&
      contents.id === event.sender.id &&
      contents.mainFrame === event.senderFrame
    )
      return true;
  return false;
};
