# Screen companion

Tessaya can see your screen when you ask, answer out loud, point at things, teach you an app step by
step, and do a task for you after you approve its plan. Design and the rejected options: D84.

## Using it

Three ways in, all the same feature:

- **Voice** (when Always listening is on): say a wake word, then "what's this error?"
- **Ctrl+Alt+Shift+B** opens the ask box. Type and press Enter; Esc closes it.
- **Tray**: "Ask Tessaya…".

What you say picks the mode:

| Say or type                                                                                            | Mode             | What happens                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "what's this error?", "look at my screen…", "where is the export button?", "look: …"                   | **Look**         | One screenshot of every display goes to Claude with your question. The answer is spoken and shown on a card, and the blue pointer flies to what it means. Follow-ups in the next five minutes remember the conversation.                                                                                                |
| "teach me how to …", "show me how to …", "walk me through …", "guide me", "… step by step", "teach: …" | **Teach**        | One step at a time, each pointed at, with a word on why. Do the step and Tessaya notices (the screen changes and settles), checks it worked, and gives the next. Say "next" to move on yourself, "repeat" to hear it again, "stop" to end.                                                                              |
| "drive: …", "take over …", "do it for me", "open the downloads folder for me"                          | **Do it for me** | One box lists the steps in plain words: **Go ahead**, **Change a step**, or **Not now**. After Go ahead she does them while you watch her own small cursor (your mouse stays yours), checking each result; anything that deletes, sends, pays, publishes or reaches a command line still asks. Esc or "stop" stops her. |

The table is what people say. The one assistant decides, on voice and in the ask box alike; only the `look:`, `teach:` and `drive:` prefixes skip it.

**How long things stay.** The pointer stays on its target and the card beside it until the narration
has finished and you have had time to read: at least 3 s after speech, more for long text, with a line
counting down. Long answers turn pages at sentence ends. Say "stop" or use Tray, Clear the screen, to
take it all down, voice included. Esc is left to your apps. A lesson's step stays until the step is done. Rules: D110.

