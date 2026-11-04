# Star desktop — TODO

**Status:** in progress. 1.25.4 matched the process card to the Claude Code reference and cleared the right-pane and sidebar defects. 1.25.3 replaced the separate thinking pill and tool group with a single process card per round. 1.25.2 shipped the stream/empty-reply fixes, the wider tool-call parser, the rail and preview fixes, and the visual batch V-01…V-33 below.
**Last updated:** 2026-11-04
**Target releases:** 1.23.5 (sidebar, settings, motion), 1.24.x (question tool, tools, Office, UX), 1.25.x (desktop parity)

**Done in 1.25.4:** process rows on a 13px / 34px rhythm with 11px rings and a hairline card, header dot only while live, chevron on hover; card keeps its height when the transcript overflows (`flex:none`); the pane grip no longer draws a phantom scrollbar under an empty card; empty Preview is one line; pane headers 42px at 13px with the close button on the far right; update log renders bold and inline code; session rows 46px with a small uppercase group label and no stray horizontal gutter.

**Done in 1.25.3:** one process card per round — header counts “2 thoughts, 1 tool call”, rows list each thought (with a one-line gist) and each call (verb + target) in order, click a row to open its reasoning or output in place, click the header to fold the round; ring state per row (pulsing live, red for denied/failed, duration on the right); replay rebuilds the same card from the stored UI log. Replaced `.think` and the `.tools` group; `verify-render` assertions moved to the new shape.

**Done in 1.25.2:** stalled streams fail with a message; reasoning-only replies retry and then say something; tool calls parse from `tool_calls`/`tool_use`/`function_calls` fences, json fences, bare JSON lines and `<tool_call>` tags; empty rail stays closed and the empty preview shrinks; toasts queue above the composer; tool rows tick live with failure state and Open full result; 780 px conversation column; title-bar separators, dimmed history buttons, 14 px window glyphs; session list scrolls; diffs share one scroller; visible scrollbar thumb in both themes. Remaining: sections 3–5, 7, 8 and the unchecked items in 6 and 9.

---

## 0. Ground rules

- Only edit this file until the user says “start working”.
- Keep all existing functionality; no redesign regressions.
- Every new feature needs loading, empty, error and reduced-motion states.
- Every visual change needs a dark + light screenshot and a 1024/1280/1440 px check.
- Use the existing theme tokens; no hardcoded colors.
- Use the 100–400 ms motion contract for UI transitions; loading loops may run longer.

---

## 1. Sidebar navigation

### Goal

Replace the single **More** row in the 300 px sidebar with four English navigation rows from the reference. No fifth row.

| Row | Icon | Action |
|---|---|---|
| **New** | plus | Start a new session |
| **Search** | magnifier | Focus the session search |
| **Projects** | briefcase | Open and focus Project files |
| **Artifacts** | overlapping squares | Open the artifacts section |

### Style

- 36 px rows, 2 px gap, 10 px radius.
- 16 px currentColor outline icons, 1.5 stroke, 8 px gap.
- 13 px / 500 labels; muted by default, strong when active.
- Transparent background, `--hover` overlay, `--surface-2` active fill; no borders, shadows or black boxes.
- 12 px horizontal padding; between New session and Sessions.
- Real buttons with Enter/Space, `:focus-visible`, `aria-label`/`title`, and a visible active state.

### Tasks

- [ ] Remove `#btnMore` and its text-only `openMenu()` handler.
- [ ] Add `.sb-nav` with four `.sb-nav-row` buttons.
- [ ] **New** → `newSession()` (close the mobile sidebar first).
- [ ] **Search** → `focusSessionSearch()`.
- [ ] **Projects** → expand/scroll the project tree; active while the tree is focused.
- [ ] **Artifacts** → open `#actPanel` at its Artifacts section; active while open.
- [ ] Keep the large New session button and mode switch.
- [ ] Preserve every old More action elsewhere:
  - Sort → Sessions header.
  - Reload files → Project files refresh.
  - Toggle panes → title-bar panel toggle.
  - Theme → title-bar theme toggle.
  - Settings/shortcuts/updates/releases → Settings.
  - Empty transcript → session `⋮` menu.
