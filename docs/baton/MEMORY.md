# Memory: one brain that remembers (D150)

The Director's words: "It remembers what was said, today and before, across everything it does, so 'type what you just
said' simply works." And: "Every learning that we are doing across these projects and ventures should be kept as
learnings in our brain and memory so it only improves from here as a constant feedback loop." And: "One brain that hears
him anywhere... across every device, session, account and agent."

This note is the design. The order of work is in the last section. It builds on D142 (the conversation file), D143 (the
one assistant), D146 (plain editable notes) and D148 (the neutral pack).

## 1. The layers

| Layer              | What it holds                                                                            | Where it lives                                                     | Lifetime                       |
| ------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| Working            | The current turn and the last few: target, focused window, what was just said            | the assistant's own context (D143)                                 | one session                    |
| Conversation       | Every turn, verbatim, with route and target (D142), one file per persona                 | `conversation/<persona id>.ndjson` in the state folder             | kept; searched by text         |
| Episodic           | What happened: a job finished, a session crashed, a thing was tried and worked or failed | memory store, kind `episode`                                       | decays, expires                |
| Semantic           | Facts and preferences: how he writes, what he likes, decisions made, corrections he gave | memory store, kinds `preference`, `fact`, `decision`, `correction` | long, reinforced by repetition |
| Project and people | What is true of one project or one person: stack, owners, conventions, who is who        | memory store, scope `project` or `person`                          | long, tied to a reference      |
| Learnings          | What worked or failed in a venture or a job, in a form that changes the next attempt     | memory store, kind `learning`, plus imported folders               | long, ranked by use            |

Working and conversation memory stay where they are; the store is the new layer under the other four. One table holds
them all, because retrieval must rank across them in one query ("what do you remember about X?").

## 2. The record

Shared type: `packages/baton-shared/src/memory.ts` (`MemoryItem`). Fields:

- `id` (a UUID, made where the item is born), `kind`, `text` (one short statement, at most 500 characters, the same cap
  as a note today).
- `source`: `user` (he said it or wrote it), `thread`, `job`, `import`; `sourceRef`: the thread, job or file it
  came from, so "why do you think that?" has an answer.
- `scope`: `global`, `project` or `person`; `scopeRef`: the project or person it belongs to (null for global).
- `confidence` 0 to 1, `pinned`, `createdAt`, `updatedAt`, `lastUsedAt`, `expiresAt`, `supersededBy`.
- Tombstones are separate (`memory_tombstones`: id, deleted time, origin), so a forgotten item stays forgotten through a
  sync and its text is gone from the store the moment he forgets it.

### Provenance and confidence

- Anything he said or wrote himself is `source: user`, confidence 1. The extractor never lowers it.
- A statement the extractor marks as his, when most of its words are words he said in a turn that read nothing from
  outside, is stored as his (`source: user`), so a correction he speaks beats his older note. A turn that read outside
  content never stores anything as his and never replaces one of his notes.
- Anything else a model proposed starts at 0.5, and rises by 0.15 each time a later turn or job
  proposes the same thing (dedupe, section 4), capped at 0.95. It never reaches 1: only he confirms to 1 (pinning).
- Retrieval shows the source with the item, so he can see where a belief came from and correct it.

### Time, decay and expiry

- `effective = confidence * 0.5 ^ (age since last use or update / half-life)`; half-lives: episode 14 days, learning 180,
  fact 365, preference and decision no decay until contradicted, person and project facts 365. Pinned items never decay.
- Using an item (it was injected and the answer relied on it, or it came back from `memory_search`) refreshes
  `lastUsedAt`, so what is useful stays.
