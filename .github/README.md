# Tessaya

Tessaya is a desktop assistant for people who work with coding agents. You talk or type; it looks at your screen when you ask, runs jobs in the background, remembers what you teach it, keeps your secrets in an encrypted vault, and asks before anything that matters. A web page on your own server puts the approvals and jobs on your phone.

It is built on [T3 Code](https://github.com/pingdotgg/t3code) (a GUI and server for Codex, Claude Code, Cursor, OpenCode and others), kept as a named patch series over a pinned upstream commit. The root `README.md` is upstream's; this page is Tessaya's.

## Licensing

Tessaya is open core, and this repository holds the product: everything a person running Tessaya needs. Our own operations (deploys, our machines, internal decisions, the hosted tier) live in a separate private repository, and nothing here depends on it.

Two licences apply, by who wrote the code:

- **T3 Code**, the base this is built on, stays under its MIT licence (`LICENSE` at the root). That covers every upstream file, including the ones our patch series (`vendor-patches/t3code/`) edits.
- **Tessaya's own code** is under the [Functional Source License 1.1, Apache 2.0 future licence](https://fsl.software) (FSL-1.1-ALv2), licensed by MELIURA LTD (Copyright 2026 MELIURA LTD). You may use, change and share it for anything except a product that competes with Tessaya, and each version becomes Apache 2.0 two years after its release. It covers every file T3 Code does not have at the commit named in `vendor-patches/t3code/PIN`, and the lines our patch series adds. Most of it is in the folders that carry their own `LICENSE`: `packages/tessaya-contracts`, `packages/tessaya-shared`, `packages/tessaya-voice`, `apps/desktop/src/tessaya`, `apps/server/src/tessaya`, `native/baton-dictation`, `scripts/tessaya` and `assets/baton`. Elsewhere it is:
  - the `Baton*` and `baton*` files under `apps/web` and `apps/mobile`;
  - the Baton database migrations (`apps/server/src/persistence/TessayaMigrations.ts`, `apps/server/src/persistence/Migrations/Baton/`);
  - `apps/server/src/mentionedMedia.ts`, `apps/server/src/orchestration-v2/StoppedSessions.ts`, `apps/server/src/provider/Drivers/ClaudeAccountHome.ts`, `packages/shared/src/mediaPolicy.ts` and `packages/shared/src/mediaMentions.ts`;
  - `apps/web/src/components/chat/ModelPickerAccountLine.tsx` and `apps/web/src/components/chat/workGroupPreference.ts`;
  - `apps/server/scripts/baton-*`, `evals/tessaya-assistant/` and `scripts/tessaya-lab/`;
  - the tests beside all of these.
- **Third-party files** keep their own licences, even inside the folders above. Each is listed with its licence in `docs/baton/THIRD_PARTY_NOTICES.md`. The wake and voice-activity models in `native/baton-dictation/models/`, for example, are not FSL:
  - `silero_vad.onnx` is MIT;
  - the openWakeWord feature models are CC BY-NC-SA 4.0;
  - our own wake models are treated as CC BY-NC-SA 4.0, because they were trained on non-commercial data.

## Install

Releases are on the [Releases page](../../releases): a Windows installer (first class), a macOS dmg (arm64) and a Linux AppImage. macOS and Linux start and run the voice but have fewer features; `docs/baton/PLATFORMS.md` says exactly what works where, and what was only seen in CI.

Builds are unsigned for now, so macOS shows a first-run warning and Windows SmartScreen may too.

Then read [Getting started](../docs/user/getting-started.md).

## Build

```bash
vp i
vp run dev          # server and web, with a seeded copy of your data
vp run check:changed
```

Desktop packaging: `scripts/tessaya/release-build.sh` and `.github/workflows/baton-desktop-release.yml`. The dictation sidecar is in `native/baton-dictation` (Rust). Details: `docs/operations/development.md`.

## Where things are

|                                                       |                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/desktop/src/tessaya`, `apps/server/src/tessaya` | Tessaya's desktop and server code                                          |
| `packages/tessaya-*`                                  | shared logic, contracts, voice core                                        |
| `vendor-patches/t3code`                               | the patches over upstream; `scripts/tessaya/patches.sh verify` checks them |
| `docs/user`                                           | what each feature does and how to start                                    |
| `docs/baton`                                          | design notes, platform status, vault and memory rules                      |

## Contributing, security, changes

See [CONTRIBUTING](./CONTRIBUTING.md), [SECURITY](./SECURITY.md) and the [CHANGELOG](../CHANGELOG.md).
