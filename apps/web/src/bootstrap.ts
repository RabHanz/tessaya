import { showBootError } from "./lib/bootError";
import { isTessayaGuest } from "./tessayaGuestFlag";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void (isTessayaGuest() ? import("./tessayaGuest") : import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
