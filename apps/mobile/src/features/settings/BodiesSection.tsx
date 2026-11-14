/**
 * Settings → Hardware → Bodies: the Docks, plushes and stands his vessels sit in (VesselBodies), and writing their NFC
 * tags. The phone reads the tag's UID, the server signs a link for it, and the phone writes the link and locks the
 * tag with its password (react-native-nfc-manager, raw NTAG commands from `@t3tools/tessaya-shared/bodyTag`).
 */
import {
  VESSEL_BODY_TYPES,
  type VesselBodiesView,
  type VesselBody,
  type VesselBodyMint,
  type VesselBodyType,
} from "@t3tools/tessaya-contracts";
import { bodyTagCommands, configPageOf, GET_VERSION, read } from "@t3tools/tessaya-shared/bodyTag";
import { useEffect, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import NfcManager, { Ndef, NfcTech } from "react-native-nfc-manager";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { SettingsSection } from "./components/SettingsSection";
import { PLUSH_BODY } from "@t3tools/tessaya-shared/productNames";

const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

type Reply = { readonly ok: boolean; readonly value?: unknown; readonly error?: string } | null;
export type BodiesCall = (
  kind: "read" | "act" | "owner",
  op: string,
  args: Record<string, unknown>,
) => Promise<Reply>;

const TYPE_LABELS: Readonly<Record<VesselBodyType, string>> = {
  dock: "Dock",
  perch: "Perch",
  plush: PLUSH_BODY,
  clip: "Clip",
  car: "Car mount",
  peek: "Monitor (Peek)",
  wall: "Wall mount",
  stand: "Phone stand",
  cradle: "Phone cradle",
  other: "Other",
};

/**
 * Holds one tag: reads its UID, has the server sign a link for it, then writes and locks it.
 * Everything runs inside one NFC session.
 */
const writeBodyTag = async (sign: (uid: string) => Promise<VesselBodyMint>): Promise<void> => {
  await NfcManager.start();
  const ios = Platform.OS === "ios";
  try {
    await NfcManager.requestTechnology(ios ? NfcTech.MifareIOS : NfcTech.NfcA, {
      alertMessage: "Hold the top of your phone to the body's tag.",
    });
    const send = (bytes: Array<number>) =>
      ios ? NfcManager.sendMifareCommandIOS(bytes) : NfcManager.nfcAHandler.transceive(bytes);
    const tag = await NfcManager.getTag({ readNdef: false });
    const uid = (tag?.id ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (uid === "") throw new Error("Couldn't read the tag's ID. Hold it still and try again.");
    const configPage = configPageOf(await send(GET_VERSION));
    if (configPage === null) throw new Error("That tag isn't an NTAG213, 215 or 216.");
    const cfg0 = (await send(read(configPage))).slice(0, 4);
    const mint = await sign(uid);
    for (const command of bodyTagCommands({ ...mint, configPage, cfg0 })) await send(command);
    if (ios) await NfcManager.setAlertMessageIOS("Done.");
  } finally {
    await NfcManager.cancelTechnologyRequest().catch(() => undefined);
  }
};

/** One body tag on this phone: its UID and the link it carries. */
export interface SeenTag {
  readonly uid: string;
  readonly url: string;
}

const URI_TYPE = 0x55;
const readBodyTag = async (): Promise<SeenTag> => {
  await NfcManager.start();
  try {
    await NfcManager.requestTechnology(Platform.OS === "ios" ? NfcTech.MifareIOS : NfcTech.NfcA, {
      alertMessage: "Hold the top of your phone to the body's tag.",
    });
    const tag = await NfcManager.getTag();
    const uid = (tag?.id ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
    const record = (tag?.ndefMessage ?? []).find(
      (r) => r.tnf === 1 && (r.type === "U" || (Array.isArray(r.type) && r.type[0] === URI_TYPE)),
    );
    if (uid === "" || record === undefined) throw new Error("That tag doesn't carry a body link.");
    return { uid, url: Ndef.uri.decodePayload(Uint8Array.from(record.payload)) };
  } finally {
    await NfcManager.cancelTechnologyRequest().catch(() => undefined);
  }
};

export function BodiesSection(props: {
  readonly prefix: string;
  readonly call: BodiesCall;
  /**
   * Tells the server which body tag this phone sits on, or none.
   * Until the phone companion watches the tag and the motion sensors, he seats it and takes it out here.
   */
  readonly seat: (tags: ReadonlyArray<SeenTag>) => Promise<string>;
}) {
  const [view, setView] = useState<VesselBodiesView | null>(null);
  const [type, setType] = useState<VesselBodyType>("dock");
  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [host, setHost] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const reply = await props.call("read", "bodies", {});
    if (reply?.ok === true) setView(reply.value as VesselBodiesView);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's bodies once when the section opens
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the first read; refresh closes over the call
    void refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per mount; refresh closes over the call
  }, []);

  const act = async (kind: "act" | "owner", op: string, args: Record<string, unknown>) => {
    setBusy(true);
    const reply = await props.call(kind, op, args);
    setLine(
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
    return reply;
  };

  /** A new body, or (with `body`) the same body onto a fresh or rewritten tag. */
  const write = async (body?: VesselBody) => {
    // Worked out before the NFC session: the compiler can't keep optional chains inside try.
    const label = body === undefined ? name.trim() || TYPE_LABELS[type] : body.name;
    const args =
      body === undefined
        ? { type, name: label, room: room.trim() || null }
        : { type: body.type, name: label, bodyId: body.bodyId };
    setBusy(true);
    setLine("Hold the phone to the tag…");
    const sign = async (uid: string) => {
      const reply = await props.call("owner", "bodyMint", { uid, ...args });
      if (reply === null || !reply.ok)
        throw new Error(reply?.error ?? "The server didn't sign the tag.");
      return reply.value as VesselBodyMint;
    };
    const failed = await writeBodyTag(sign).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : "The tag wasn't written."),
    );
    setLine(failed ?? `Tag written and locked. Put it in the ${label}.`);
    if (failed === null) {
      setName("");
      setRoom("");
    }
    setBusy(false);
    await refresh();
  };

  const seat = async (on: boolean) => {
    setBusy(true);
    if (on) setLine("Hold the phone to the body's tag…");
    const tags = on
      ? await readBodyTag().then(
          (t) => [t],
          (cause: unknown) => {
            setLine(cause instanceof Error ? cause.message : "The tag wasn't read.");
            return null;
          },
        )
      : [];
    if (tags !== null) setLine(await props.seat(tags));
    setBusy(false);
  };

  const bodies = view?.bodies ?? [];
  return (
    <SettingsSection title={`${props.prefix}Bodies`}>
      <View className="gap-2 px-4 py-3">
        <Text textRole="footnote" className="text-foreground-muted">
          A tag in each Dock, plush or stand tells your devices which one they are in, and they take
          its settings. Changes you make while one is in a body are kept for that body.
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {view?.linksHost === null || view === null
            ? "Tag links: no host set yet. New tags can't be written until one is."
            : `Tag links: ${view.linksHost}`}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          <TextInput
            accessibilityLabel="Tag link host"
            className={`${INPUT_CLASS} min-w-48 flex-1`}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={view?.linksHost ?? "tags.example.com"}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            value={host}
            onChangeText={setHost}
          />
          <ControlPill
            variant="pill"
            label="Set host"
            disabled={busy || host.trim() === ""}
            onPress={() =>
              void act("owner", "bodyLinks", { host: host.trim() }).then(() => setHost(""))
            }
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel="Kind of body"
            title="Kind of body"
            actions={VESSEL_BODY_TYPES.map((t) => ({
              id: t,
              title: TYPE_LABELS[t],
              state: t === type ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => setType(nativeEvent.event as VesselBodyType)}
          >
            <ControlPill variant="pill" label={TYPE_LABELS[type]} />
          </Menu>
        </View>
        <TextInput
          accessibilityLabel="Body name"
          className={INPUT_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="Kitchen dock"
          maxLength={60}
          editable={!busy}
          value={name}
          onChangeText={setName}
        />
        <TextInput
          accessibilityLabel="Room"
          className={INPUT_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="Room (optional)"
          maxLength={60}
          editable={!busy}
          value={room}
          onChangeText={setRoom}
        />
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label="Write a body tag"
            disabled={busy || view?.linksHost == null}
            onPress={() => void write()}
          />
        </View>
        <View className="flex-row flex-wrap gap-2">
          <ControlPill
            variant="pill"
            label="Seat this phone"
            disabled={busy}
            onPress={() => void seat(true)}
          />
          <ControlPill
            variant="pill"
            label="Take it out"
            disabled={busy}
            onPress={() => void seat(false)}
          />
        </View>
        {line === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        )}
      </View>
      {bodies.map((b) => (
        <View key={b.bodyId} className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text textRole="body" className="text-foreground">
            {b.name}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {[
              TYPE_LABELS[b.type],
              b.room ?? "no room",
              `${Object.keys(b.values).length} kept settings`,
              b.retired ? "retired" : null,
            ]
              .filter((x) => x !== null)
              .join(" · ")}
          </Text>
          <View className="flex-row flex-wrap gap-2">
            <ControlPill
              variant="pill"
              label="Re-tag"
              disabled={busy || view?.linksHost == null}
              onPress={() => void write(b)}
            />
            <ControlPill
              variant="pill"
              label="Forget kept settings"
              disabled={busy || Object.keys(b.values).length === 0}
              onPress={() => void act("act", "bodyEdit", { bodyId: b.bodyId, resetValues: true })}
            />
            <ControlPill
              variant="pill"
              label={b.retired ? "Bring back" : "Retire"}
              disabled={busy}
              onPress={() => void act("act", "bodyEdit", { bodyId: b.bodyId, retired: !b.retired })}
            />
          </View>
        </View>
      ))}
    </SettingsSection>
  );
}
