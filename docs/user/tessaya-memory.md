# Memory

Tessaya remembers what you tell it and what it learns while working, and shows you all of it.

## Start

Say "remember that ..." or open the **Memory** page. Every memory is a row you can pin, edit, or forget. **Why?** on a row says where it came from, how sure Tessaya is, and what keeps or ends it.

## Good to know

- Your own words always beat a guess. Something newer from you replaces something older, and the old one stays under **Replaced**.
- Things Tessaya learned from a web page or a file wait under **Waiting for your yes** and are not used until you keep them.
- A forgotten memory waits in **Recently forgotten** (Settings) for 30 days, or however long you set there, and nothing she learns brings it back meanwhile. Restore it there or say "put that back"; after that it is deleted for good.
- Once a week near-duplicates are folded into one. Your own wording is never rewritten and pinned items are never dropped.
- It refuses to keep passwords and keys. Use the [Vault](./tessaya-vault.md) for those.
- Memory is used in the first prompt of a turn within a small budget; **used in the last answer** marks what it was.

## More than one computer

Turn on **Keep servers in step** on the **Memory** page to carry memory between the servers this window is connected to. Each server needs to be paired once, because memory kept behind a project's wall travels only over a credential that can do nothing but sync:

1. On the other computer, open **Memory** and press **Pair for memory sync** in its own server's row. It shows a code that works once, for five minutes. On a server without the app, run `t3 auth pairing create --scope baton:memory-sync` there instead.
2. Here, enter that code in that server's row and press **Pair**. The row then says its walled memory syncs.

The credential is kept only if this computer can encrypt it, and it works for a year: the row says until when, and a server that stops accepting it is shown as not syncing again. A row that says **Walled memory not syncing: pair for sync** has no credential yet. **Stop syncing walled memory** drops it here; to end it on the other server too, revoke **Tessaya memory sync** in its **Settings → Sharing & access**.

## What she has learned

When a turn took her far too many steps, open **Memory**, **What I've learned**, and press **Learn from that**. She writes a short skill from what you said and which tools she used (never from what was on your screen or in a file), then tests it by replaying that turn without and with it. A skill is kept only if the turn gets shorter and none of the turns she kept for testing gets worse. It then waits for your **Accept**; **Reject** keeps the idea from coming back for 30 days, and **Forget** deletes it. Turn on **Every night, learn from the day** (Trust page, Standing jobs) and Tessaya does the same by herself once a day from 2 o'clock: she picks the last day's slowest or corrected kinds of request, writes and tests a skill for the worst two, and leaves any that pass waiting for your **Accept**. Nothing is used without your tap, and a skill that fails its test is not tried again. While it is on, the turns she learns from stay on this computer for two days, with obvious secrets taken out. Skills are plain files in the `skills` folder of your operating-system pack. A skill is advice only: everything she does still asks you exactly as before.
