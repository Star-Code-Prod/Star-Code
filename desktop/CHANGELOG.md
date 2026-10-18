# What's new in Star

## 1.22.2 — 2026-10-18
- Code answers now land in a proper canvas. Every fenced block renders as a framed card: the language as a title (TypeScript, Python, Shell, HTML...), the line count and a Copy button in its header, a line-number gutter, and the highlighted source on the code canvas - instead of a bare strip of monospace text. A fence with no language reads as Text.
- The model is told to open every code fence with its real language tag - ```ts, ```py, ```bash - never a bare fence, and ```text when the language is unknown. Both the code and chat prompts carry the rule, so the title and highlighting are always right.

## 1.22.1 — 2026-10-18
- Real model names. When a provider's model list carries a display name ("DeepSeek V4.1 Flash 1017" beside the id deepseek-flash), the picker, the composer and the usage pane show that name - with the real id and its context size as the small print underneath. Providers that only publish ids get a readable name instead of a raw slug, and the API always receives the id.
- Real usage, not guesses. Star now asks providers for token usage on every stream (and safely retries without the field for servers that reject it), then shows the provider's own prompt-token count as your context - "estimated" only when a provider reports nothing. The Usage pane also shows tokens in and out this session, and what they cost: list-price estimates per model, or the exact price you set in Settings > Providers > Advanced (input/output per 1M tokens). A total across all sessions sits beside it, and the context ring's tooltip carries the same money. Unknown models show tokens without an invented price.
- self_knowledge is rewritten for the current app (preview tool, inline 3D, persisted cards, steer/queue, tokens and cost, MCP/bridge rules, gzip, one README) and its topic matcher now reads how people actually ask - "how much money have I spent", "3d models", "blender is closed" land on the right section.
- Thinking cards can no longer show tool markup: besides the server-side scrub, the card itself strips it at the moment it settles, so a stored transcript or an unexpected provider dialect still reads as prose.