- [ ] Add verify-ui/render assertions (ids, four rows, 36/10 px, currentColor icons, no `#btnMore`).
- [ ] Dark + light screenshots at 1440×900.

### Acceptance

- Sidebar shows exactly **New / Search / Projects / Artifacts** in English.
- Every row works with mouse and keyboard, with one clear active row.
- No functionality from More is lost.

---

## 2. Settings button

The title-bar gear currently opens the last-used Settings section (default **Providers**), not **Appearance**, and its eight-spoke glyph reads like a sun.

- [ ] Change `openSettings(section)` to accept an optional section and set `settingsSection` before rendering.
- [ ] Bind `#btnTitleSettings` to `openSettings("appearance")`.
- [ ] Replace the glyph with the standard cog/sliders icon, 16 px, currentColor, 1.5 stroke.
- [ ] Keep a 32×32 transparent hit target, hover overlay, `aria-haspopup="dialog"`, `aria-label="Settings"`.
- [ ] Verify clickability in packaged Electron (`-webkit-app-region: no-drag`, z-index, drag region).
- [ ] Close menus before opening; focus the close button; Escape/backdrop close; restore focus.
- [ ] Guard duplicate IDs/listeners.
- [ ] Smoke test: click gear → `#settings.on`, section `"appearance"`, Appearance nav active.

---

## 3. Q / question tool (AI asks the user)

Star already has an `ask_user` tool in `desktop/lib/tools.js` (1–4 questions, 2–4 options each) and question cards in the UI. This work makes it a first-class, reliable **question** tool instead of adding a duplicate.

### Tool contract

- [ ] Canonical tool name `question`, with `ask_user` kept as a compatibility alias.
- [ ] Schema:
  - `questions[]`: `id`, `header`, `question`, `options[]` (`label`, `description`, `value`), `multiSelect`, `allowOther`, `required`, `default`.
  - 1–4 questions, 2–4 options each, recommended option first.
- [ ] Freeform “Other…” answer per question; optional skip when not required.
- [ ] Return structured answers (`{ id, values, other }`) to the agent as a tool result.
- [ ] Block the turn while waiting; mark the session “Needs input”; resume exactly where it stopped.
- [ ] Timeout/cancel path (e.g. 10 minutes or user Stop) returns a clear “not answered” result, not a hang.
- [ ] Reject malformed questions with a readable tool error.

### UI

- [ ] Multi-question card with progress (“1 of 3”), Back/Next, Submit.
- [ ] Keyboard: arrow keys, Enter, Escape, focus ring; screen-reader labels.
- [ ] Selected state, recommended badge, option descriptions, multi-select checkboxes.
- [ ] Persist questions and answers in the transcript; replay identically after reload.
- [ ] Show the chosen answers in a compact summary once submitted.
- [ ] Add “question” to the tool icons, activity labels and self-documentation.
- [ ] Tests: schema normalization, answer round-trip, cancel/timeout, replay, malformed input.

---

## 4. Better tools

Make the tool layer feel like a real harness rather than a text protocol.

### Protocol and execution

- [ ] JSON-schema validation for every tool call, with readable errors.
- [ ] Stream tool arguments and show progress before the call completes.
- [ ] Parallel tool calls when independent; preserve result order.
- [ ] Cancellation per tool and per turn; kill child processes cleanly.
- [ ] Timeouts per tool with a Retry action.
- [ ] Idempotency keys and safe retries for writes/commands.
- [ ] Permission previews: show the command, path or network target before approval.
- [ ] Allow once / always allow / deny, remembered per project and tool.
- [ ] Idempotent replay of stored tool calls; no double execution on reconnect.
- [ ] Tool output cap with “Open full result”, copy and save-to-file.
- [ ] Human-readable tool errors with a suggested next step.

### Tool UI

- [ ] Richer result cards: text, code, diff, table, image, chart, terminal, file, document.
- [ ] Live elapsed time, status dot, count pill and grouped rows.
- [ ] Expand a row to see arguments, output, duration and exit code.
- [ ] Inline file links, copy buttons and “open in pane”.
- [ ] Tool search/registry with descriptions, schemas and examples.
- [ ] MCP tools refresh without restart; conflict resolution for duplicate names.
- [ ] Tool audit log per session (who ran what, when, result).
- [ ] Custom tools: JS tool files and MCP, with a test console.
- [ ] Token budget per tool result and automatic summarization of huge outputs.

