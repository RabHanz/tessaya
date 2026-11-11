import { createBatonWorkSessionAtoms } from "@t3tools/baton-shared/workSessionAtoms";

import { connectionAtomRuntime } from "../connection/runtime";

export const batonWorkSessions = createBatonWorkSessionAtoms(connectionAtomRuntime);