## 1.22.0 — 2026-10-18
- Star can see and drive the Preview now. A new `preview` tool lets the agent look at what is actually on screen - a voxel build, a motion film, an HTML/SVG page, or the file you are previewing - and get back its live state (build angle, zoom, block count, frame time, page elements), the rendered text, and a coarse picture of the canvas it can reason about: composition, framing, contrast. It can also act in real time: seek a motion, rotate or zoom a 3D build, click/scroll/type a page - then look again. That turns "I think it looks right" into a real adjust-and-verify loop.
- 3D builds render in the chat. A `voxel` artifact card now contains the live model itself - drag to rotate, wheel to zoom, switch versions in place - instead of a card that only opened a pane. Open still sends it to the Preview when you want the room.
- Better understanding: the prompt carries a compact project map (the top two levels, names only) so the model knows where things live before its first read, and the doctrine now asks it to say what it understood the ask to be before acting, follow the project's own conventions, and ask one question instead of guessing when two readings of a request would give materially different work.
- The app ships compressed. The UI and large JSON responses now ride gzip - the page arrives at about a quarter of its former size, so cold start and large file trees load several times faster. (This speeds up transfers, not the model's own thinking time.)

## 1.21.1 — 2026-10-16
- Thinking cards stay prose. When a proxy routes the model's tool calls through the reasoning channel, the raw tool markup (`<|DSML|invoke …>` XML, even split mid-token across stream chunks) used to render inside the thinking card. Star now scrubs reasoning the same way it scrubs the answer: whole call blocks, stray tags and fence-shaped calls are dropped before anything reaches the card - live, and when a session is rebuilt from storage.
- Blender's tools appear only when Blender is actually running. A Blender bridge answers even when Blender itself is closed, which is how Star ended up offering "execute Python in Blender" for jobs it was never meant for - like reading a text file. The app's own socket is probed before every turn: nothing listening means the tools stay out of the model's list (and come back the moment Blender is up). The doctrine now draws the line too - Blender scripting is for 3D scenes only, never for reading files or running shell commands, and a closed Blender is a reason to stop, not to retry.

## 1.21.0 — 2026-10-16
- Cards no longer vanish when you switch sessions or close the app. Question cards come back answered (your picks still marked, footer saying "Answered"), thinking cards come back with their gist and full reasoning behind the toggle, suggestion cards come back with how they were settled, and permission cards come back with their verdict (allowed once / for session / denied). It is all stored in the session, so reopening Star shows the conversation you actually had.
- Tool rows come back too. A reloaded session now replays every tool call that ran - name, arguments, result preview - instead of collapsing the past to prose, and the todo checklist (waiting, working, done) is restored from the last checklist Star wrote.
- The Settings button is gone from the sidebar - it lives in the titlebar only, next to the sidebar and panes toggles.

## 1.20.1 — 2026-10-16
- The Changes card header reads like a file tab now: the file name (scene.js) stands out, the folders before it are trimmed from the front (…\dragon-house) instead of spilling a full C:\Users\... path across the row, and the +adds/−removes counts sit on one clean line that never wraps. A zero side stays hidden, so "+3" no longer comes with a dangling "−0".

## 1.20.0 — 2026-10-16
- Follow-ups have a setting now: **Settings > Session > Steer or queue**. When you send something while Star is still working, Steer folds it into the running turn - Star adjusts course on its next step, and your message shows up in the conversation immediately. Queue holds it and sends it automatically the moment the turn finishes, even if that session moved to the background; queued messages sit above the composer as chips with an × to cancel, and the placeholder tells you which mode you are in.
- The sidebar's "Open folder" button is gone for good - no project picking anywhere on the code page. Where Star works is set the ways you asked for: click the folder chip in the chat header and type a path, or just say where to work and Star binds it. The sidebar is down to New session, Settings and More.

## 1.19.2 — 2026-10-16
- Question cards answer the way you actually click now. With several single-choice questions, a pick on each one sends automatically - no more choosing options and wondering why nothing happens while the footer still said "Click an option." The footer counts live ("1 of 2 picked - click one option per question, the last pick sends"), and pick-more-than-one questions still need their explicit Submit ("2 of 2 set - hit Submit.").
- The work line tells the truth while a card waits on you: "waiting for your answer" (or "waiting for your permission") instead of claiming it is still thinking.
- Option rows stop looking like text inputs: picks get the accent selection ring, and only keyboard focus draws an outline.

## 1.19.1 — 2026-10-16
- Moving through a motion actually works now, both ways. Dragging the scrub used to fight the running playback - the clock kept advancing under your thumb, so going backwards barely landed. Touching the scrub now pauses the playback first, so the picture lands exactly where you drop it and stays there.
- Arrow keys step the motion: left/right move one frame at a time, Shift+arrow moves a full second - the status line says so. Stepping while it plays pauses first, so reviewing a moment is precise.

## 1.19.0 — 2026-10-16
- The sidebar sorts itself now: a session waiting on you - a question card or a permission prompt - climbs into a "Needs input" group at the top with a warning mark and "Waiting for your answer"; live turns sit under "Working"; everything else is "Completed". It moves on its own as you answer, in the foreground or in a background session.
- Star can suggest a new session. When your request clearly starts a different task ("add cart thumbnail dimensions" in a session about grid layout), it offers a small card - a real title, a one-sentence description, "Do it here" or "Start new session" - and Start opens a fresh session that begins with that description.
- The + in the composer is the menu now: side chat (opens a second chat beside this one), attach file, run shell command, export conversation, new session. The old chevron arrow is gone. Attach file opens your file explorer filtered to images and videos (anything else is one click away) and the picked path rides into the message as [attached file: …] - readable text files, directly usable images/videos.

## 1.18.1 — 2026-10-16
- The titlebar is just the three icons you use: toggle sidebar, settings and toggle panes now sit in the strip itself (icons only - settings got its own button up there), the "Star 1.x.y" label is gone, and a small gap keeps air between the titlebar and everything below it.

## 1.18.0 — 2026-10-16
- Motion films have sound now. Scenes can synthesize music and effects (tone, noise, kick/snare/hat, note, chord - with sweeps, ambience beds and total silence as an effect), and Record writes a video file with that audio muxed in. A Sound toggle sits in the player; muting only silences the preview, the recording always keeps its sound. Everything is generated on the page - no files, nothing to download.
- Star learned how the viral Claude civilization films are made, and the motion doctrine now teaches it: beat maps first, one act per era with its own palette, ONE evolving motif across the whole film, designed transitions with a sound hit on each, camera dollies and parallax, lights (glow, shafts, fog, flicker, day/night) and resolve-at-the-end pacing. Narrative films run 30-120 seconds now; loops stay short.
- The motion runtime also gained the tools those films lean on: lerp, clamp, deterministic noise1() and an easing set (outCubic, inOutQuad, outQuart, inOutSine, outBack, outElastic) - all in scope for any scene.

## 1.17.0 — 2026-10-16
- Voxel builds are an artifact format now - the VoxelBench idea, in Star. Ask for a 3D model ("make me a small cabin") and one deterministic script builds it; the Preview renders it in isometric 3D, drag to rotate, wheel to zoom, soft shadow under it. Updates keep the build's name, so a revision lands as v2 of the same model.
- Blender lives in the Preview pane. With a Blender MCP server connected, the new viewport button streams screenshots from it (the caption names the tool); the agent also gets a Blender doctrine - silhouette first, then structure, then materials, checking scene facts as it goes - so models actually get good while you watch live.
- Thinking and summaries got smarter: a folded thinking card keeps its duration plus a one-line gist of what the model was working through; old-turn compaction summaries now keep the point of the turn and the files it touched; and both prompts close real work with a compact recap instead of drifting off.
- The context meter shows the real window: deepseek-v4 models count as their 1M, and Settings > Providers > Advanced gained a Context limit override for anything custom. Clicking the usage ring opens a new Usage pane in the rail - window used/limit, the model, per-session call and tool stats, compaction savings.
- The titlebar is a clean strip again: the sidebar and panes buttons moved under it with breathing room, the search button is gone (Cmd+K still focuses the sidebar search), and fullscreen preview now sits below the titlebar so its header buttons can never land under the window controls.

## 1.16.0 — 2026-10-16
- The leaked DeepSeek tool markup is fixed properly this time. When a local proxy rewrites the <|DSML|> markers with spaces (<| |DSML| |tool_calls>), Star now reads them anyway: the call actually runs (no more silent "command must be a string" failures) and the raw markup never appears in the chat, streaming or settled.
- If the model wraps its whole call in one "args" JSON parameter, Star unwraps it, so the tool receives real arguments instead of a nested blob it ignores.
- Code mode does not make you pick a project anymore. Click the folder chip in the chat header and type the path right there, or just say where to work in a message - Star binds it with the new use_folder tool. The file tree, the terminal and every following turn work in that folder, and the prompt names it, so "work on C:\Users\you\Documents\MyProject" is all it takes. Chat stays conversation-first.
- The right rail can stretch to 60% of the window now - wider than the chat when you need the files to breathe.
- Preview has a fullscreen mode: the expand button in its header, Esc to leave.

## 1.15.0 — 2026-10-16
- Agents can actually use subagents now - everywhere. A persona (or Chat) that narrowed its tools used to lose the task tool entirely: ask your Puck modder in Chat to research the corpus and its own research call was refused with "not available to this agent". Subagent missions and skills can never be stripped again, and the prompt now insists on research-first: dispatch missions for facts that live outside the conversation, demand file/line evidence, and never hand over a scaffold stamped "unverified" when a mission could read the source.
- Missions run in parallel. Ask for several task calls (or reads) in one step and independent allowed calls run together, coming back in order - a two-job corpus hunt is one wait, not two.
- Skills: SKILL.md packs, the opencode shape. Star reads .star-code/skills and ~/.star-code/skills plus extra paths in Settings > Skills, the prompt carries the catalog, and the skill tool loads a pack's instructions and resource files on demand. Subagents can follow them too, and importing an opencode install brings your skills.paths over - a modding toolkit's skills work in Star as-is.
- Plugins: local JS modules that extend Star itself. Drop a file in ~/.star-code/plugins or point at one from Settings > Plugins: it can hook turn and tool events, add tools the agent calls (permission first, never inside subagents), add skill folders, even register agents. A broken plugin reports on its row instead of breaking the boot; opencode SDK plugins cannot run here and the importer says so per entry.

## 1.14.0 — 2026-10-16
- Star can ask you questions you answer with a click. When a choice is really yours - colors, names, which direction - it shows its questions in the chat as cards with 2-4 options each, the recommended one first, and clicking an option IS the answer. Several questions (or pick-more-than-one) collect up and Submit sends them all; Skip declines and Star carries on.
- While a question waits, the turn simply pauses: the work line reads "asking a question" and everything else keeps running - switch chats, start another session, and the card appears in the conversation that asked, never the other one. Chat mode gets questions too.
- Everywhere without a clickable card - the CLI, subagents - the model is told to ask in plain prose instead of stalling, and the manual, README and prompt teach the new ask_user tool (recommended option first).

## 1.13.3 — 2026-10-15
- The AI actually knows how to use MCP tools now. Star used to tell it only their names and descriptions, so it guessed the arguments and calls failed - the prompt now lists each tool's parameters (mcp__server__tool(text:string, mode?:enum) - what it does), teaches the exact call shape, and every live turn carries that list.

## 1.13.2 — 2026-10-15
- The AI can update a single motion now. Scenes name themselves (a `// Title: Ride` line, a `title:` option, or their first on-screen words), so a revision lands as a new version of the SAME motion - one card, a v1/v2 picker, and your comments and pins stay attached - instead of appearing as a second artifact. The pane also switches to the fresh version instantly on quick updates, which it sometimes missed before.

## 1.13.1 — 2026-10-15
- Tweaks finds every on-screen word now. It used to look only for text written directly in fillText, so scenes that keep their labels in a `const` (the normal way) always said "No text drawn". It now follows variables, array items, `.toUpperCase()` styling and template literals back to the exact literal - including labels with brackets like `[BIKE NAME]` - and edits them in place.

## 1.13.0 — 2026-10-15
- Star got much smarter at artifacts. The doctrine now carries per-format playbooks (dashboard tools, SVG illustration, documents, decks, design frames, motion), a craft bar for hierarchy, type, spacing and contrast, a silent pre-emit checklist, real revision rules - feedback changes exactly what it names - and motion staging (a hook, easing, holds) with plain-literal words so the new Tweaks panel can edit them.

## 1.12.2 — 2026-10-15
- Comments can point at the picture now: with the comment box open, click the exact spot (or drag a box around an area) and the note carries those coordinates to Star - "marking the region 4-62% across and 72-96% down" - so it knows precisely what to change. Pins show on the frame while you are at that moment.
- The motion player stops rebuilding itself while unrelated answers stream, so the comment panel, playback state and your picked spot stay put mid-edit.

## 1.12.1 — 2026-10-15
- DeepSeek's native tool markup (`<|DSML|tool_calls>`) no longer leaks into the chat as raw text: Star reads that dialect exactly like its own tool blocks, so those calls actually run, and the markup never shows - not even while it streams.

## 1.12.0 — 2026-10-15
- Motion scenes take comments now: pause where something is off, hit Comment, and the note anchors to that exact moment - a marker on the rail jumps back to it, and notes stay with the artifact. "Send to Star" hands the note to the chat as feedback and the scene comes back updated.
- Tweaks: edit the scene without touching code - its length, the playback speed (0.5x-2x), and every word drawn on screen, rewritten straight into the scene's fillText literals and rendered immediately.

## 1.11.3 — 2026-10-15
- Dragging a rail card (or a session) now moves the whole card with your cursor the entire way - a live preview, not a marker that jumps at the end. The card floats with a shadow while a dashed slot shows where it will land.

## 1.11.2 — 2026-10-15
- An artifact card that follows its own message sits snugly under it now: the copy bar was stranded in a dead pocket (10px above, 13px below) - the card tucks up so the bar reads as its caption.
- The chat/code switch in the sidebar gets more air between its two buttons.

## 1.11.1 — 2026-10-15
- The motion scrub has a real look now: a slim rail with an accent-filled head and a small thumb that grows under the pointer - no more platform-gray slider.
- Dragging it is smooth: the fill and the clock follow your finger exactly, playback keeps running underneath, and letting go hands the bar back to the player.

## 1.11.0 — 2026-10-15
- Close Star mid-reply and the next start simply continues: the in-flight turn is remembered and picks up where it stopped, in whichever chat you open. The sidebar's session menu offers "Continue where it stopped" for any that were cut off.
- Reasoning effort moved into the model dropdown: pick the model and Low/Medium/High in one place. It is a real request parameter now for OpenAI and OpenRouter reasoning models, and a no-op elsewhere.
- The right rail is memory: which panes are open and which one is active survives restarts (order and heights already did).
- The working line tells the truth: a model that does not stream reasoning no longer says "thinking" - it says "writing the reply" (the missing think card is expected on those models).
- The last conversation reopens on start.

## 1.10.0 — 2026-10-15
- Drag sessions in the sidebar to arrange them: the list switches to your order, with one "Sessions" group.
- Drag a session to the side (onto the chat area) to open it as a second chat - two conversations side by side with the right rail between them. Each one streams on its own; close the second with its X.
- The rail's drag-to-reorder works reliably now: it used to go deaf mid-drag (the dragged card moved in the DOM, which drops the browser's pointer capture) - a marker shows where it will land, and the drop lands exactly there.

