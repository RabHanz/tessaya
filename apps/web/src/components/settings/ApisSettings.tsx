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
import { useState } from "react";

import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
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
