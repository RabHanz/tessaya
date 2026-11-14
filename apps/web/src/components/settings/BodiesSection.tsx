/**
 * Settings → Hardware → Bodies: the Docks, plushes and stands his vessels sit in (VesselBodies). Tags are written from
 * the phone app, which can hold one; here he names them, gives each a room, retires one, and sets the link host.
 */
import type { VesselBodiesView, VesselBody } from "@t3tools/baton-contracts";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type Reply = { readonly ok: boolean; readonly value?: unknown; readonly error?: string } | null;
type Call = (
  kind: "read" | "act" | "owner",
  op: string,
  args: Record<string, unknown>,
) => Promise<Reply>;

function BodyRow(props: {
  readonly body: VesselBody;
  readonly busy: boolean;
  readonly act: (op: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const b = props.body;
  const [name, setName] = useState(b.name);
  const [room, setRoom] = useState(b.room ?? "");
  const kept = Object.keys(b.values).length;
  const changed = name.trim() !== b.name || room.trim() !== (b.room ?? "");
  return (
    <SettingsRow
      title={b.name}
      description={`${b.type}${b.madeFor === null ? "" : ` for ${b.madeFor}`} · ${b.room ?? "no room"} · ${kept} kept setting${kept === 1 ? "" : "s"}`}
      status={b.retired ? <Badge variant="outline">Retired</Badge> : null}
    >
      <div className="grid gap-2 pt-2 sm:grid-cols-2">
        <Input
          value={name}
          maxLength={60}
          aria-label="Body name"
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          value={room}
          maxLength={60}
          placeholder="Room"
          aria-label="Room"
          onChange={(e) => setRoom(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          size="xs"
          disabled={props.busy || !changed || name.trim() === ""}
          onClick={() =>
            void props.act("bodyEdit", {
              bodyId: b.bodyId,
              name: name.trim(),
              room: room.trim() || null,
            })
          }
        >
          Save
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.busy || kept === 0}
          onClick={() => void props.act("bodyEdit", { bodyId: b.bodyId, resetValues: true })}
        >
          Forget kept settings
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={props.busy}
          onClick={() => void props.act("bodyEdit", { bodyId: b.bodyId, retired: !b.retired })}
        >
          {b.retired ? "Bring back" : "Retire"}
        </Button>
      </div>
    </SettingsRow>
  );
}

export function BodiesSection(props: { readonly call: Call }) {
  const [view, setView] = useState<VesselBodiesView | null>(null);
  const [host, setHost] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const reply = await props.call("read", "bodies", {});
    if (reply?.ok === true) setView(reply.value as VesselBodiesView);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's bodies once when the section opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the first read; refresh closes over the call
    void refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per mount, like refresh
  }, []);
  const run = async (kind: "act" | "owner", op: string, args: Record<string, unknown>) => {
    setBusy(true);
    const reply = await props.call(kind, op, args);
    setNote(
      reply === null
        ? "Couldn’t reach this environment. Try again."
        : reply.ok
          ? typeof reply.value === "string"
            ? reply.value
            : "Saved."
          : (reply.error ?? "That was not done."),
    );
    setBusy(false);
    await refresh();
  };
  if (view === null) return null;
  return (
    <SettingsSection {...searchableSetting("hardware-bodies")}>
      <SettingsRow
        title="Tag link host"
        description={
          view.linksHost === null
            ? "Not set. Body tags name a link on this host; set one before writing tags from the phone app."
            : `Body tags link to ${view.linksHost}. Changing it only affects new tags.`
        }
      >
        <div className="flex flex-wrap gap-2 pt-2">
          <Input
            value={host}
            placeholder={view.linksHost ?? "tags.example.com"}
            aria-label="Tag link host"
            onChange={(e) => setHost(e.target.value)}
          />
          <Button
            size="xs"
            disabled={busy || host.trim() === ""}
            onClick={() =>
              void run("owner", "bodyLinks", { host: host.trim() }).then(() => setHost(""))
            }
          >
            Set
          </Button>
        </div>
      </SettingsRow>
      {view.bodies.length === 0 ? (
        <SettingsRow
          title="No bodies yet"
          description="Write a tag for a Dock, plush or stand from the phone app: Settings → Hardware → Bodies."
        />
      ) : (
        view.bodies.map((b) => (
          <BodyRow
            key={`${b.bodyId}-${b.name}-${b.room ?? ""}`}
            body={b}
            busy={busy}
            act={(op, args) => run("act", op, args)}
          />
        ))
      )}
      {note === "" ? null : <SettingsRow title="Last change" description={note} />}
    </SettingsSection>
  );
}
