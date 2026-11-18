import { minuteTick, secondTick } from "@t3tools/client-runtime/clock";

import { isStill, onStillChange } from "./visibleAnimation";

/**
 * Writes `format(Date.now())` into a node and, while `live`, rewrites it on the shared second tick, through the DOM so
 * a ticking label never re-renders the timeline around it. In a still window (startStillIndicators) a label past a
 * minute drops its seconds and ticks on the minute, so an untouched window stops repainting.
 */
export function tickTextContent(format: (nowMs: number) => string, live: boolean) {
  return (node: HTMLElement | null) => {
    if (!node) return;
    let coarse = false;
    const write = () => {
      const full = format(Date.now());
      const text = isStill() ? withoutSeconds(full) : full;
      coarse = text !== full;
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    if (!live) return;
    let ticking = coarse;
    let unsubscribe = (coarse ? minuteTick : secondTick).subscribe(tick);
    function tick() {
      write();
      if (coarse === ticking) return;
      unsubscribe();
      ticking = coarse;
      unsubscribe = (coarse ? minuteTick : secondTick).subscribe(tick);
    }
    const stopStill = onStillChange(tick);
    return () => {
      unsubscribe();
      stopStill();
    };
  };
}

/** "7m 02s" -> "7m", "1h 3m 5s" -> "1h 3m"; a label of seconds alone keeps them. */
function withoutSeconds(text: string): string {
  return text.replace(/(\d+[hm]) \d+s\b/, "$1");
}
