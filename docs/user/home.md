# Home (Home Assistant)

Tessaya can read and work your house through your own Home Assistant. Home Assistant stays the house's brain: she
reads it live, acts through its own services, and writes automations into its own list. Nothing of your house is
copied into Tessaya.

## Connect

Settings → Home. Give Home Assistant's address as this server reaches it (and a second address for the same house
if you have another route), and a long-lived access token from an administrator (Home Assistant → your profile →
Security). Tessaya tests it, then keeps the token in this server's secret store; it is never shown again or sent to
any app. Disconnect removes it. One server holds the connection; your other servers that are linked to it ask that one.

If the house's network is down, Settings shows "Home is unreachable" and nothing is changed until it is back.

## What she does by herself, and what she asks first

- **Does it:** lights, fans, media, harmless switches, scenes and scripts whose devices are all of these.
- **Asks you first:** locks, the alarm, sirens, garage and doors, cameras, pumps, heaters and ovens, heating set
  outside 16–28 °C or turned off, more than five devices at once, restarting Home Assistant, changing an
  automation she did not make, and any automation whose actions are in this list. The question arrives on your phone
  (and under Settings → Home → Waiting for your yes) and lapses after two minutes. A yes is never taken from the desk
  device's microphone, since anyone in the room can talk to it.
- **Never:** stopping Home Assistant or shutting down or rebooting its host. Do those in Home Assistant.

You can move any one device up or down in Settings → Home → Asks first.

## Automations she makes

Every one is marked in Home Assistant: its id starts with `tessaya_`, it carries the label **Tessaya**, and its
description ends with whose request it was and when it ends.

- **Permanent:** stays until you delete it.
- **Temporary:** ends at its time and is removed. It also stops working on time by itself, even if Tessaya is down.
- **Scratch:** for trying something; removed after 24 hours, or after its first run.

"Turn the fan off in 30 minutes" becomes a temporary automation, so it still happens if the server restarts.

## Undo

Every change she makes in the house can be undone for 24 hours: Settings → Home → Recent home actions, or ask her
to undo it. Undo puts the devices back as Home Assistant had them just before (if Home Assistant restarted since,
that snapshot is gone). Deleting one of her automations can be undone for 7 days. Every action is in the Record and
in Home Assistant's logbook.

## The Tessel desk device (Settings → Hardware)

The Tessel was called the R1 until November 2026. Its main body, the shell the board sits in, is the Tumble.

Settings → Hardware shows each Tessel this server hears: online, battery, Wi-Fi, firmware and when it was last
seen, with its controls. A home can have several. To add one, give its id and its device key under **Set up a Tessel**. Leave the broker empty
when the Tessel connects to this server itself (`ws://<this server>:<port>/api/tessel/mqtt`; devices paired earlier keep using `/api/r1/mqtt`), which needs no broker of its own;
fill it in only for a Tessel on a separate MQTT broker. **Forget** removes all of it from this server again.

### Set up a Tessel

1. A new Tessel shows a pairing QR on its right eye. On your phone, Settings → **Add a Tessel** scans it. On the web or
   desktop, Settings → Hardware → **Add a Tessel** takes the QR's text (`T3R1:…`).
2. Give your Wi-Fi name and password, then **Set up over Bluetooth** (phone, desktop, Chrome) and type the six digits
   the Tessel's eyes show. Without Bluetooth, **Get a setup code**, join the Tessel's own Wi-Fi (the QR on its left eye) and
   paste the code into its page.
3. After the first Tessel you are asked once whether it may work away from home.
4. Her voice then downloads to this server by itself, about 1 GB, once: Hardware shows **Voice** with its progress,
   then "The Tessel's voice runs on this server." It needs a Linux (x64) server from a Tessaya release and about 2 GB free
   disk. A server where another machine already runs the Tessel's voice leaves it alone. Set `TESSAYA_R1_LOOP=off` to
   keep a server from running it.

Her room voice hears you with Parakeet TDT 0.6B v3 by NVIDIA, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and speaks with Pocket TTS by Kyutai (CC BY 4.0).

**Updates.** A Tessel that connects to this server gets the Tessel firmware that comes with this Tessaya, from this server,
once it has been idle for 5 minutes. It says so before and after. If it does not come back on the new version within
7 minutes it goes back to the one before, and that version is not tried again; Hardware shows why.

**Update or repair (Hardware → Device utility).** Choose a level:

- **Easy** has one button. It updates the Tessel now if it is online. It doesn't wait for idle, but it never starts during a
  conversation, a call, or below 30% battery unless the Tessel is charging.
- **Normal** installs any signed release, including an older one. An older release pauses automatic updates until you
  choose **Resume automatic updates**.
- **Developer** sends raw commands and shows the Tessel's log.

