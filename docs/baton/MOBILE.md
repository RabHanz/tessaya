# The phone (2026-11-02)

Plan only, no code. What a phone can do with a Tessaya server today, what a Tessaya companion on the phone would need, and
the smallest way to build it. Everything below is read from this repository and its records (`D83`, `D85`, `apps/mobile`);
**nothing here was tried on a phone**, and the official app's behaviour against a Tessaya server is inferred from how it
reads the server, not observed.

## 1. The official T3 app against a Tessaya server

The official apps (iOS, Android, web) render the server's read model and nothing else. A Tessaya server is a T3 server plus
extra tables and `baton.*` / `fabric.*` RPCs, so the official app works as it does with any T3 server and cannot see the extras.

|                                                                                                                  | Official T3 app with a Tessaya server                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Threads and projects                                                                                             | yes, including every live Claude Code session mirrored as a thread `baton-live:<id>` (D83), so he sees and can message them                                                                          |
| Sending to a session                                                                                             | yes, through the "Live session" provider (D83): the message is typed into the session's terminal                                                                                                     |
| Images and files in a thread (media)                                                                             | yes: images he pasted render in their message (D85, proven on the orchestrator thread); attachments are copied into the session's inbox                                                              |
| Question cards (the agent asks him to choose) and approval cards                                                 | yes, as T3 draws them for any provider; a Tessaya job's approvals that are T3 approvals show there. Tessaya's own voice yes/no (the gate) is **not** a T3 card; it is spoken or shown on the desktop |
| Push notifications                                                                                               | whatever T3 sends (turn finished, needs input); Tessaya adds one alert per turn (D85). Tessaya's own anomaly and "needs you" notices go to the desktop, not the phone                                |
| Jobs, approvals list, weave list (sessions that message each other), commitments, memory, vault, "what needs me" | **no**. These are `baton.*` methods and desktop tools the official app does not know. It shows a job's worker thread as a normal thread and nothing else                                             |
| Voice, wake word, dictation into other apps                                                                      | no (the official app has its own composer dictation only)                                                                                                                                            |
| Pairing to a server                                                                                              | yes, T3's own pairing and relay (T3 Connect); a Tessaya server keeps those                                                                                                                           |

What this means: the phone is already a window onto his sessions. It is not yet a window onto the assistant.

## 2. The fork's own phone screen

The fork's `apps/mobile` has a Tessaya screen (`BatonRouteScreen`): the fleet, three quick questions ("What needs me?", "What's
running?", "What finished?") sent through the same intent grammar as the laptop, and a handoff button. It deliberately has no
microphone: he uses the keyboard's dictation key (D24). It is built, typechecks, and is **not what the App Store build runs**,
because the store build is the official one.

## 3. What a Tessaya companion on the phone would need

Per the vision: one brain that hears him anywhere, across devices.

| Need                                          | Why                                                                                                                                        | Already there                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pair to his Tessaya server and stay connected | everything else rides on it                                                                                                                | T3 pairing and relay; `tessaya-contracts` RPCs; `createEnvironmentRpcCommand`                                                                                  |
| Approvals                                     | the single list of everything waiting for his yes (jobs' plans, risky tool calls, held memory proposals, the vault asking to use a secret) | `approvals_list` logic in `tessaya-shared/approvals`; held memory proposals via `baton.memory.accept`; no phone UI                                             |
| Push for those approvals                      | a yes from the lock screen                                                                                                                 | T3 push exists; a Tessaya event type for "needs you" does not                                                                                                  |
| Voice in                                      | speak a question or a job on the move                                                                                                      | the phone's own speech-to-text is the cheap route: send text to `baton.intent.run` / the assistant. A wake word on a phone is a separate, battery-costly build |
| Dictation to the phone's focused app          | not possible on iOS or Android (no cross-app typing)                                                                                       | none; say it plainly                                                                                                                                           |
| Spoken replies                                | the assistant's answers aloud                                                                                                              | OS text-to-speech from the reply text                                                                                                                          |
| Jobs and weave list                           | see running work, stop or agree a plan                                                                                                     | `baton.job.*` RPCs exist; no phone UI                                                                                                                          |
| Memory and "what do you remember about X"     | ask and correct from anywhere                                                                                                              | `baton.memory.*` exist, all behind scopes                                                                                                                      |
| The vault                                     | **never copy secrets to the phone by default**; view-only with the phone's biometrics if ever                                              | design needed (VAULT.md covers the laptop only)                                                                                                                |

## 4. A minimal build plan (smallest first)

1. **Ship the fork's mobile build to himself only.** `vp run mobile:install` already builds the dev client; an EAS internal build (or
   TestFlight) of `apps/mobile` gives him the Tessaya screen without the App Store. Gate: it pairs to both servers and shows the fleet.
