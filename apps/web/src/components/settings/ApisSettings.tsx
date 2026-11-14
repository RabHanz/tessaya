import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  getDictationCleanupKeys,
  setDictationCleanupKey,
  testDictationCleanupKey,
} from "@t3tools/client-runtime/voice-input";
import {
  AuthSettingsWriteScope,
  CloudSpeechApiKey,
  type DictationCleanupKeyTest,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import type { VoiceLibraryView } from "@t3tools/tessaya-contracts";
import { useEffect, useState } from "react";

import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { useCloudRead } from "./CloudVoiceConfiguration";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const isApiKey = Schema.is(CloudSpeechApiKey);
const TEST_RESULTS: Record<DictationCleanupKeyTest["result"], string> = {
  ok: "The key works.",
  "missing-key": "No key is saved.",
  "invalid-key": "Anthropic rejected this key.",
  unreachable: "Couldn’t reach Anthropic. Try again later.",
};

export function ApisSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("apis-anthropic")}>
        {environment?.connection.phase === "connected" ? (
          <AnthropicKeyRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to save an API key.
          </p>
        )}
      </SettingsSection>
      {environment?.connection.phase === "connected" ? (
        <SettingsSection id="apis-google" title="Google">
          <GoogleKeyRow key={environment.environmentId} environmentId={environment.environmentId} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

function AnthropicKeyRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const [presence, refresh] = useCloudRead(canManage ? prepared : null, getDictationCleanupKeys);
  const saved = AsyncResult.isSuccess(presence) ? presence.value?.anthropic : undefined;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const act = async (work: (connection: PreparedConnection) => Promise<string>) => {
    if (prepared === null || busy) return;
    setBusy(true);
    setNote("");
    try {
      setNote(await work(prepared));
    } catch {
      setNote("Couldn’t save this change. Check your connection and try again.");
    }
    setBusy(false);
  };
  const save = () =>
    act(async (connection) => {
      await runEnvironmentSpeech(setDictationCleanupKey(connection, draft.trim()));
      setDraft("");
      refresh();
      return "Saved.";
    });
  const remove = () =>
    act(async (connection) => {
      await runEnvironmentSpeech(setDictationCleanupKey(connection, null));
      refresh();
      return "Removed.";
    });
  const test = () =>
    act(
      async (connection) =>
        TEST_RESULTS[(await runEnvironmentSpeech(testDictationCleanupKey(connection))).result],
    );

  return (
    <SettingsRow
      title="Anthropic API key"
      description="Used only for dictation cleanup when chosen."
      status={note ? <span role="status">{note}</span> : undefined}
      control={
        !canManage ? (
          <span className="text-sm text-muted-foreground">
            Needs permission to change settings.
          </span>
        ) : saved === undefined && AsyncResult.isFailure(presence) ? (
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry loading API key
          </Button>
        ) : saved === undefined ? (
          <span className="text-sm text-muted-foreground">Checking…</span>
        ) : (
          <form
            className="flex min-w-0 flex-wrap items-center justify-end gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (isApiKey(draft.trim())) void save();
            }}
          >
            <SecretInput
              aria-label="Anthropic API key"
              size="sm"
              className="min-w-0 flex-1"
              configured={saved}
              placeholder="Paste API key"
              value={draft}
              disabled={busy}
              maxLength={4096}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !isApiKey(draft.trim())}>
              Save
            </Button>
            {saved && (
              <>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={test}>
                  Test
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove}>
                  Remove
                </Button>
              </>
            )}
          </form>
        )
      }
    />
  );
}

/** Google's key turns on cloud voices (Gemini) in Settings → Voice. It is stored on the environment and never sent back. */
function GoogleKeyRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const voiceCall = useAtomCommand(batonWorkSessions.voiceCall, { reportFailure: false });
  const call = async (kind: "read" | "act", op: string, args: Record<string, unknown> = {}) => {
    const result = await voiceCall({ environmentId, input: { kind, op, args } });
    return result._tag === "Success" ? result.value : null;
  };
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const refresh = async () => {
    const reply = await call("read", "library");
    setSaved(reply?.ok === true ? (reply.value as VoiceLibraryView).cloud !== null : null);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads whether this environment holds a Google key, once
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment
    void refresh();
  }, [environmentId]);
  const store = async (key: string | null) => {
    if (busy) return;
    setBusy(true);
    const reply = await call("act", "setGoogleKey", { key });
    setBusy(false);
    setNote(
      reply?.ok
        ? key === null
          ? "Removed."
          : "Saved."
        : (reply?.error ?? "Couldn’t save this change."),
    );
    if (reply?.ok) {
      setDraft("");
      await refresh();
    }
  };
  return (
    <SettingsRow
      title="Google API key"
      description="Turns on cloud voices (Gemini) for personas in Settings → Voice. Each spoken line is billed to this key."
      status={note ? <span role="status">{note}</span> : undefined}
      control={
        !canManage ? (
          <span className="text-sm text-muted-foreground">
            Needs permission to change settings.
          </span>
        ) : saved === null ? (
          <span className="text-sm text-muted-foreground">Checking…</span>
        ) : (
          <form
            className="flex min-w-0 flex-wrap items-center justify-end gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() !== "") void store(draft.trim());
            }}
          >
            <SecretInput
              aria-label="Google API key"
              size="sm"
              className="min-w-0 flex-1"
              configured={saved}
              placeholder="Paste API key"
              value={draft}
              disabled={busy}
              maxLength={400}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
              Save
            </Button>
            {saved && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void store(null)}
              >
                Remove
              </Button>
            )}
          </form>
        )
      }
    />
  );
}
