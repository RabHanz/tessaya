interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
let still = false;

function updateAnimation(animation: ObservedAnimation) {
  const running =
    animation.intersecting &&
    document.visibilityState === "visible" &&
    !still &&
    !reducedMotion?.matches;
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
}

function updateAnimations() {
  for (const animation of animations.values()) updateAnimation(animation);
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return;

  if (observer === null) {
    reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion.addEventListener("change", updateAnimations);
    document.addEventListener("visibilitychange", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const animation = { element, intersecting: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      document.removeEventListener("visibilitychange", updateAnimations);
    }
  };
}

const STILL_AFTER_MS = 60_000;
const INPUT_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "focus"] as const;

/**
 * Repeating indicators (a working thread's pulse, a live tool's shine) hold still while nobody has touched this
 * window for a minute or it is out of sight: a turn can run for hours, and each repaints the window several times a
 * second. `html[data-still]` pauses the CSS ones; the first input starts them again.
 */
export function startStillIndicators(): () => void {
  let lastInput = Date.now();
  const set = (next: boolean) => {
    if (next === still) return;
    still = next;
    document.documentElement.toggleAttribute("data-still", next);
    updateAnimations();
  };
  const check = () =>
    set(document.visibilityState !== "visible" || Date.now() - lastInput >= STILL_AFTER_MS);
  const touched = () => {
    lastInput = Date.now();
    if (still) check();
  };
  for (const type of INPUT_EVENTS)
    window.addEventListener(type, touched, { capture: true, passive: true });
  document.addEventListener("visibilitychange", check);
  const timer = window.setInterval(check, STILL_AFTER_MS / 4);
  return () => {
    for (const type of INPUT_EVENTS) window.removeEventListener(type, touched, { capture: true });
    document.removeEventListener("visibilitychange", check);
    window.clearInterval(timer);
    set(false);
  };
}