2. **Approvals tab.** A list from one server call (reuse `approvals` in `tessaya-shared`), with Agree / Deny for a job plan and
   Keep / Dismiss for a held memory proposal. No new server work; the RPCs exist.
3. **Ask box with speech-to-text.** The phone's own recogniser fills the text field and sends it to the assistant; the reply is shown
   and optionally read aloud by the OS. No wake word, no custom audio pipeline.
4. **Push for "needs you".** A server event when something waits for his yes, delivered by T3's existing push channel; tapping opens
   the Approvals tab.
5. **Jobs and weave list, read only.** Cards from `baton.job.list` and the weave list RPC (one does not exist yet; it needs a
   server method, since today it is a desktop tool).
6. **Later, and only if he wants them:** an always-listening phone is a different product (battery, OS limits); the vault stays off the
   phone until a view-only design is agreed.

Open questions for him: does he want his own build of the app on his phone (step 1) given the official app updates on its own
schedule; and is "ask by text with the phone's dictation" enough for the first version.

## 5. The web companion at /tessaya (built; not yet tried on a phone)

A Tessaya server serves a phone page at `/tessaya` (no app store). Open it over Tailscale or the tunnel, pair the phone the normal
T3 way first (the page uses that session), and add it to the home screen (a manifest with the Woad icons and a service worker make it installable).

- **Shows:** What needs me, Approvals (Approve or Deny, with the exact action text; a stale or changed approval is refused),
  Now, Jobs (Stop, and Retry only where a retry is allowed, with the reason otherwise), and the Weave list. A badge count on the
  tab and the app icon; the page polls every 20 seconds while in view. No push notifications (policy).
- **Ask box and Talk button:** the words go into a small durable inbox on the server (`baton.phone.call`, operate scope; each
  ask has a client id, so a retry asks once; it expires after 24 hours and the phone is told so). The desktop app, when its
  window is open and connected, takes the oldest ask and runs it through the one assistant exactly like a typed Ask: same
  gate, same approvals. The short reply and the card text go back and the phone shows them (Asked tab, and the line under the
  bar). If the desktop is away the phone says "Your computer is not connected; it will answer when it is back" and the ask waits.
  The server marks each ask from the caller's session: source phone (his own words, not tainted) only from a paired
  browser (this page, the web app) or the desktop app's own session; source device from any bearer token, which may be
  an agent's, and from a browser paired with a code that a token minted (its session keeps the pairing's provenance). A device's ask always goes to the one assistant, nothing in it counts as his words, every act asks him,
  and the box says a paired device asked. Web content quoted inside either is still data.
- **Approvals round trip:** any question the desktop asks him (a drive's plan, a screen-capture yes, a vault use) is mirrored to
  the phone's Approvals with the exact text; the first answer, on the desktop or on the phone, counts and the other box comes
  down. A mirrored question that nobody answers is dropped after two minutes.
- **Talk:** records in the browser (MediaRecorder), makes a 16 kHz WAV there and uploads it; the server transcribes it with the
  dictation sidecar and the speech model (`BATON_DICTATION`, `BATON_STT_MODEL`, or `voice/models` beside the database), shows
  what it heard, and queues that text as an ask. A server without them answers "Voice is not available on this server".
- **Auth:** the server's own session. Reading needs `orchestration:read`; Approve, Deny, Stop, Retry, Ask and Talk need
  `orchestration:operate`. A phone without the session sees a "not paired" card.
- **Limits, stated:** the desktop must have its window open (a tray-only app does not poll, so it is "not connected"); the
  desktop polls every 5 seconds. A session's own question is answered in its thread, not here. Nothing
  here was tried on a real phone.
