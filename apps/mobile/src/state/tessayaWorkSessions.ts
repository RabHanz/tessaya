import { createTessayaWorkSessionAtoms } from "@t3tools/tessaya-shared/workSessionAtoms";

import { connectionAtomRuntime } from "../connection/runtime";

export const tessayaWorkSessions = createTessayaWorkSessionAtoms(connectionAtomRuntime);
