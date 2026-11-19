# Body playground

A stage for trying out her 3D body: pose it, set its face, build and scrub scenes, and let any agent drive it. Nothing you do here reaches her body on your desk or interrupts a conversation.

## Open it

Go to `/tessaya/playground` on your server, for example `https://<environment-address>/tessaya/playground`, in a browser signed in to it. It opens on your own model when you have one: the last one you used here, then the body she wears now. You can also drop a `.vrm` or `.glb` file on the page; it is shown, never kept. A server without any model of yours opens on a free (CC0) everyday body, downloaded once the first time.

- **Move**, **Pose**, **Face** and **Scenes** drive the body by hand. **Check** reads the model's own licence and what the body had to correct; **Body** lists what this model can do.
- **Compare** (or press C) adds a second stage beside the first, for watching two runs side by side.
- Press ? for the keyboard shortcuts.

## Let an agent drive it

Each stage shows its playground id in its corner, such as `pg-k3x9a2b`. An agent connected to your server's MCP ([Outside agents](./outside-agents.md)) drives it with the body tools:

- `tessaya_body_move` and `tessaya_body_scene` with `target: "playground"` move the stage's body; `tessaya_body_state` with the same target reads it back.
- Add `playground: "<id>"` to pick a stage, such as the second one in Compare. Without it, the most recently open stage is used.
- Outside agents use the playground unless they ask for `target: "her"`. Only everyday moves play here.

## Connect an agent for her body only

To let an agent drive the body and nothing else, approve its sign-in at **Her body only** ([Outside agents](./outside-agents.md#approve-a-sign-in)). Choose it in **Use T3 Code in another app (MCP)**, or on the sign-in page; a code made for it starts with `BODY-`. The agent then sees only `tessaya_body_move`, `tessaya_body_scene` and `tessaya_body_state`.

- Each agent is limited to a burst of 12 moves, then 4 a second, and every move it makes is in the activity log under its sign-in.
- Remove it in **Settings → Sharing & access** like any other agent.
- A body-only agent never moves or reads her own body unless you turn on **Body-only agents move her body** in **Settings → Brain**. Even then, a conversation you are in keeps her, and private moves are always refused.

## Agent drives her

**Agent drives her** lets you watch a model drive the playground through the same body tools an outside agent uses.

1. Pick the model: Haiku, Sonnet, Opus, or her own brain (the model Settings → Brain gives her talking). With **Compare** on, pick one for each stage to see two side by side.
2. Type one direction per line, such as "shrug like you don't know".
3. The estimated cost shows before anything runs. Nothing runs until you press **Run**. It uses your plan or key, the way her talking does, and its usage shows under "body-playground" on the Usage page.

Each run lists its tool calls as they land, how long until the body first moved, and the checks her direction eval uses: which channels moved (body, face, gaze, timing), joints kept inside a person's reach, and moves too fast for a person. Rate a run **Good** or **Bad** with a note; good runs that pass those checks are kept for her motion library, in `tessaya/body-playground-ratings.json` under the server's data folder.

**Also on her desk body** plays the same calls on her own body too. It is off by default, and a conversation you are in still keeps her. Only your own sessions can run agents here.