## 1.9.5 — 2026-10-15
- Artifact cards keep a proper gap from the message above and whatever follows - they used to sit flush against both.
- The chat/code switch in the sidebar separates its two buttons instead of leaving them touching.
- CI: every job now has a timeout, so a hung runner can no longer stall the release queue.

## 1.9.4 — 2026-10-15
- Motion scrubbing is reliable: dragging the bar no longer fights the playback, so moving forward and backward always lands where you drop it.
- "Open in browser" motion files now play by themselves in the browser tab instead of sitting on a still frame.

## 1.9.3 — 2026-10-15
- Every pane in the right rail has its own X, so closing one card is a single click.
- Drag a card's header to reorder the rail - the order sticks between restarts.
- Each card has a bottom grip to resize its height; double-click the grip to reset it.
- The sidebar is resizable by dragging its right edge.

## 1.9.2 — 2026-10-15
- Fixed the floating white bar while an answer streams: a stripped artifact fence no longer leaves a blank paragraph behind, so the typing caret stays on the last line of text where it belongs.

## 1.9.1 — 2026-10-15
- Thinking shows as a card per phase while it happens - the reasoning is visible as it streams, then folds to a "Thought for a moment" pill.
- The transcript reads think, answer, tools, think, answer - one card per phase, never one reused block.