### Tool ideas to add

- [ ] `question` (see section 3).
- [ ] `todo_write` / plan updates with structured task cards.
- [ ] `office_*` document tools (section 5).
- [ ] `browser_*` preview/inspect/screenshot/click tools.
- [ ] `git_*` status/diff/branch/commit/PR helpers.
- [ ] `test_run` with parsed failures.
- [ ] `search_code` semantic search across the repo.
- [ ] `checkpoint` / `rewind` session snapshots.
- [ ] `delegate` / subagent tools with a live subagent pane.
- [ ] `schedule_task` for recurring work.

---

## 5. Office and document features

**Interpretation:** “Office features” means native Word / Excel / PowerPoint / PDF workflows: create, read, edit, preview and convert documents, plus document skills the AI can call. This is what Claude Cowork and the Claude Office agents provide; Claude Code itself usually reaches Office through scripts/MCP. Microsoft 365 / Google Workspace connectors are a later integration, not the foundation.

### Foundation

- [ ] Shared `office` module used by desktop, CLI and MCP.
- [ ] Support `.docx`, `.xlsx`, `.pptx`, `.pdf`, `.odt`, `.ods`, `.odp`, `.csv`, `.tsv`.
- [ ] Detect file type by content, not only extension.
- [ ] Atomic saves with a `.bak` version and file lock.
- [ ] Disable macros and external relationships by default; strip them on write.
- [ ] Guard zip bombs, huge sheets, embedded objects and path traversal.
- [ ] Preserve styles, numbering, images, tables, comments and formulas where possible.
- [ ] Conversion pipeline (Office → PDF, PDF → images, Office → HTML preview) with a renderer that works offline.
- [ ] Evaluate bundling: pure JS OOXML libraries vs. LibreOffice Kit vs. a small Python sidecar. Record binary size, startup cost and licensing in the TODO before choosing.

### Read and preview

- [ ] Word: paginated preview, headings, tables, images, comments.
- [ ] Excel: sheet tabs, grid, formula bar, frozen panes, charts, named ranges.
- [ ] PowerPoint: slide thumbnails, slide view, speaker notes, images, theme fonts.
- [ ] PDF: page thumbnails, text layer, zoom, search, rotate.
- [ ] In-app search inside a document.
- [ ] Open from chat, project tree, drag-and-drop or `@` mention.
- [ ] “Open in default app” and “Reveal in folder”.

### Create and edit

- [ ] Word: headings, lists, tables, images, page breaks, comments; view tracked changes.
- [ ] Excel: cell editing, formulas, recalculation, number/date formats, fills, charts, CSV import/export.
- [ ] PowerPoint: add slides, layouts, text, images, notes; apply a theme.
- [ ] PDF: merge, split, rotate, reorder, delete pages, fill forms, add text.
- [ ] Create from a prompt or template; save a copy; export PDF.
- [ ] AI document tools:
  - [ ] `office_read` — extract text, sheets, slides, metadata.
  - [ ] `office_write` — create from markdown/JSON.
  - [ ] `office_edit` — targeted edits that preserve formatting.
  - [ ] `office_convert` — format conversion.
  - [ ] `office_render` — page/slide/sheet preview images.
- [ ] Document skills (`docx`, `xlsx`, `pptx`, `pdf`) with validation and sample files.
- [ ] Formula recalculation verified with a reference engine; never trust a cached value.
- [ ] Charts and conditional formatting survive round-trips.
- [ ] Comments/notes round-trip.
- [ ] Large files: lazy pages, virtualized sheet rows, worker-based parsing.
- [ ] Tests: fixture files, round-trip diffs, render snapshots, corrupted files, zip bombs.
- [ ] Artifacts: document artifacts with preview, download and “open in editor”.
- [ ] Attachments: drag/drop Office files into the composer, show type/size, parse before send.
- [ ] Clipboard: paste tables from Excel into the composer as structured data.

### Later integrations

- [ ] Microsoft 365 / OneDrive connector (read/write with OAuth).
- [ ] Google Docs/Sheets/Slides connector.
- [ ] Excel add-in / Word add-in bridge.
- [ ] “Open in Excel/Word/PowerPoint” handoff.
- [ ] Print and page setup.