- `expiresAt` is set only for episodes (default 90 days) and for anything the extractor marks as time-bound ("until
  Friday"). The daily pass deletes what has expired and what decayed under 0.1, except pinned items.

### Conflicts

- A new statement that replaces an older one (the extractor names the older one's id) is stored, and the older one gets
  `supersededBy` set. History is kept: a superseded
  item is hidden from retrieval and shown in the tab under "replaced".
- His own statement beats a model's proposal whatever the dates. Between two of his, the newer wins. Between two
  model proposals, the one with higher confidence wins, then the newer.
- Two items that merely overlap are merged by the daily pass (the longer text kept, confidences combined), never silently
  by retrieval. Once a week, items that are about the same thing but worded differently (half or more of their words shared, same kind and scope) become one: the fuller wording survives, his own words are never rewritten, a pinned item is never dropped. Each memory row has a "Why?" that says where it came from, how sure it is and what keeps or ends it. `docs/baton/evals-memory/*.json` holds the retrieval and per-sentence recall cases that `BatonMemoryEval.test.ts` runs on an in-memory database; a case marked `pending` names the finding it waits for and fails the run once it passes.

## 3. Privacy: what is never stored

Checked in code (`memory.ts`, `storable()`), at the single door every writer uses (the tool, the extractor, the importer,
the sync), so no path skips it:

- Secrets and credentials: API keys and tokens by shape, private key blocks, passwords and "my password is" phrasing,
  bearer headers, connection strings with a password, recovery phrases.
- Banking and payment: card numbers (digit runs that pass the Luhn check), IBANs, account and routing numbers with their
  label, security codes.
- Text of the user's private operating-system pack (below).
- Content from a tainted turn (one that read a web page, a file or a message from outside, as D127 defines it) is not
  stored by the extractor unless he says yes; the item waits as a proposal, `source: thread`, not shown to retrieval
  until accepted. What he said himself in that turn (most of the proposal's words are his) is not held; it is kept as the model's. The morning
  brief says how many memories wait for his yes.
- Dictated words as such (D31): a dictation is a stub with its length. Only what he tells the assistant to remember, or
  what a turn with the assistant decided, becomes memory.

A refusal says why in plain words ("that looks like a password, so I did not keep it").

### The neutral default and a user's private pack stay separate

The pack (D148) is plain files in the user data folder. The memory store holds facts about him and his work, never the
pack's text. The extractor's prompt is not given pack text as something to summarize; a proposed item that shares a long
run of words with a loaded pack file is refused by the same door. The shipped default memory is empty. Nothing in the
repository, the installer or a test fixture contains personal memory, and the public-release guard scans memory fixtures
like any other. Exports are plain markdown the user owns; they leave the machine only when he copies them.

## 4. The learning loop

1. After a turn, and at the end of every job, a cheap-model extractor (the cheap model in `routing.json`, D145; the
   strong model is never used for this) reads the turn (with the exchange before it) or the job report, plus the eight
   existing memories closest to what he said with their ids, and proposes items as JSON: kind, text, scope, the id of a
   shown memory it replaces, whether the statement is his. Only a shown id can be replaced. It is told that what it
   reads is data, never instructions.
2. Each proposal passes `storable()`, is deduped against existing items (normalized token overlap above 0.8 is the same
   item: confidence rises, `updatedAt` moves), conflicts are resolved (section 2), and the rest is stored.
3. Proposals from a tainted turn wait for his yes (section 3). Nothing is stored silently from content he did not write.
4. A daily consolidation pass merges near-duplicates, applies decay, deletes expired items and writes one `episode`
   for the previous day (once per day, whatever the restarts): what he talked about, the jobs that moved, and each work
   session's latest summary. It makes no model call unless more than a handful of items need merging by meaning.
5. Job learnings: when a job ends, the extractor is asked specifically "what worked, what failed, what should the next
   attempt do differently", and writes `learning` items scoped to that project.
6. Episodes (MEM-18): the cheap model writes two or three sentences on what was asked, what was done and how it ended,
   as one `episode` item, when a job reports, when a work session leaves "active" (a job's session is left to the
   job), and when a persona's conversation has been quiet for 30 minutes. For the last, the desktop sends that
   persona's turns since its last episode to `learn` with `origin: "conversation"`, one stretch per project in a row,
   so a walled project's talk is scoped to that project and never folded into another episode. A stretch with a turn
   that read outside content waits for his yes. Its first run starts at the end of each file, so there is no backlog.
   The text starts with the day in his zone ("Tuesday, 3 November 2026, with Freya: ..."), dated from the last turn;
   the desktop sends his zone with learn and recall, and the server keeps the last one for job and session episodes.
   A conversation episode's `sourceRef` is `conversation:<persona id>:<first>-<last turn>`, built by the desktop and
   checked by the server against the persona that sends it: whose it was, until the persona column (P5) holds it. A
   job's or session's text is framed to the model as an agent's, which may quote pages. `learn` answers "kept",
   "skip" (never worth one, already written) or "retry" (the model or store failed), and the desktop moves on only on
   the first two. Every cheap call is counted per day in the memory meta and logged.

## 5. Retrieval

- The first prompt of the one assistant gets a memory block with a token budget (default 600 tokens): pinned items first,
  then by relevance to the opening context (project, target, current words) times effective confidence, highest first,
  until the budget is spent. Items are one line each and marked as his data, not instructions.
- Each spoken sentence then gets its own small block (300 tokens) of what matches that sentence only. A question that
  is not about what happened gets at most two episodes, after every other match, so a stale episode never outranks the
  fact that replaced it; "yesterday" and "today" add that day's name to the search for episodes only. The standing notes
  are already in the session, so they are not repeated, weak one-word hits are left out, and when he is focused on a
  session, other projects' items stay out. Only these items are recorded as used by the turn.
- On demand, `memory_search` returns ranked hits by FTS5 (bm25) on `text`, filtered by scope and kind, with each item's
  source and confidence. `memory_remember`, `memory_forget` (he is asked first, as today) and a new `memory_pin` keep their
  meaning; `memory_search` and the injected block record which ids were used in the turn.
- Walls (decision 6): a project named in the lead's `walled:` pack field keeps its items for its team, the personas
  whose `projects:` or `leads:` name it, and the lead. The wall is a filter on `scope`/`scopeRef` at recall and at an
  agent's search, never a second store. A search that names no persona sees nothing walled unless it says `admin`
  (his own view), so a new caller that forgets the persona fails closed. Only the desktop app's own session may name a
  persona or ask for `admin`: for any other token (a phone, a browser, an agent, a linked server's sync) every read
  (list, search, recall, used, export, sync pull) hides walled items, and a walled item is "no such memory" to its
  writes. The server's own upkeep sees everything (`MemoryViewer`). The standing block is read as the persona whose
  session it is (each persona has its own sessions, P1), so its team's walled items can sit there and no one else's. The
  extractor is shown only what the turn's persona may recall, and what a turn in a walled project learns is kept in that
  project whatever scope the model chose. His Memory page lists everything.
- "Show what you used" opens a card listing those items, from the per-turn record in `memory_uses` (turn id, item ids).
- "What do you remember about X?", "forget that", "remember that": the first is `memory_search`; "that" resolves to the last
  thing the assistant or he said, from the conversation file, so the tools take text or the previous turn's reference.
- Embeddings: FTS-first. A small local embedding column is behind a setting that is off by default and is not built
  until FTS retrieval proves insufficient; no new heavy dependency is added for it.

## 6. Where it lives and how it spreads

- The store is the Tessaya server's own SQLite file (`baton.sqlite`, tables `memory_items`, `memory_fts`,
  `memory_tombstones`, `memory_uses`, `memory_sync_peers`). The server is the one place: the desktop app, the web client, a
  phone and an MCP tool all call the same RPCs (`baton.memory.*`, scopes: read methods need the read scope, every write
  needs the operate scope, same as jobs). A laptop uses its own local server's store.
- The existing plain-text notes (D146) are imported once, idempotently (by content hash), as pinned `user` notes of kind
  `note`; the Memory tab keeps an "Open folder / Export" so he still owns plain files. Until the import runs, the desktop
  keeps reading the folder.

### Sync between servers (the two boxes)

Last-writer-wins with tombstones, behind a setting (`baton-memory.json` in the state folder, `{"sync": true}`; off by
default, switched in the Memory tab).

- **The window carries it.** Tessaya's window is already connected to every server he uses, so it relays. Sync carries
  walled items and can overwrite or delete any item, so `syncHello`/`syncPull`/`syncPush` answer only the desktop app's
  own session or a sync-only credential (`baton:memory-sync`, which a grant can carry only alone, minted on the server
  it reads). A server the window reaches with an ordinary paired token does not sync. A credential's first pull starts
  from the beginning, so items its server skipped before come over.
- **Pairing a peer.** "Pair for memory sync" on that server's desktop makes a one-time pairing code that grants only
  `baton:memory-sync` (or `t3 auth pairing create --scope baton:memory-sync` on its host). The window here trades it at
  that server's `/oauth/token` for the credential, which the desktop keeps wrapped by the operating system
  (`memory-sync-peers.json`) and hands to the window for each round; the window then calls that server's
  `/tessaya/desk/baton.memory.sync*` with it. This app's own server always syncs through the app's own session. For each ordered pair (to, from) of distinct servers it asks `to` for its
  `cursors` (`baton.memory.syncHello`), pulls what `from` wrote since that cursor (`syncPull`) and hands it to `to`
  (`syncPush`). The window runs a round every ten minutes and on "Sync now". A laptop whose window sees only its own
  server simply has nothing to sync with.
- Each server has an `origin` id (made once). Every local change sets `updatedAt` (wall clock) and `origin` on the
  item, the writer of that version. Two boxes on NTP agree to well under a second, which is far finer than the edits
  of one person; if clock skew ever matters, the cost is that the older of two near-simultaneous edits wins.
- Pull returns items and tombstones this server received at or after the cursor (`received_at`, not the writer's
  `updatedAt`, so a change relayed from a third server is not skipped; held proposals never leave their server), at most
  1,000 of each; a full batch returns the last stamp as `upTo`, so the next round resumes there. Otherwise `upTo` is the
  sender's now. Push applies and moves that peer's cursor forward only.
- Apply rule per id: the higher `(updatedAt, writer)` wins; a tombstone wins over an item whose `updatedAt` is not
  later than the tombstone's `deletedAt`, and a newer edit beats an older tombstone. Re-sending a version already held is
  ignored, so rounds are idempotent and may echo. `pinned`, `supersededBy` and `confidence` travel with the item, and an
  item keeps its original `source` (his own words stay his own).
- Every received item passes `storable()` again. A sync carries memory items only, never conversation text.
- A failure leaves the cursor where it was; the next round resends. Tombstones are kept (they are small).
- A backup carries the server's items, held proposals still held, as `memory-server.json`; a restore pushes them back as
  changes from a `backup` peer, so ids, his source, pins and history return and the door checks each again. A tombstone
  on the restoring server still wins over an older backed-up item.

## 7. Importing learnings

An importer reads a folder of `.md` files (read-only on the source, nothing written there). Each file is one item or one
item per top-level list entry; front matter keys `kind`, `scope`, `project`, `confidence`, `tags`, `updated` are honored,
and defaults are `learning`, `global`, 0.6. A memory feed exported by another tool is mapped by the same keys once its format
is confirmed. `sourceRef` is the file's path in the folder, and a file whose hash has not changed is skipped. When a
file changed, lines no longer in it are forgotten and only new lines are added, so an unchanged line is not reinforced.
An `operating-system` folder (his private pack) is never read. Everything passes `storable()`.

## 8. Order of work

1. This note and the shared interface (`memory.ts`).
2. The memory service on the server: migration, FTS5, pure rules in `memory.ts`, RPCs.
3. The learning loop: extractor, dedupe, conflicts, tainted holds, daily pass.
4. Retrieval into the assistant, voice commands, the "used" card.
5. Sync between servers.
6. The learnings importer.
7. The Memory tab in the window.
