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

## The R1 desk device (Settings → Hardware)

Settings → Hardware shows each Agora R1 this server hears: online, battery, Wi-Fi, firmware and when it was last
seen, with its controls. To add one, give its id, the MQTT broker it listens on and its device key under **Set up an
R1**. **Forget** removes all of it from this server again.

- **Mute** stops it listening and speaking until you unmute it.
- **Voice transport:** in-house is Tessaya's own room voice. Trying Agora's cloud goes back to in-house, muted, after
  60 seconds unless you press **Keep**; **Revert to in-house** works at any time. After every restart the server sets
  in-house voice again, since the device forgets it.
- **Room brain:** how the R1's turns reach Claude: your Anthropic key from Settings → APIs (quickest), your Claude
  subscription, or Automatic (the key, then the subscription if the key fails). It applies from the next thing you say.
- **NFC tags:** tap a tag on the R1, then name it and choose what a tap does (mute, unmute, show a mood, or run a
  Home Assistant scene, which still asks first when the scene is a risky one).
- **Camera:** one picture, only when you press **Take one**. A "Camera on" badge shows while it waits for the
  picture. The picture is kept in memory for 10 minutes, never written to disk, and **Delete now** removes it sooner.
  When an agent or the assistant asks for a picture or a restart, you get the question on your phone first.
- **Diagnostics:** how long each stage of a spoken turn took, and the device's recent log.

**Talking to it.** Press S2 or start with her name ("Tessaya, …"); for about 8 seconds after each reply you can go on
without the name. Anything else said in the room, such as your dictation, a call or the TV, is not answered. Say
"dismissed" or "that's all" to end the conversation; her name or S2 wakes her again. After 15 quiet minutes the
R1 stops listening, and S2 starts it again.

**Other personas.** Start with another persona's name ("Alfred, …", "Freya, …", "Sebastian, …") and that persona
answers in its own voice, with its own eyes on the R1 and its own memories. It stays on for follow-ups in the 8-second
window; once the R1 rests, Tessaya answers again.

**Buttons** (firmware 3.32 and later). Some presses are the R1's own and cannot change: S2 tap starts or stops
talking, holding S2 is push-to-talk, a long S2 press wakes it, S1 and S3 taps turn the volume up and down, and holding
S1 and S3 together for 5 seconds starts Wi-Fi setup. The rest are yours under **Buttons** in Settings → Hardware: the
double presses, the 3-second long presses of S1 (mic mute by default) and S3 (deep sleep by default), and holding S1
or S3 for under 3 seconds. Each can do one of the R1's own actions or one of Tessaya's: switch persona (announced in
the new voice), tell you what's next, toggle a lamp or run a scene (risky ones still ask first), mute her, continue or
stop a thread, or ask her something you write. A double press of S2 switches to the next persona until you change it.

Firmware updates need new firmware and come later.
