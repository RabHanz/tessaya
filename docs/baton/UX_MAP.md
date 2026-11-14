# The Tessaya window: page map (2026-11-04)

One page: what is where today, what is buried, and where each setting goes. Written before the rebuild; the target
column is what the rebuild implements. Colours and the logo are not part of this.

## Today

A left list of tabs, one page each, built from the controls the app reports (`tabs.ts` says which tab a control is on,
each control names its section, and a control marked `more` is hidden behind a bare "More options" button). A choice
with more than two options, or long labels, shows only its current value behind a "Change" button. The wake words
are one row, "Wake words", behind "Change", inside the folded part of Listening.

| Tab                              | Sections today                                               | Folded or behind "Change"                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice                            | Listening, Answers, On screen                                | Wake words (folded, then behind Change); "Send words to the focused session" (folded); "Where the pill sits" (folded); "Sounds for the dictation key" (folded); every choice (mic, wait, sounds, voice, volume, how it answers) behind Change |
| Dictation                        | Dictation                                                    | Clean up with AI, Writing style per app, Speech model, Last transcript (folded)                                                                                                                                                               |
| History                          | Recordings                                                   | none                                                                                                                                                                                                                                          |
| Memory                           | Notes, Operating-system pack                                 | pack roles and routing (folded)                                                                                                                                                                                                               |
| Skills                           | Plugins, Skills, MCP servers                                 | skills (folded)                                                                                                                                                                                                                               |
| Assistant                        | Working for you, Notices                                     | social accounts, Address, "Always allow screen capture" (folded); the brain and the login behind Change                                                                                                                                       |
| Screen                           | Screen                                                       | screen-capture consent                                                                                                                                                                                                                        |
| Checks                           | Check                                                        | all results (folded)                                                                                                                                                                                                                          |
| Sessions, Jobs, Approvals, Usage | live lists                                                   | not settings                                                                                                                                                                                                                                  |
| Settings dialog                  | General, System, Keyboard and mouse, Account, Updates, About | the voice settings file path                                                                                                                                                                                                                  |

Problems: the most used voice options sit under a fold or a button; "More options" says nothing about what it holds;
timings a user feels (how long it listens) were not settings at all; there was no way to search.

## Target

**Rule.** A setting people use is visible, in a section named for the task. A choice of four or fewer shows its
options in place (no Change button). A fold is kept only for the rare, is named by what it holds ("Advanced: wake-word
checks, dictation-key sounds, settings file"), and never says "More options". Every row has one plain line under it.
A search box in the window's top bar finds any setting by its words and opens its page.

**Voice**

- _Wake and listening:_ Listen for my wake word; Mute; Microphone; Wake words (each a switch, visible); Check the
  wake word before waking; Listen after waking (4 / 6 / 8 / 12 s, default 8: it waits only for you to start); Keep the
  conversation open (15 s / 30 s / 1 / 2 min, default 30 s); How long I wait for you to finish; Send words to the focused session.
- _Answers and voice:_ How Tessaya answers; Voice; Speaking volume; Hear the voice; Sounds.
- _On screen:_ Put the pill in the centre; Show a small bar when Tessaya is not listening; Where the pill sits.
- _Shortcuts:_ the fixed keys, read-only.
- _Advanced (folded, named):_ Sounds for the dictation key.

**Dictation:** _Dictate with_ (engine, speech model, how words arrive); _Clean-up and style_ (Clean up with AI, writing
style per app, learn words from my edits); _Last transcript_. Nothing folded except the speech-model picker.

**Assistant:** _Who does the work_ (works through, login, one assistant); _What it may do_ (act without asking,
always allow screen capture, Chrome, social accounts); _Notices_ (unchanged). Folded: "Advanced: login address".

**Screen:** screen-capture consent and what Tessaya can do with the screen, both visible.

**Skills, Memory, Checks:** lists stay lists; Checks shows results open, with the buttons at the top.

**Settings (2026-11-06).** The sidebar holds the work pages only (Now, Dictation, Knowledge; Help and Settings at its
foot). Every setting is in the Settings window, in exactly one category: General, Voice and wake words, Personas and
voices (the only place a voice is chosen), Working for you, Memory and privacy, Appearance, Keyboard and mouse,
Advanced, About. `SETTINGS` and `tabOf` in `apps/desktop/src/tessaya/home/tabs.ts` are the one table; an unplaced id
lands in Advanced, never nowhere.

## Search

A box in the top bar. It matches the words of every setting's label, hint and section, shows the matches as the
real rows (so they can be changed in the results), and each result says which page it lives on with a link to it.
Nothing is indexed anywhere else: it reads the same list the pages are drawn from, so it cannot drift.
