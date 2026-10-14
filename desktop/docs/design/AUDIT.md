# AUDIT — index.html UI gaps vs the overhaul target

Scope: baseline captured at `docs/design/before/index.before.html`
(SHA256 `1EBE4839…`, 152,599 bytes) + before-shots in `docs/design/before/`
(landing-dark, landing-light, settings-providers, picker). Line numbers refer
to the baseline. This is a gap list, not a redesign spec.

## Top gaps

1. **Search is a toast stub, not a feature.** `btnSearch` click (line 1337) just re-shows the sidebar and toasts “Type in the session list to filter” — there is no filter input, no keystroke handler, no message-content search. Target: working search (titles + message text) opened by click and ⌘K, filtering `renderSessions` (1391).

2. **Session list is flat.** `renderSessions` (1391–1436) sorts pinned-first then by `updated`; rows are title + “ago · N turns”. No date grouping (Today / Yesterday / Previous 7 days), no cwd grouping, no collapsible groups. Sidebar screenshot shows one lone session under a header with the rest empty.

3. **Streaming caret is dead code.** `.think-x .cur` + `@keyframes blink` exist (294–298) but nothing ever inserts `class="cur"` (zero DOM usages). Worse, `addDelta` (1988–1998) rebuilds `currentMsg.innerHTML` wholesale per chunk and calls `scrollDown()` every delta — no caret on the live answer, no stable append node, janky reflow.

4. **No hover actions on messages.** `wireCopy` (1824) only decorates code blocks (`.cp` 224). Assistant/user bubbles (`.msg-a` 202/209) have no hover toolbar: no copy message, retry, edit-and-resend, or branch.

5. **No line-length cap on assistant prose.** `.msg-a{font-size:14px;line-height:1.62}` (209) has no `max-width`/`ch` limit; with panes collapsed at 1600px, paragraphs run ~100+ chars per line. The landing card is ~660px — chat text should get a similar measure.

6. **Composer is in-flow and duplicated.** `.composer{flex:none;padding:0 20px 14px;position:relative}` (414) — a bottom strip, not a floating/elevated element. Landing composer (`bigInput` 759) and chat composer (`input` 792) are separate implementations with separate control sets (`bigModel/bigMode` vs `cModel/cMode/cShell/cAttach/cMore`), so any polish must land twice or be unified.

7. **No send→stop morph and no running indicator.** `bigSend` (2500) sends only; `send()` bails while `streaming` (2271). Stop exists only as `abort()` (2514) bound to Esc (SHORTCUTS 2517). Nothing in the composer shows “running”: no stop button, no elapsed/phase indicator (only the context ring, 818–821).

8. **No jump-to-latest.** Only `scrollDown(force)`/`atBottom()` (1845–1846). Scroll up during streaming and there is no pill/button to return, and no unread signal when new chunks arrive.

9. **Thinking/tool/permission blocks need compacting.** Collapse mechanism exists (`grid-template-rows 0fr→1fr`, 283–284 / 325–326) and `.think-h` has `role="button" tabindex="0"` (2019) — but `.tools-h` (312–316) has no role/tabindex/aria-expanded, and `.perm` (395) is a plain non-collapsible inline card with no keyboard-answer path. Think bodies can claim `min(360px,46vh)` (290) — too tall for a compact rhythm.

10. **No landing starter chips.** `#landing` (756) is title + textarea + env rows + two mode cards. No example-prompt chips, no “resume recent session” chips, no keyboard-navigable suggestions.

11. **Settings density is low.** `settingsProviders` row list (2629; settings-providers.png): ~44–52px rows, lots of trailing whitespace, single column `.set-main .sect{max-width:640px}` (571). Twelve providers already scroll at 1000px height; knowledge/files pages repeat the pattern.

12. **Zero `prefers-reduced-motion` support.** No match anywhere in the file. The `blink` caret (298) and `.think-b`/`.tools-b` 280–340ms transitions (283, 326) run unconditionally, as do menu/toast transitions (630).

13. **Focus rings and ARIA are minimal.** Only `:focus` rules are `.inp` (585) and `.cbox:focus-within` (420); no `:focus-visible` ring for buttons, session rows, pane tabs, menus. ARIA: one `aria-hidden` SVG (647) and `role="button"` on the think header (2019). Icon-only buttons rely on `title` only; `openMenu` popups (1074) are div piles with no `role="menu"`/arrow-key model; toast (915) is not a live region.

14. **Responsive stops at 820px.** Three breakpoints only: 1240 / 1000 (panes hidden) / 820 (sidebar hidden) (636–638). Under 800px there is no drawer or stacked layout, no fluid composer, titlebar doesn’t collapse, settings overlay is unspecified. `btnSidebar` fights the media query by toggling inline `style.display` (1336).

15. **Hierarchy is flat.** Landing (screenshots): page title, composer card, “WHERE SHOULD STAR RUN?” cards and mode cards all carry similar weight; the primary action is a 28px square icon. Chat: the session title bar and pane tab row stack as two competing headers, while the sidebar gives “Sessions” and “Project files” equal billing. 12.5px mono everywhere (551+) flattens type hierarchy further.

## Notes for the restyle

- Two composer surfaces exist; treat landing and chat composer as one system.
- Keep every id/class/behaviour in `PRESERVE-LIST.md` — this pass is visual only.
- Re-shoot after: `node tools/uishot.mjs http://127.0.0.1:4180/ docs/design/shot.png --size 1600x1000 --wait 3000 [--eval ...]` (server: `node server.js`, port 4180).