---

## 6. Motion and loading bugs

### Problem

Loading indicators and small animations do not visibly run; some views sit in an indefinite loading state; the app feels frozen while work is happening.

### Audit

- [ ] Inventory every loading surface: boot, sessions, providers, models, project tree, MCP, skills, plugins, updates, usage, preview, terminal, diff, artifacts, tasks/plan.
- [ ] Record what clears every `loading`/`busy` flag on success **and** failure/timeout.
- [ ] Audit keyframes: `spin`, `pulse`, `blink`, `shimmer`, `msgIn`, `fadeIn`, `runarc`.
- [ ] Check `prefers-reduced-motion`, `animation-play-state`, overridden `animation-name`, Electron `backgroundThrottling`, `visibilitychange`, `syncMotionVisibility()`.

### Fixes

- [ ] Reusable spinner (0.9 s linear ring), skeleton rows and inline “Loading…”.
- [ ] `aria-busy`, `role="status"`, accessible labels.
- [ ] Reduced-motion fallback: static ring + text, never an empty frozen area.
- [ ] `try/finally` on every fetch; failures clear loading and show error + Retry.
- [ ] Timeouts: MCP handshake 45 s, provider/model lists 15 s, document parse 30 s.
- [ ] Restart animations after `display:none → block` using `requestAnimationFrame` or a forced reflow.
- [ ] Remove `animation: none` from non-reduced-motion paths.
- [ ] Compositor-friendly `transform`/`opacity` animations only.
- [ ] Boot skeleton instead of a blank shell.
- [ ] “Working” indicator that survives slow tools and becomes an error after the timeout.
- [ ] Test frames at 0/300/1000 ms show progress.
- [ ] Computed-style test: active spinner has `animation-name: spin`.
- [ ] Slow/failed endpoint tests: loader → error + Retry; no infinite spinner.
- [ ] Reduced-motion test: static indicator + text.

---

## 7. More animations

Add tasteful motion; keep it fast, interruptible and reduced-motion aware.

- [ ] Sidebar nav: active row indicator slides/fades between rows.
- [ ] Session rows: hover lift, press scale 0.99, unread dot fade.
- [ ] New session: button press + composer focus pulse.
- [ ] Sidebar collapse/expand: width spring 180 ms + content fade.
- [ ] Pane open/close: scale/fade from 0.98, 180 ms; no layout jump.
- [ ] Card expand/collapse: height/grid transition 200 ms.
- [ ] Tool group expand: rows stagger 20 ms, 150 ms each.
- [ ] Tool status dot: pulse while running, ease to green/red on settle.
- [ ] Thinking pill: star turns while live, label shimmer, collapse fade.
- [ ] Streaming caret: smooth blink and no jump when the last paragraph changes.
- [ ] Message entrance: 150 ms fade/6 px rise, capped to avoid replay animation storms.
- [ ] Send button: icon lift + accent flash on send; disabled state crossfade.
- [ ] Toast: slide up 180 ms, auto-dismiss progress ring, stack reflow.
- [ ] Settings: backdrop fade + card scale 0.98→1.
- [ ] Command palette: fade + 8 px rise; result rows stagger 15 ms.
- [ ] Theme switch: 120 ms color transition on surfaces, no image flashes.
- [ ] Drag/drop: ghost tilt/scale, drop zone highlight, reorder spring.
- [ ] Skeleton: subtle shimmer (disabled under reduced motion).
- [ ] Scroll-to-bottom: smooth 180 ms except when streaming (instant).
- [ ] Focus ring: 120 ms fade, never removed.
- [ ] Add a motion tokens table (`--motion-fast/base/slow`, easings) and use it.
- [ ] Test: no animation longer than 400 ms except loading loops; 60 fps; no layout shift.

---

## 8. Overall experience

