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