**While Tessaya acts** (the assistant's hands, Drive, a remote session) nothing is drawn over the app it works in: no box,
ring, dots, Stop window or thinking card. The pill says it is working and a click on it stops the work; one card gives the
result at the end. Its questions come up without taking the keyboard, so answer them with the mouse, by voice or on the phone.
Pointing (Look, Teach) shows the pointer and a word, never a box round the control. The assistant presses a
named control through its own UI Automation pattern, so your mouse pointer stays put; it moves the real
pointer only for a control with no pattern, or a click by position. Rules: D153.

**Spoken and written, or Written only.** From the tray (Answers) or the ask box, remembered. In Written
only nothing plays, and every answer, action, plan and step is on screen in full.

**Approval.** Every screenshot asks first: Allow (this question), Allow for this lesson,
Allow for an hour, or Always allow. Turn "Always allow screen capture" on or off from the tray. A
"do it for me" plan always shows its steps for your Go ahead, whatever that setting says. Screenshots
go to Claude with the request and are not saved.

**Your subscription, not the API.** Answers come from your own Claude Code (`claude`) signed in
to your plan. Tessaya strips `ANTHROPIC_API_KEY` from what it starts, so it can never bill the API.

## Against what HeyClicky claims

Their claims, verbatim and with frames: `research/clicky-videos-2026-10-27/`. These are the
vendor's own words; none of it was installed or measured.

| They claim                                                                                                                                               | Tessaya now                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Asks about anything on screen, by hotkey or voice, any app                                                                                               | **Has it** (Look; voice, ask box, tray)                                                                                           |
| A triangle pointer flies to the target; the real cursor never moves while guiding                                                                        | **Has it** (farzaa's pointer and flight; the cursor only moves in Drive)                                                          |
| Teach: step labels beside each target, speaks the step, notices you did it, gives the next                                                               | **Has it**, by watching the screen change rather than the click itself; label pill and step card                                  |
| Drive: one consent card, "Esc takes it back", narrates the current step, stops on Esc, a Stop button or speech; the mouse stays his, checks its own work | **Has it**, with the full plan listed before consent; Esc, "stop" or a click on the pill stop it; steps with `expect` are checked |
| Drawing arrows, circles, explanation cards, 3D models                                                                                                    | Partly: caption card and the pointer's label; no free drawing or 3D                                                               |
| "Spatial context": you paint on screen to show what you mean                                                                                             | Not built                                                                                                                         |
| Agents in your own Chrome, routines by voice                                                                                                             | Not here: Tessaya's sessions and rules (Phases 4, 9) do this through Claude Code instead                                          |
| Memory files (profile, recent screens hours back)                                                                                                        | Partly: a look conversation lasts five minutes, a lesson its whole run; nothing kept across them                                  |
| Skill files per program                                                                                                                                  | Not built                                                                                                                         |
| Dictation, screen-aware                                                                                                                                  | **Partly.** Mode comes from the focused app (D105); the screen is not read                                                        |
| Mac and Windows                                                                                                                                          | Windows and Linux; macOS capture and pointing should work, Drive refuses there                                                    |
| Free / $20 / $100 plans with message caps                                                                                                                | His own Claude subscription; no caps of Tessaya's                                                                                 |

## Settings

`baton-screen.json` in Tessaya's state directory (next to `fabric-voice.json`):

```json
{
  "captureApproval": "ask",
  "claudeBinary": "claude",
  "model": "claude-opus-5-5",
  "output": "spoken"
}
```

- `claudeBinary`: the path to `claude` if it is not on PATH (e.g. `C:\\Users\\you\\.local\\bin\\claude.exe`).
- `model`: the assistant's model; the default is `claude-opus-5-5`. A family alias (`sonnet`, `opus`) follows the newest model.
- `output`: `spoken` or `written`; Tray, Answers. An old `speak: false` reads as `written`.

## What the Windows laptop showed (2026-10-31)

| #   | Check                                         | Result                                                                                                                    |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude found and signed in                    | **Pass.** 24 real requests traced, `D:\baton-voice-lab\lab\trace2`                                                        |
| 2   | Pointer lands, 175 % and 125 %, both displays | **Pass.** Mapping 18 of 18 and the model 10 of 10 within 1 DIP on known markers (D101)                                    |
| 3   | Overlay stays out of a capture                | **Pass on both displays.** 18 markers visible without protection, 0 with                                                  |
| 4   | Teach notices him                             | **Pass after a fix.** It watched only the cursor's display; it now watches all of them (D107). Step 2 came with no "next" |
| 5   | Drive, Esc                                    | **Pass after two fixes** (D107). A real Esc stopped a longer plan at step 1. The mouse no longer stops anything (D115)    |
| 6   | Voice reaches the companion, reads answers    | **Path passes from WAVs**, wake to brain to router. Nothing has been heard through his speakers                           |
| 7   | Ctrl+Alt+Shift+B free                         | **Pass.** Registered on his desktop                                                                                       |

UI Automation now snaps on real elements on the 125 % display; the 175 % display and the taskbar are not rerun.

## Windows lab

`src/tessaya/screen/smoke/overlayLab.ts`: the real companion and pill, a scripted `claude`, silent speech,
no global keys, and `timeline.jsonl` with what the overlay really showed, every 50 ms, per display. The
overlay is excluded from capture, so set `LAB_VISIBLE=1` to see it in screenshots.

## Running the Linux smoke

```bash
# xdotool and xcompmgr can be user-local: apt-get download + dpkg -x, then
BATON_SMOKE_XBIN=<extracted>/usr/bin scripts/tessaya/screen-smoke.sh /tmp/screen-smoke look,teach
```

It opens a small form, asks a Look question and runs a lesson with xdotool as the user, writing full-screen frames, the approval texts and `results.json` to the folder.