- [ ] First-run onboarding: pick folder, provider/key, theme; skip.
- [ ] Better empty states for sessions, files, artifacts, tasks, plan, changes, search.
- [ ] Error recovery everywhere: human message, Retry, copy details.
- [ ] Undo for destructive actions (delete session/artifact/file, clear transcript).
- [ ] Command palette (`Cmd/Ctrl+K`) for sessions, files, panes and actions.
- [ ] Full shortcut sheet (`Cmd/Ctrl+/`), conflict-free.
- [ ] Toast queue that never covers the composer or window controls.
- [ ] Focus management for every dialog/menu; return focus on close.
- [ ] Persist pane layout, sidebar width, sort, filters and view mode.
- [ ] Session search: fuzzy, highlight, recent, keyboard navigation.
- [ ] Virtualized long transcripts and large diffs.
- [ ] Responsive: sidebar overlay < 900 px, panel sheet < 1000 px, no clipped buttons.
- [ ] Theme polish: light contrast, code/diff colors, scrollbars, images.
- [ ] Accessibility: labels, landmarks, contrast, reduced motion, announcements for stream/tool/question.
- [ ] Performance: faster startup, lazy MCP, cached tool schemas, no re-render storms.
- [ ] Offline/degraded banner with a clear reconnect.
- [ ] Crash/error reporting opt-in; never send code without consent.
- [ ] Notifications/tray for “needs input” and completed sessions.
- [ ] Settings search and reset-to-defaults per section.
- [ ] Multi-window session support.
- [ ] Auto-update with release notes.

---

## 9. Visual bug hunt

Candidate bugs to reproduce and fix. Add a test or screenshot for each.

| ID | Area | Symptom | Suspected cause | Fix / test |
|---|---|---|---|---|
| V-01 | Composer | Toast (“Opened …”) overlaps the permission/model row | Toast anchored inside composer | Move toast stack above composer; no overlap at 1024–1440 |
| V-02 | Sidebar header | Long project name crowds the refresh button | `pf-path` max-width / no flex shrink | Ellipsis + min-width 0; test 60-char path |
| V-03 | Sidebar tree | Deep nesting overflows the 300 px rail | Fixed 20 px indent | Clamp indent, horizontal scroll or ellipsis; test depth 6 |
| V-04 | Title bar | Window-control icons look undersized in 46 px buttons | 12 px icons at 40 px height | Compare at 100/125/150% scaling |
| V-05 | Title bar | Settings glyph reads as a sun | Eight-spoke gear | Replace with cog/sliders (section 2) |
| V-06 | Preview header | Camera icon tooltip says “Blender live view” | Legacy tooltip/icon | Rename to “Screenshot” or use a real camera icon |
| V-07 | Preview | Preview card has empty space below the 280 px body | Panel layout stretch | Align cards to top; verify at 900/1050 px |
| V-08 | Sessions | Active coral bar is inside the rounded row, not at the rail edge | Clipped pseudo-element workaround | Compare reference; decide edge vs inside, test both themes |
| V-09 | Sessions | Long titles push the `⋮` out / truncate late | Flex min-width | `min-width:0` + ellipsis; test 80-char title |
| V-10 | Light theme | Muted text fails contrast on `#faf9f5` | Token pair not checked | Measure ≥4.5:1 for body, ≥3:1 for meta |
| V-11 | Search | Clear button hit area is tiny | 16 px button | 24–28 px target, visible focus |
| V-12 | Composer | Attachment chips wrap over the input/bar | No max-height/scroll | Scroll chips, cap 3 rows, test 10 files |
| V-13 | Toasts | Stack covers the right panel close/add | Fixed top-right | Reposition + cap stack; test 5 toasts |
| V-14 | Code blocks | “Copy” label low contrast at 11 px | `--dim` on `--code-bg` | Use `--muted`; test light/dark |
| V-15 | Thinking pill | Chevron clipped when gist is long | 92% max-width + no min-width:0 | `flex:1;min-width:0` on label |
| V-16 | Diff | Long lines push file header / no horizontal scroll | `white-space:pre` + overflow | Scroll body only; sticky header |
| V-17 | Pane tabs | Long pane titles collide with close/add | No flex truncation | Ellipsis + 8 px gap; test at 320 px panel |
| V-18 | Settings | Card clipped at 800×600 | Fixed max-height/overflow | `max-height:calc(100vh-40px)`, scroll body |
| V-19 | Drag regions | Title bar draggable area has no hover/active affordance | Native drag region | Cursor/default; test double-click maximize |
| V-20 | Reduced motion | Spinners stop entirely and look frozen | `animation:none !important` | Static ring + text fallback |
| V-21 | Skeletons | Content jumps when skeleton is replaced | No reserved height | Match skeleton/content dimensions |
| V-22 | Session list | Double scrollbar / clipped last row | `max-height` + inner scroll | Single scroll container; padding bottom |
| V-23 | Focus | Focus ring invisible on dark active rows | Outline color low contrast | 2 px `--brand` ring + offset |
| V-24 | Panels | Right panel cards misalign after resize | Flex-grown cards | Align-start; no grow; snapshot at 1024/1280/1440 |
| V-25 | Menus | Dropdown clipped at window edge | No viewport clamping | Flip/clamp, max-height scroll |
| V-26 | Images | Artifact images overflow their cards | No `max-width:100%` | Constrain + lightbox |
| V-27 | Terminal | Long lines wrap and break ANSI layout | `white-space` handling | Horizontal scroll; test colored output |
| V-28 | Markdown | Wide tables overflow the column | Table display block | Scroll wrapper + sticky first column? |
| V-29 | Session meta | Relative time string overflows on narrow rail | No ellipsis | Truncate meta |
| V-30 | Settings | Saved pill/green badge low contrast | `--add-fg` small text | Darken/lighten token; measure |
| V-31 | Composer | Send button icon misaligned at 150% zoom | Fixed px | Test 100/125/150% |
| V-32 | Window | Custom window controls overlap native resize border | `titleBarOverlay:false` | Test Windows 10/11 snap layouts |
| V-33 | Scrollbars | Light theme thumb nearly invisible | `--border2` too light | Dedicated scrollbar token |
| V-34 | Tool rows | Long command truncates with no tooltip | `text-overflow` | `title`/expand full args |