A Tessel that stays offline, for example after a power cut during an update, is repaired by cable: plug it into a
computer and use the Tessaya desktop app there, or the standalone flash tool from the Tessaya releases (`tessel-flash`, called `r1flash` in older releases). It's one
file with nothing to install, and it lists the port, checks the image's signature, keeps the Tessel's settings and writes
the firmware.
The Tessel's own wake model pack comes the same way, once it runs this firmware. **Own wake model** in Hardware shows its
mode and pack: **Shadow** has the Tessel report what it hears while Tessaya still decides, **Off** stops it, and **Unload**
removes the pack until you choose Shadow again.

**Away from home.** At home the Tessel connects over your own network. Turn on **Away from home** (in Hardware, by asking
Tessaya, or from the card your phone gets when the Tessel could not reach home) and it can also connect through T3 Connect
when it is elsewhere; turn it off to keep it home only. The server sends the Tessel its addresses by itself, also when your
network changes. It needs this server linked to T3 Connect (Settings → Connections), and for the fastest replies at home,
network access turned on.

- **Mute** stops it listening and speaking until you unmute it.
- **Voice transport:** in-house is Tessaya's own room voice. Trying Agora's cloud goes back to in-house, muted, after
  60 seconds unless you press **Keep**; **Revert to in-house** works at any time. After every restart the server sets
  in-house voice again, since the device forgets it.
- **Room brain:** how the Tessel's turns reach Claude: your Anthropic key from Settings → APIs (quickest), your Claude
  subscription, or Automatic (the key, then the subscription if the key fails). It applies from the next thing you say.
- **NFC tags:** tap a tag on the Tessel, then name it and choose what a tap does (mute, unmute, show a mood, or run a
  Home Assistant scene, which still asks first when the scene is a risky one).
- **Camera:** one picture, only when you press **Take one**. A "Camera on" badge shows while it waits for the
  picture. The picture is kept in memory for 10 minutes, never written to disk, and **Delete now** removes it sooner.
  When an agent or the assistant asks for a picture or a restart, you get the question on your phone first.
- **Diagnostics:** how long each stage of a spoken turn took, and the device's recent log.

**Talking to it.** Press S2 or start with her name ("Tessaya, …"); for about 8 seconds after each reply you can go on
without the name. Anything else said in the room, such as your dictation, a call or the TV, is not answered. Say
"dismissed" or "that's all" to end the conversation; her name or S2 wakes her again. After 15 quiet minutes the
Tessel stops listening, and S2 starts it again.

**Other personas.** Start with another persona's name ("Alfred, …", "Onyx, …", "Freya, …", "Sebastian, …") and that persona
answers in its own voice, with its own eyes on the Tessel and its own memories. It stays on for follow-ups in the 8-second
window; once the Tessel rests, Tessaya answers again.

**Work by voice.** Ask for a job ("start a job in my app to fix the login bug, have Codex do it") and Tessaya opens
it in its own thread, where the worker writes a plan and starts nothing until you agree. She says on that Tessel when the
plan is ready and when the job is done or needs you, outside quiet hours (22:00 to 08:00 on the house's clock) and at
most three times an hour. Say "go ahead", pass on changes, split it across the team, stop it or try it again by
voice; these need your recognised voice. Putting a job on a schedule always asks for a yes on your phone first.

**Buttons** (firmware 3.32 and later). Some presses are the Tessel's own and cannot change: S2 tap starts or stops
talking, holding S2 is push-to-talk, a long S2 press wakes it, a tap on its head stops her while she speaks, and holding
S1 and S3 together for 5 seconds starts Wi-Fi setup. The rest are yours under **Buttons** in Settings → Hardware, or by
asking Tessaya ("make double-press S1 switch to Freya"): double and long presses, holding S1 or S3 for under 3 seconds,
and a long touch on the head. With firmware 0.3.108 and later also the S1 and S3 taps (volume up and down by default),
triple presses, and the play/pause, next and previous buttons of Bluetooth headphones or a speaker playing from the
Tessel. Play/pause starts a conversation or ends it by default, and while she speaks it stops her; the headphones'
volume buttons are the Tessel's volume. A press can do one of the Tessel's own actions (talk, mic mute, volume, deep
sleep) or one of Tessaya's: switch persona (announced in the new voice), tell you what's next, read the time, repeat her
last reply, Do Not Disturb, toggle a lamp or run a scene (risky ones still ask first), mute her, continue or stop a
thread, or ask her something you write. A double press of S2 switches to the next persona until you change it. A tap
acts at once unless that button has a double or triple set, when it waits a third of a second for the next tap. When
the Tessel cannot reach this server, a press set to one of Tessaya's actions does its default instead, so volume and
talking still work.

**Screen** (firmware 3.32). Auto turns the screen with the Tessel; Normal or Upside down pins it. If Auto has it the
wrong way up, stand the Tessel the way you use it and press **Set upright**.

Firmware updates need new firmware and come later.