## 1.9.0 — 2026-10-15
- Star is working now shows in the chat itself, with a small word on what it is doing: thinking, reading a file, running a command, writing your slides.
- The sidebar brings back the circles next to session names - and a circle spins while that session is working.
- The right rail keeps more than one pane open: every open pane stacks as its own card, and a single open pane still fills the rail.
- Sessions keep working in the background. Switch to another chat while one is streaming, run several at once, and come back whenever - the running circle shows what is still going, finished sessions show a dot.
- New: the update log. After an update Star shows a "What's new" popup, and Settings > About has the full log any time.

## 1.8.2 — 2026-10-15
- Deleting or pinning a session (or any menu action) kept the keyboard focus, so typing stopped. Focus now hands back to the message box.

## 1.8.1 — 2026-10-15
- The thinking block sits above its message instead of under it.

## 1.8.0 — 2026-10-15
- Tool calls group into one block per run ("Read, Ran · 3") that survives thinking between rounds.
- Artifacts open the moment their fence starts: the pane shows a working state with a cursor roaming the page, then the finished artifact.
- Motion artifacts play on arrival and keep their own frame rate on any display.

## 1.7.0 — 2026-10-15
- MCP support: local Model Context Protocol servers in Settings, their tools join the agent (each call asks permission), `/mcp` in the CLI, and opencode imports bring servers along.

## 1.6.7 — 2026-10-15
- The right rail header is one compact chip: the active pane with a menu, a close button and a +.