**Status (1.25.2):** V-01, V-02, V-03, V-04, V-07, V-11, V-13, V-14, V-15, V-16, V-22, V-33 fixed and checked in a live build. V-09, V-17, V-18, V-19, V-20, V-21, V-23, V-25, V-26, V-27, V-28, V-29, V-30, V-31, V-32 and V-34 still need a pass.
**Status (1.25.4):** V-09, V-17, V-23, V-25 and V-32 improved as part of the pane pass — headers keep the title on its own line with the icons grouped right, the close target sits on the row edge, and the rail no longer draws chrome it cannot fill. V-18, V-19, V-20, V-21, V-26, V-27, V-28, V-29, V-30 and V-31 still need a pass.
**Status (1.25.3):** V-15 and V-34 are structural now: tool rows put the target on one line with a `title` and open their full output on click, so neither truncates silently. The old thinking-pill clipping rules are gone with the pill.

### Visual QA process

- [ ] Playwright/screenshot matrix: 1024×768, 1280×800, 1440×900, 1920×1080; dark + light; 100/125/150%.
- [ ] States: boot, empty, loading, streaming, error, long content, 100 sessions, deep tree, huge diff, long tool output, many attachments.
- [ ] Add pixel-baseline snapshots for sidebar/titlebar/panel/empty states.
- [ ] Check overflow with `document.querySelectorAll('*')` scrollWidth > clientWidth and log offenders.
- [ ] Keyboard-only pass on every dialog/menu.
- [ ] Fix in small batches with before/after screenshots.

---

## 10. Claude Code Desktop V2 feature backlog

### Already present — verify/polish

- [x] Parallel sessions and session sidebar.
- [x] Chat/code modes and unified composer.
- [x] Terminal, diff, preview, plan and tasks panes.
- [x] MCP, skills, plugins, providers and models.
- [x] Streaming text, thinking cards, grouped tools.
- [x] Session search/sort/rename/delete.
- [x] Usage/context ring.
- [x] Themes and shortcuts.

### P0 — next parity batch

