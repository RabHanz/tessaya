# Tessaya for outside agents

An agent you connect to this computer's MCP URL, as described in [Outside agents](./outside-agents.md), also gets Tessaya's own tools. Nothing new needs setting up. The tools that look work at every access level, read only included.

## What it can see

- `tessaya_jobs` and `tessaya_watch`: jobs, their parts, and work that looks stuck or waits for you.
- `tessaya_record`: what happened, who did it and for which project.
- `tessaya_team_board`: who on the team is doing what: each persona's current jobs, its latest conversation and its newest Record lines. A private persona shows only whether it is busy.
- `tessaya_rules`: standing rules and when they last fired.
- `tessaya_sessions`: the Claude Code sessions on this computer, by title and folder.
- `tessaya_fleet`: what is live right now: each piece of work and its state, the Herdr panes and the running Claude Code processes.
- `tessaya_memory_search`: what Tessaya remembers.
- `tessaya_state`: how Tessaya is set up on your computer, one part at a time: settings, voice (including whether speech recognition is local or cloud), personas, skills, or diagnostics (versions, connections, recent error codes). Never a key, the vault or anything you said. It needs Tessaya's desktop app to be connected; to change a setting, an agent asks with `tessaya_ask`.

## Asking her to do something

`tessaya_ask` passes a request to Tessaya on this computer, such as "stop job 7", and `tessaya_ask_status` shows where it stands. She treats it as a request from a paired device, not from you: she asks you before she does anything, every time, and you can say no. An agent with read-only access cannot ask, and nothing is asked while Tessaya's desktop app is closed. A request waits five minutes for it. Each agent can have one request waiting at a time, and agents three in all, so they never crowd out your phone.

## Message a session in a terminal

- `weave_send` messages a coding session in a terminal pane, by its name. It types only into an empty input; if the session is busy or has a draft, the message waits its turn. It needs **Full access**, and it does not wait for your yes.
- `weave_list` shows those messages, newest first: whether each arrived, and what the session wrote back.
- Add `environmentId` to reach a session on a linked environment. A link paired below **Full access** cannot send.

## Move sessions between Tessaya and a terminal

- `tessaya_move_into_tessaya` moves a Terminal thread's session into Tessaya. It changes the thread's provider, so it does nothing unless the agent passes `providerChangeApproved`, which it should only do when you asked for the move. It is refused while the session works. T3's own thread agents can use it too.
- `tessaya_open_in_terminal` opens a Tessaya Claude thread's session in a Herdr pane; the thread comes back when the pane closes. It is refused while a turn runs.

## Agents messaging each other

An agent messages another agent's thread with `t3_thread_send`, here or on a linked environment (`environmentId`). To reach a session in a terminal pane that has no thread, use `weave_send`.

- A message from another agent starts with a line saying where it came from: the thread on this computer that sent it (and how to answer it), the linked computer, or the outside agent by name. Messages you send yourself never get that line, and neither do messages between a thread and the tasks it started on the same computer.
- A message from this computer, or from a computer linked with **Full access**, such as your own, goes through.
- A computer linked below **Full access** may message only the threads it started. Anything else is refused, and the refusal names the link. To let it through, pair it again with **Full access**.
- Nothing waits for your approval: a message goes through or is refused.
- Each sender may send 30 `t3_thread_send` and `weave_send` messages a minute. A sender is one thread together with the tasks it started, one linked computer, or one outside agent. Messages between a thread and its own tasks do not count.
- Every message and every refusal is written to the Record of the computer that received it.
- An outside agent, such as Codex in your terminal, sends with `t3_thread_send` and reads replies with `t3_thread_read` or `t3_thread_wait`. It has no inbox of its own: to receive messages, run it inside T3 Code or in a Herdr pane.

## Good to know

- Through Tessaya's tools an agent cannot approve, grant or widen anything, and it cannot act as you. Every request still waits for your yes; a `weave_send` message is signed with the agent's own name instead.
- Walls cover memory only: a walled project's memories never reach an outside agent. Jobs, the Record, sessions, and weave messages and their replies show every project.
- They are shown only to agents signed in from outside. The agents T3 Code runs in your threads do not get them.
- To check what an agent got, run `claude mcp list`, then ask it to list the Tessaya tools.
- Revoking the agent in **Settings → Sharing & access** ends its Tessaya access too.
