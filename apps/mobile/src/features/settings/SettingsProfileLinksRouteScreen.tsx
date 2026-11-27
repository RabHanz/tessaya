/**
 * Settings → Link my profiles (identity I-8): from this phone, signed in to two homes, she says she is the same person
 * in both, confirmed with her PIN in each; then she may copy her voice or preferences between them. Each home is
 * reached over its own connection, and the homes never talk to each other.
 */
import type { TessayaProfileLink } from "@t3tools/tessaya-contracts";
import {
  copyPreferences,
  copyVoice,
  type LinkHome,
  linkProfiles,
  type LinkOutcome,
  unlinkProfiles,
} from "@t3tools/tessaya-shared/profileLinks";
import { T, useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { UnlockSheet } from "../tessaya/lock/UnlockSheet";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { connectedSettingsTargets } from "./settings-environment-filter";

/** A step-up holds 5 minutes on the server; ask again a little before it ends. */
const CONFIRMED_MS = 4 * 60_000;

export function SettingsProfileLinksRouteScreen() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const call = useAtomCommand(tessayaWorkSessions.householdCall, { reportFailure: false });
  const homes: ReadonlyArray<LinkHome> = connectedSettingsTargets(
    useEnvironments().environments,
  ).map((e) => ({
    label: e.label,
    environmentId: e.environmentId,
    call: async (input) => {
      const r = await call({ environmentId: e.environmentId, input });
      return r._tag === "Success" ? r.value : null;
    },
  }));
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const [links, setLinks] = useState<Readonly<Record<string, ReadonlyArray<TessayaProfileLink>>>>(
    {},
  );
  const [confirmedAt, setConfirmedAt] = useState<Readonly<Record<string, number>>>({});
  const [asking, setAsking] = useState<{
    readonly home: LinkHome;
    readonly done: (ok: boolean) => void;
  } | null>(null);
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  const homeKey = homes.map((h) => h.environmentId).join(",");
  const read = async () => {
    const next: Record<string, ReadonlyArray<TessayaProfileLink>> = {};
    for (const h of homes)
      next[h.environmentId] = (await h.call({ op: "whoAmI" }))?.you?.links ?? [];
    setLinks(next);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each connected home's links once per set of homes
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per set of homes
    void read();
  }, [homeKey]);

  /** Her PIN in each home that hasn't seen it in the last few minutes, one after another. */
  const confirm = async (needed: ReadonlyArray<LinkHome>) => {
    for (const home of needed) {
      if (Date.now() - (confirmedAt[home.environmentId] ?? 0) < CONFIRMED_MS) continue;
      const ok = await new Promise<boolean>((done) => setAsking({ home, done }));
      setAsking(null);
      if (!ok) return false;
      setConfirmedAt((m) => ({ ...m, [home.environmentId]: Date.now() }));
    }
    return true;
  };
  const act = async (needed: ReadonlyArray<LinkHome>, run: () => Promise<LinkOutcome>) => {
    if (busy) return;
    setBusy(true);
    setLine("");
    if (await confirm(needed)) {
      setLine((await run()).line);
      await read();
    }
    setBusy(false);
  };

  const byId = (id: string | null) => homes.find((h) => h.environmentId === id);
  const pair = picked.map((id) => byId(id)).filter((h): h is LinkHome => h !== undefined);
  // Each pair once: the link in the first home that names the other.
  const linkedPairs = homes.flatMap((a, i) =>
    (links[a.environmentId] ?? []).flatMap((l) => {
      const b = byId(l.environmentId);
      return b !== undefined && homes.indexOf(b) > i ? [[a, b] as const] : [];
    }),
  );
  const elsewhere = homes.flatMap((a) =>
    (links[a.environmentId] ?? [])
      .filter((l) => byId(l.environmentId) === undefined)
      .map((l) => ({ a, l })),
  );

  return (
    <SettingsScreen title={gt("Link my profiles")}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="text-foreground-muted">
          <T>
            If you're a member of two homes, link them to say you're the same person in both. Then
            you can copy your voice and preferences between them. Your memories stay in each home.
          </T>
        </Text>
        {homes.length < 2 ? (
          <Text className="text-foreground-muted">
            <T>Connect this phone to both homes first, in Environments.</T>
          </Text>
        ) : (
          <SettingsSection title={gt("Pick two homes")}>
            <View className="flex-row flex-wrap gap-2 px-4 py-3">
              {homes.map((h) => {
                const on = picked.includes(h.environmentId);
                return (
                  <ControlPill
                    key={h.environmentId}
                    variant={on ? "primary" : "pill"}
                    label={h.label}
                    accessibilityLabel={
                      on
                        ? gt("Unpick {home}", { home: h.label })
                        : gt("Pick {home}", { home: h.label })
                    }
                    onPress={() =>
                      setPicked((p) =>
                        on
                          ? p.filter((id) => id !== h.environmentId)
                          : [...p, h.environmentId].slice(-2),
                      )
                    }
                  />
                );
              })}
            </View>
            {pair.length === 2 ? (
              <View className="flex-row px-4 pb-3">
                <ControlPill
                  variant="primary"
                  label={
                    busy
                      ? gt("Linking…")
                      : gt("Link {a} and {b}", { a: pair[0]!.label, b: pair[1]!.label })
                  }
                  disabled={busy}
                  onPress={() => void act(pair, () => linkProfiles(pair[0]!, pair[1]!))}
                />
              </View>
            ) : null}
          </SettingsSection>
        )}
        {linkedPairs.map(([a, b]) => (
          <SettingsSection
            key={`${a.environmentId}:${b.environmentId}`}
            title={gt("{a} and {b}", { a: a.label, b: b.label })}
          >
            <ListRowLayout
              label={gt("Linked")}
              description={gt("Copy what you choose. Each copy replaces what the other home had.")}
            />
            <View className="flex-row flex-wrap gap-2 px-4 pb-3">
              {(
                [
                  [a, b],
                  [b, a],
                ] as const
              ).flatMap(([from, to]) => [
                <ControlPill
                  key={`voice:${from.environmentId}`}
                  variant="pill"
                  label={gt("Copy my voice from {from} to {to}", {
                    from: from.label,
                    to: to.label,
                  })}
                  disabled={busy}
                  onPress={() => void act([from, to], () => copyVoice(from, to))}
                />,
                <ControlPill
                  key={`prefs:${from.environmentId}`}
                  variant="pill"
                  label={gt("Copy my preferences from {from} to {to}", {
                    from: from.label,
                    to: to.label,
                  })}
                  disabled={busy}
                  onPress={() => void act([from, to], () => copyPreferences(from, to))}
                />,
              ])}
              <ControlPill
                variant="danger"
                label={gt("Unlink")}
                disabled={busy}
                onPress={() => void act([a, b], () => unlinkProfiles(a, b))}
              />
            </View>
          </SettingsSection>
        ))}
        {elsewhere.map(({ a, l }) => (
          <SettingsSection
            key={`${a.environmentId}:${l.home}`}
            title={gt("{a} and {b}", { a: a.label, b: l.home })}
          >
            <ListRowLayout
              label={gt("Linked")}
              description={gt(
                "This phone isn't connected to {home}. Unlink here, and there too when you can.",
                { home: l.home },
              )}
            />
            <View className="flex-row px-4 pb-3">
              <ControlPill
                variant="danger"
                label={gt("Unlink in {home}", { home: a.label })}
                disabled={busy}
                onPress={() =>
                  void act([a], async () => {
                    const r = await a.call({ op: "unlinkProfile", home: l.home });
                    return {
                      ok: r?.status === "done",
                      line: r?.line ?? gt("Couldn't reach {home}.", { home: a.label }),
                    };
                  })
                }
              />
            </View>
          </SettingsSection>
        ))}
        {line === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        )}
      </ScreenScrollView>
      {asking === null ? null : (
        <UnlockSheet
          title={gt("Confirm it's you in {home}", { home: asking.home.label })}
          detail={gt("Your PIN for {home}.", { home: asking.home.label })}
          pinOnly
          check={async (pin) => {
            const r = await asking.home.call({ op: "stepUp", pin });
            return r === null
              ? {
                  ok: false,
                  refused: false,
                  line: gt("Couldn't reach {home}.", { home: asking.home.label }),
                }
              : { ok: r.status === "done", refused: r.status === "refused", line: r.line };
          }}
          onUnlocked={() => asking.done(true)}
          onCancel={() => asking.done(false)}
        />
      )}
    </SettingsScreen>
  );
}