- [ ] Session filters: status (running/waiting/completed/failed), project, environment; group by project; auto-archive on PR merge/close; group-level unread badges.
- [ ] Drag-and-drop pane grid; resize; reorder chat/diff/browser/terminal/files/plan/tasks/subagent; persist layout; pop-out panes.
- [ ] In-app file editor: open from chat/tree/diff, edit/save/auto-save, dirty indicator, read-only files, large-file guard.
- [ ] Diff review: per-file stage/revert, inline comments, submit all, “Walk through in diff”, “Fix this one”, code-review card with Apply fixes.
- [ ] Preview: HTML/PDF/video, dev-server manager, browser tabs, cookies/clear data.
- [ ] Side chat (`Cmd/Ctrl+;`) seeded with main context, no backflow.
- [ ] Permission modes: Manual, Accept edits, Plan, Auto, Bypass; per-folder memory; composer indicator.
- [ ] Environment picker (local/SSH/cloud), project folder, model + effort picker.
- [ ] Steering: queue corrections while a tool runs, stop button, prompt suggestions with Tab.
- [ ] View modes: Verbose/Normal/Summary; usage popover.
- [ ] Command palette and full shortcut sheet.
- [ ] Question tool and improved tool harness (sections 3–4).
- [ ] Office foundation (section 5).

### P1 — workflow depth

- [ ] Git worktrees/isolation.
- [ ] SSH sessions with saved connections and port forwarding.
- [ ] Cloud sessions that continue after close.
- [ ] PR monitoring via `gh`: create PR, CI, auto-fix, merge when ready.
- [ ] Background tasks pane with cancel.
- [ ] Subagent pane with task/status/output.
- [ ] Scheduled/recurring tasks.
- [ ] Checkpoints/rewind; fork/duplicate session; export transcript.
- [ ] `@` mentions, drag/drop images/PDFs, paste image.
- [ ] OS notifications + tray.
- [ ] CLI plugins parity and connectors (GitHub/Slack/Linear).
- [ ] Pane tabs for multiple terminals/files/diffs.

### P2 — platform

- [ ] Computer use with per-site approval.
- [ ] Dispatch from phone / remote control.
- [ ] iOS Simulator pane (macOS).
- [ ] Multi-window sessions.
- [ ] Enterprise managed settings and allowlists.
- [ ] Usage/cost dashboard.
- [ ] In-app updates with release notes.
- [ ] Full accessibility and performance programs.
- [ ] Offline/degraded mode.

---

## 11. Release plan

- [ ] **1.23.5** — sidebar nav (4 English rows), settings → Appearance, motion/loading fixes, first visual-bug batch.
- [ ] **1.24.0** — question tool, tool harness, animation pass, Office read/preview/conversion foundation.
- [ ] **1.24.1** — Office editing, spreadsheet engine, document artifacts and tests.
- [ ] **1.25.0** — P0 desktop parity: filters, pane grid, editor, diff comments, preview, side chat, permission modes, pickers, palette.
- [ ] **1.26.0** — P1 workflow features.
- [ ] **1.27.0** — P2 platform features.
- [ ] Each release: changelog, package bumps, `npm run verify`, screenshots, push, release workflow.

---

## 12. Files likely touched

- `desktop/public/index.html` — sidebar, settings, question cards, tool cards, animations, visual fixes
- `desktop/server.js`, `desktop/lib/*` — question tool, tool harness, office module, timeouts, document endpoints
- `desktop/electron/main.cjs`, `preload.cjs` — window controls, notifications, multi-window, background throttling
- `desktop/tools/*` — new tool tests, screenshot/visual tests, office fixtures
- `desktop/CHANGELOG.md`, `desktop/package.json`, `desktop/package-lock.json`, `CLI/package.json`
- `desktop/docs/screenshot.png`
- `TODO.md`

---

## 13. Existing backlog

- [x] Make so AI can interact and see the preview in realtime. — the `preview` tool (1.22.0)
- [x] Make so 3D models can render in the chat — live voxel cards (1.22.0)
- [ ] MCP resources and prompts (tools, remote transports and config import are done)
- [ ] Ship JetBrains Mono with the app so offline installs keep the intended type

---

## 14. References

- [Claude Code desktop redesign — parallel agents](https://claude.com/blog/claude-code-desktop-redesign)
- [Claude Code desktop documentation](https://code.claude.com/docs/en/desktop)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Anthropic Skills — Office documents (docx, xlsx, pptx, pdf)](https://mintlify.wiki/anthropics/skills/installation)
- [Claude for Excel / Office agents](https://claude.com/docs/office-agents/excel)
- [Claude product comparison — Office creation in Cowork](https://github.com/FlorianBruniaux/claude-cowork-guide/blob/main/reference/comparison.md)
