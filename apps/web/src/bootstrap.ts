import { showBootError, watchBoot } from "./lib/bootError";
import { chunkLoadState, handleChunkLoadErrors } from "./lib/chunkReloadGuard";
import { isTessayaGuest } from "./tessayaGuestFlag";

handleChunkLoadErrors();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
export const boot = watchBoot(
  () => (isTessayaGuest() ? import("./tessayaGuest") : import("./main")),
  (error) => {
    if (!chunkLoadState.reloadScheduled) showBootError(error);
  },
);
