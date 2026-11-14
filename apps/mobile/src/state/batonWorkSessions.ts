import { createBatonWorkSessionAtoms } from "@t3tools/tessaya-shared/workSessionAtoms";

import { connectionAtomRuntime } from "../connection/runtime";

export const batonWorkSessions = createBatonWorkSessionAtoms(connectionAtomRuntime);
