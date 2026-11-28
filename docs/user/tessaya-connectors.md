# Connectors: calendar, mail and chat

Let Tessaya (through Claude Code) reach your calendar, your mail or your chat.

## Start

Open the **Skills** page and find **Connectors**. Calendar, mail and chat each say whether one is connected. To connect one, paste the https address of an MCP server you trust (or the command that starts one) and press **Review**.

## What to know

- **Tessaya names no vendor and ships no connector.** You bring the server. It does not check the server for you.
- **A card shows the exact command** (`claude mcp add ...`), where your data would go, what the server can reach and do, and what to be careful about. Nothing is added until you press Connect.
- A server you start with a command (for example one run through `npx`) downloads and runs code from the internet each time; the card says so.
- The first time Claude Code uses a remote server it asks you to sign in with that service.
- Anything read from your mail or chat is treated as information, never as instructions. Sending, posting and changing events still ask you first.
- Remove one later with `claude mcp remove <name>`; the name is on the card.

## The Margin

If you use The Margin for your day, lists and reminders, Tessaya reads them live from it on every device: "what's on my Margin today", "add milk to the shopping list", "tick off the eggs", "remind me to call Sam on Friday at nine". She adds and ticks things there; she never deletes, shares, pays or sends anything from it. Your own items are yours alone; anyone at home can use the shared shopping list, chores and family calendar.

The Margin can also tell her when something of yours is due. She says it on the device you are nearest, unless it is quiet hours, you set do not disturb, someone else is in the room, or you are nowhere near a speaker. Then it waits as a card on your phone.
