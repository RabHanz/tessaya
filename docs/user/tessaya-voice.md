# Voice

Talk to Tessaya instead of typing.

## Start

Turn on **Listen for my wake word** in Settings, Voice and wake words. Say a wake word (the ones that are on are listed there; each is a switch) and then your request, in the same breath or after a pause. It listens for about eight seconds for you to start, and a conversation stays open for 30 seconds after each answer, so follow-ups need no wake word.

## Personas

Each wake word is a persona with its own name and voice: say "Freya" and Freya answers in her voice, say "Alfred" and Alfred answers in his. They share one conversation, memory and set of permissions, so Freya knows what Alfred just told you. Tessaya, the lead, answers a hotkey, a typed question, or a wake word that has no persona. Sebastian has no wake word yet: start a typed question with his name.

Change a persona's voice in Settings, Personas and voices, and press **Play** to hear it; **Default** puts it back. In T3's Settings → Voice, **Persona voices** does the same from any device, and **Voices on this machine** plays a sample of every one of Tessaya's 27 voices. Voices marked **Personal use** come from recordings without a commercial licence. With a Google key saved in Settings → APIs, a persona can also have a **cloud voice** (Gemini, British voices); it is spoken by Google and billed to that key, and when Google cannot be reached the persona speaks in its own voice. Stage directions in a reply, such as "_sighs_" or "(laughs)", are never read out: they become a breath, a soft laugh or a short pause, and "hmm" or "ugh" are said as sounds. Each persona is the front-matter (`name`, `wake`, `voice`, `cloud voice`, `role`, `model`, `effort`) at the top of its file in the operating-system pack folder. `model` and `effort` choose what that persona thinks on in its jobs, and the most it uses in conversation: the lead on `opus`, the others on `sonnet`, both at `medium`, unless you change them. In conversation a simple question (the time, what needs you, a yes) is answered on `haiku`, most sentences on `sonnet`, and only planning or a chain of actions on the persona's own model, so replies come sooner. To choose yourself, say "use Opus" (or Sonnet, Haiku), "think harder" or "go faster", or pick under **Model for conversation** and **Thinking effort** in Settings or **Model** in the tray menu; your choice holds, above any persona's own model, until you say "back to normal" or pick **Automatic**. An optional `tools` line (for example `tools: type_text, click_element, Read`) limits that persona to those tools; it can only take permissions away, never add any. `projects` (for example `projects: shop, site`) puts a persona on those projects' teams, and `leads` makes it a project's own lead, able to start, split, hand over and schedule that project's jobs (never cloud work, and a job it starts gets no folders of its own). Two projects can share a title: write `leads: shop@studio` for the shop project on the computer called studio; a bare `shop` counts only while one project has that title. Add `walled: shop` to the lead's file to wall a project's memories: only its team and Tessaya recall them. A question asking your yes names the persona that wants to act. Choosing **Quick** or **System voice** under **Voices** on the same page gives every persona that one voice.

## Voice ID

Voice ID lets Tessaya know when it is you speaking. Turn it on in Settings, Voice and wake words, Voice ID. The first time, it downloads a 30 MB voice model. Then press **Make my voice profile** and read the three sentences shown, with voice on. If **Use your Wispr recordings** is on, Tessaya also reads up to 60 of your Wispr Flow recordings, once and read-only. Your profile is a list of numbers, not audio, and it never leaves this computer. **Re-enrol** makes it again and **Delete** removes it.

Under **People**, type someone's name and press **Add** while they sit with you. They say yes and read the lines shown. People you saved get read-only answers and can leave you a message, but they cannot make Tessaya act. Removing a person also removes what Tessaya remembers for them.

- With **Respond to other people** off (the default), voices Tessaya does not know are ignored.
- Only you can cut in by talking over her, unless **Saved people can talk over her** is on.
- Your recognised voice can confirm everyday things. Anything risky still needs the card on screen or on your phone.
- A very short reply ("yes", "stop") is too short to tell voices apart. It counts as unverified, and a risky yes then always needs the card.
- If the model or your profile is missing, Tessaya hears everyone as before, unless **Ignore everyone if Voice ID cannot run** is on.

## Household

Tessaya serves everyone who lives with you. In Tessaya's window, open **Memory**, then **Household**. Pick a role and type a name under **Add someone**: they get a code to pair their own phone, valid for a day. Then press **Enrol voice** beside them while they sit with you, so Tessaya knows their voice as theirs. You can also ask her by voice ("add my sister Maya as an adult", "who lives here?", "who's home?").

- **Roles**: an admin manages members and devices but never the owner; adults have their own memory, devices and asks; children are limited; guests can talk and nothing more. A new device of theirs never gets your computer's threads, terminals or files unless you give them **this computer** separately.
- Adding someone, raising a role and removing someone by voice is sent to your phone or desktop for a yes first.
- **Remove** signs them out everywhere at once and keeps their data for 7 days so they can export it; **Restore** undoes it until then. **Remove now** destroys their data at once, for a safety case.

## Good to know

- **Stop** it by saying "stop", "quiet", "enough" or "cancel" while it talks. It hears those with no wake word and nothing else said over its voice.
- **Quiet speech** (Settings, Voice and wake words) is for whispering or a faraway microphone: Tessaya lifts what it hears and accepts a fainter wake word. It also lifts room noise and allows more false wakes, so it is off until you turn it on.
- **Mute** from the tray; the microphone is off while muted.
- **Written only** (tray, Answers) shows every answer on screen and plays nothing.
- A wake word that has no model on this computer stays off.
- On Linux and macOS the voice starts and hears the test phrase; the hold-to-dictate key and pasting into other apps were not tried there.

Related: [Dictation](./tessaya-dictation.md).
