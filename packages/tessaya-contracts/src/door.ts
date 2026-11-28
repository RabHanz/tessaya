/**
 * The household's one front door over the wire: each linked machine's public name under the door brain's domain,
 * set in Sharing & access. A machine without a name is not reachable through the door.
 */
import * as Schema from "effect/Schema";

import { EnvironmentId } from "@t3tools/contracts";

export const TESSAYA_DOOR_WS_METHODS = {
  names: "tessaya.door.names",
  setName: "tessaya.door.setName",
} as const;

export const TessayaDoorNames = Schema.Struct({
  /** The door's domain, null when this brain is not the household's door. */
  domain: Schema.NullOr(Schema.String),
  /** Each named machine's label, by environment id. */
  names: Schema.Record(Schema.String, Schema.String),
});
export type TessayaDoorNames = typeof TessayaDoorNames.Type;

export const TessayaDoorSetNameInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** One DNS label; null takes the machine off the door. */
  name: Schema.NullOr(Schema.String.check(Schema.isMaxLength(63))),
});

export const TessayaDoorSetNameResult = Schema.Struct({
  error: Schema.NullOr(Schema.Literals(["not-a-door", "invalid-name", "taken", "not-linked"])),
  names: TessayaDoorNames,
});
