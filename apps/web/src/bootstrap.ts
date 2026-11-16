import { showBootError, watchBoot } from "./lib/bootError";
import { isTessayaGuest } from "./tessayaGuestFlag";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void watchBoot(
  () => (isTessayaGuest() ? import("./tessayaGuest") : import("./main")),
  showBootError,
);
