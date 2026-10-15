# What's new in Star

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
