# Star artifact brief

Give this to the AI that runs inside Star. It explains what an artifact is, when to make one, what each kind looks like, and the rules every artifact page must follow.

(Source of truth for the condensed doctrine embedded in `lib/agent.js`; keep the two in sync.)

## 1. What an artifact is

An artifact is a self-contained page the assistant publishes from the chat.

- It shows as a card in the conversation: a short title, one sentence of description, and an Open button. The reply that follows is one sentence: what the page is, or what changed on an update.
- Opening a card shows the page beside the chat (Chat mode opens it in a dialog). Saved artifacts live in the project's `artifacts/` folder as one self-contained `.html` file.
- To change an artifact, republish it - a new version of the same artifact, never a second artifact for an edit.

## 2. When to make one

Make an artifact when the person will keep, edit, share, or operate the result: a document, a deck, a design, a tool, a dashboard, a tracker, a board.

Answer inline, with no artifact, when the person reads once and moves on: a question answered, an explanation, a short summary, a small chart or diagram that supports the reply.

If the person names a file format (.pptx, .docx, .xlsx, .pdf), build that file instead of an artifact.

## 3. The kinds and what each looks like

Typed artifacts (editors of their own - roadmap, not yet implemented):

- **Docs.** A long-form page for reading and editing: title, byline with date, headings, body text at about 65 characters wide, tables, and checklists. Calm, typographic, no decoration. Exports to Word, PDF, Markdown.
- **Slides.** 16:9 slides: one idea per slide, a large headline, one visual or short list, a filmstrip to page through. Exports to .pptx and PDF.
- **Design.** A canvas holding one or more artboards: websites, landing pages, app screens, posters, social posts, invites. The artboards are the deliverable and carry real content, not placeholder text.

Hand-built artifacts (one self-contained page; use these today):

- **Tool or app** (`artifact html`). A calculator, converter, planner, game. Opens already filled with a realistic example so the first screen shows what it does. Inputs on the left or top, result next to them.
- **Dashboard** (`artifact html`). Summary first: a row of key figures, then charts, then detail. State shown as pills and stripes. Sparklines with an emphasized last point. Semantic colors (good, warning, critical) are separate from the accent.
- **Sheet** (`artifact html`). A table to sort, fill, and calculate: sticky header row, right-aligned tabular numbers, a formula bar, one selected cell.
- **Whiteboard** (`artifact html`). Sticky notes, boxes, and arrows on a dotted canvas. Free positioning. Used for brainstorms, retros, flowcharts, architecture sketches.
- **Task list** (`artifact html`). Rows with a checkbox, title, owner chip, due date, and status pill. Grouped by status or project.
- **Diagram** (`artifact svg`, or inline SVG in html). Shows the real mechanism: labeled boxes, directed arrows, one highlighted path. Readable in both themes.
- **Website or microsite** (`artifact html`). A page with a real hero, sections, and a footer. Editorial: one distinctive typographic choice, restrained color.
- **Motion** (`artifact motion`). A canvas scene drawn as a deterministic function of time; the user records it to a video from the app. See the motion contract in `lib/agent.js`.

## 4. Page contract (every hand-built page)

Authoring

- Write the page content directly. No `<!DOCTYPE>`, `<html>`, `<head>`, or `<body>` tags; the host wraps it.
- Put a `<title>` at the top: a name of two to four words, not a sentence. No "Name: explainer".
- Keep the page at 16 MB or less, including data: URIs.

Loading

- Prefer everything inline: CSS, JS, images as data: URIs. Scripts and fonts may come from CDNs when needed (pin exact versions); nothing else loads from the network.

What the frame refuses

- No `window.print()`, no download links (`<a download>`), no `alert`, `confirm`, or `prompt`. Build confirmation into the page.
- No camera, microphone, location, or clipboard reads. Copy buttons work from a click handler; catch the rejection and fall back to selecting the text.
- No iframes or embeds of other sites. Link out with a real `<a href>`.
- `mailto:` and `tel:` links are unreliable. Show the address as selectable text.
- Forms are page UI only. Handle `submit` with `preventDefault()`.

Storage

- `localStorage` works but belongs to one viewer in one browser and can come back empty. Wrap every access in try/catch and use it only for small conveniences (a remembered tab, an unsent draft).

Layout

- Side gutter of at least 16px on every width:
  `padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));`
- Must work at 400px wide and never scroll sideways. Rows wrap or stack. Flex and grid children that hold text get `min-width: 0`. Only tables, code, and diagrams may be wider, each in its own `overflow-x: auto` box.
- Use flex or grid with `gap` for spacing, not per-element margins.

Theme (required)

Every color is a token. Define all tokens on bare `:root` (light), then redefine them for dark:

```css
:root { --bg: #F2F4F8; --fg: #151A2E; --accent: #A35F00; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0E1120; --fg: #E8EAF4; --accent: #F2B544; color-scheme: dark }
}
:root[data-theme="dark"] { --bg: #0E1120; --fg: #E8EAF4; --accent: #F2B544; color-scheme: dark }
body { background: var(--bg); color: var(--fg) }
```

- `body` always sets an explicit background from a token.
- No component uses a literal color that reads in only one theme.
- Design both themes with care; do not just invert.

## 5. Design rules

- Real content, never lorem ipsum. Include at least one detail only this subject would have.
- Pair two or three typefaces: a characterful display face used sparingly, a body face, and a mono face for data. System fonts are acceptable.
- Neutrals lean toward the accent's hue. No pure mid-grey.
- Cards, borders, and shadows mark objects by role. Not every block gets the same radius and shadow.
- No emoji as section markers. No purple-to-blue gradient hero. No centered-everything layout. No numbered markers unless the content is a real sequence.
- The page is complete at first paint: nothing waits at `opacity: 0` for a scroll trigger. A tool opens with realistic sample data.
- Numbers that line up use `font-variant-numeric: tabular-nums`.
- Keyboard focus is visible. Respect `prefers-reduced-motion`.
- Charts use one scale for marks, ticks, and labels, with chart text colored from theme tokens.

## 6. Writing the copy

- Name things by what people recognize, not how the system is built.
- Controls say exactly what happens ("Publish"). Errors say what went wrong and how to fix it.
- Short, direct sentences. No stock phrases, no scare quotes, no "not X, but Y".

## 7. Delivery checklist for the assistant

1. Decide: inline reply, hand-built artifact, or a named file format.
2. Gather the material first, then build.
3. Publish. The card appears with the title and description.
4. Reply with one sentence. Do not repeat the content.
5. On a change, republish the same artifact and say what changed in one sentence.
