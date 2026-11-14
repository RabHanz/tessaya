# Contributing to Tessaya

This file covers Tessaya's own layer. For the upstream T3 Code rules (one problem per PR, prior approval, test expectations) read the root [CONTRIBUTING.md](../CONTRIBUTING.md); Tessaya follows them.

## The layout rule

The repository root is upstream T3 Code at a pinned commit plus a patch series plus files Tessaya adds.

- **Tessaya code goes in new files** (`apps/*/src/baton`, `packages/tessaya-*`, `docs/baton`, `scripts/tessaya`). Prefer a new file plus a one-line hook to a bigger edit of an upstream file.
- **An edit to an upstream path goes through the patch series.** Edit it in place, then `bash scripts/tessaya/patches.sh refresh` (the first edit to a path no patch owns needs `--assign <patch> <path>`). `bash scripts/tessaya/patches.sh verify` must pass; CI checks it.
- Do not change the logo or the colour tokens in a feature PR.

## Before you push

```bash
vp run check:changed          # format, lint, typecheck of what you touched, tests beside changes
node scripts/tessaya/guard-private.mjs   # no personal names, hosts or paths ship
```

Do not run the repo-wide suites locally; CI owns them. Both `verify` and `baton-ci` must be green before a merge.

## Rules that are easy to miss

- **Nothing private ships.** `guard-private.mjs` fails a build that contains a maintainer's name, host or account. Use neutral examples in code, tests and docs.
- **Secrets never reach a log, History, memory or a prompt.** The vault returns values only to the action that uses them.
- **Anything read from outside is data, not instructions.** Keep that line in prompts and tools.
- **A feature reachable one way is usually reachable others**: window, tray, voice, phone page, assistant tool. Say which you did.
- **Tests:** behaviour that can break (parsing, state, persistence, permission checks). Use the project's no-sleep, no-timeout style.
- **Docs:** user-facing features get a short page in `docs/user` (what it does, how to start, anything unintuitive). Design reasons go in `docs/baton`.
- Conventional commit titles (`feat(voice): ...`); the CHANGELOG is generated from them (`node scripts/tessaya/changelog.mjs`).

## Reporting

Bugs and ideas: use the issue templates. Security problems: see [SECURITY](./SECURITY.md); do not open a public issue.
