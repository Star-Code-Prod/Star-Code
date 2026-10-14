# PRESERVE-LIST — baseline contract for the index.html restyle

Baseline: `public/index.html` captured **before** the UI overhaul to
`docs/design/before/index.before.html` (152,599 bytes).
SHA256: `1EBE48393A7542093F904C8A0C0C8306116782382E831BA13019850D777A98AA`
Inline script spans lines **919–3135** of the baseline; styles live in `<style>` above it; body markup before the script.
**Hard rule for the restyle: every id, function, endpoint, key and class below must survive with identical behaviour. Behaviour/code changes are out of scope; this is a UI pass.**

---

## 1. Element ids referenced via `$("...")` (80 ids, 188 references), grouped by area

The `$` helper is `const $ = id => document.getElementById(id)` (line 919).

### Top bar / chrome (titlebar, sidebar toggle, search, panes, theme, settings, update banner)

- `brandVer` — 1 ref · <span> static HTML@658
- `btnSidebar` — 1 ref · <button> static HTML@660
- `btnSearch` — 1 ref · <button> static HTML@663
- `btnPanes` — 1 ref · <button> static HTML@667
- `btnTheme` — 4 refs · <button> static HTML@670
- `btnSettings` — 1 ref · <button> static HTML@673
- `updateBar` — 2 refs · <div> static HTML@676
- `updateVer` — 1 ref · <span> static HTML@680
- `updateCur` — 1 ref · <span> static HTML@680
- `updateGet` — 1 ref · <button> static HTML@684
- `updateNow` — 2 refs · <button> static HTML@683
- `updateState` — 1 ref · <span> static HTML@682
- `updateDismiss` — 1 ref · <button> static HTML@685

### Sidebar (session list + project file tree)

- `sidebar` — 3 refs · <aside> static HTML@690
- `sessions` — 1 ref · <div> static HTML@720
- `sTitle` — 6 refs · <span> static HTML@735
- `sProj` — 3 refs · <span> static HTML@736
- `fileTree` — 1 ref · <div> static HTML@726
- `btnNew` — 1 ref · <button> static HTML@698
- `btnOpenFolder` — 1 ref · <button> static HTML@702
- `btnSettings2` — 1 ref · <button> static HTML@706
- `btnMore` — 2 refs · <button> static HTML@710
- `btnSort` — 1 ref · <button> static HTML@716
- `btnTreeRefresh` — 1 ref · <button> static HTML@722

### Landing + chat column (composer, model/mode controls, context ring)

- `stream` — 10 refs · <div> static HTML@754
- `landing` — 2 refs · <div> static HTML@756
- `composer` — 2 refs · <div> static HTML@788
- `bigInput` — 3 refs · <textarea> static HTML@759
- `bigModel` — 2 refs · <button> static HTML@767
- `bigModelName` — 1 ref · <span> static HTML@767
- `bigMode` — 3 refs · <button> static HTML@765
- `bigProjName` — 1 ref · <span> static HTML@763
- `bigSend` — 2 refs · <button> static HTML@768
- `envList` — 2 refs · <div> static HTML@775
- `slashMenu` — 7 refs · <div> static HTML@790
- `kbdHint` — 3 refs · <span> static HTML@793
- `input` — 22 refs · <textarea> static HTML@792
- `cMode` — 3 refs · <button> static HTML@796
- `cModel` — 3 refs · <button> static HTML@810
- `cModelName` — 1 ref · <span> static HTML@811
- `cEffort` — 1 ref · <span> static HTML@813
- `cShell` — 1 ref · <button> static HTML@803
- `cAttach` — 1 ref · <button> static HTML@800
- `cMore` — 2 refs · <button> static HTML@806
- `ringFg` — 1 ref · <circle> static HTML@818
- `ringTip` — 1 ref · <span> static HTML@821

### Right panes (preview / tasks / plan / terminal / diff, header hover buttons)

- `panes` — 4 refs · <div> static HTML@837
- `paneTabs` — 1 ref · <div> static HTML@838
- `previewTitle` — 3 refs · <span> static HTML@842
- `previewEmpty` — 3 refs · <div> static HTML@843
- `filePreview` — 4 refs · <div> static HTML@843
- `tasksEmpty` — 1 ref · <div> static HTML@847
- `tasksList` — 1 ref · <div> static HTML@847
- `planBody` — 4 refs · <div> static HTML@852
- `term` — 4 refs · <div> static HTML@860
- `diffEmpty` — 2 refs · <div> static HTML@865
- `diffList` — 1 ref · <div> static HTML@865
- `hbPanes` — 2 refs · <button> static HTML@748
- `hbTerm` — 1 ref · <button> static HTML@739
- `hbDiff` — 1 ref · <button> static HTML@742
- `hbBrowser` — 1 ref · <button> static HTML@745
- `cPanels` — 2 refs · <button> static HTML@797

### PR status bar

- `prbar` — 3 refs · <div> static HTML@827
- `prClose` — 1 ref · <button> static HTML@832
- `prNum` — 1 ref · <span> static HTML@829
- `prBranch` — 1 ref · <span> static HTML@830
- `prState` — 1 ref · <span> static HTML@831

### Overlays (context menu, toast)

- `ctxMenu` — 2 refs · <div> static HTML@916
- `toast` — 1 ref · <div> static HTML@915

### Settings overlay (shell + controls, mostly rendered from JS templates)

- `settings` — 7 refs · <div> static HTML@873
- `setSaved` — 3 refs · <span> static HTML@880
- `setBack` — 1 ref · <button> static HTML@875
- `setMain` — 1 ref · <div> static HTML@909
- `fProvSearch` — 1 ref · <input> JS-template@2641
- `fBase` — 6 refs · <input> JS-template@2712
- `fKey` — 4 refs · <input> JS-template@2683
- `fKAlias` — 2 refs · <input> JS-template@2834
- `fKContent` — 2 refs · <textarea> JS-template@2835
- `fRoot` — 2 refs · <input> JS-template@2790
- `upCheck` — 1 ref · <button> JS-template@2872

### Also wired via `on(id, ev, fn)` (line 2897, internally `$(id)`) — settings page controls rendered from templates

- `fBack` — via on() · <button> JS-template@2722
- `fSetActive` — via on() · <button> JS-template@2699
- `fRefresh` — via on() · <button> JS-template@2698
- `fConnect` — via on() · <button> JS-template@2700
- `fDisconnect` — via on() · <button> JS-template@2706
- `fSaveBase` — via on() · <button> JS-template@2714
- `fKSave` — via on() · <button> JS-template@2836
- `fThink` — via on() · <span> JS-template@2747
- `fCollapse` — via on() · <span> JS-template@2751
- `fMode` — via on() · <select> JS-template@2767
- `fEffort` — via on() · <select> JS-template@2773
- `fRootApply` — via on() · <button> JS-template@2792
- `fRootPick` — via on() · <button> JS-template@2784
- `fRootReveal` — via on() · <button> JS-template@2785
- `fReset` — via on() · <button> JS-template@2890
- `upOpen` — via on() · <button> JS-template@2873

### Also wired via `querySelector("#id")` scoped to a menu/artifact host

- `mpConnect` — <button> JS-template@1196
- `mpCustom` — <button> JS-template@1197
- `mpSearch` — <input> JS-template@1193
- `paneAdd` — <button> JS-template@1278
- `fpMode` — <button> JS-template@1633
- `apMode` — <button> JS-template@1944
- `apVersion` — <select> JS-template@1945
- `apOpen` — <button> JS-template@1947

### Ids defined in the baseline but never referenced from the script (CSS hooks / labels — DO NOT DELETE)

- `bt` — <lineargradient> static HTML @649
- `bcs` — <lineargradient> static HTML @650
- `bs` — <lineargradient> static HTML @651
- `landingTitle` — <h1> static HTML @757
- `bigProj` — <button> static HTML @761
- `cRing` — <span> static HTML @815
- `paneBody` — <div> static HTML @839
- `ctxHost` — <div> static HTML @914
- `fRootLabel` — <div> static HTML @2782
- `kPreview` — <div> static HTML @2829
- `upStatus` — <div> static HTML @2869

---

## 2. Top-level functions declared in the inline script (109)

Source order, `line name`:

```
944 load  954 save  956 flashSaved  963 prov
967 payloadBaseUrl  974 applyTheme  984 theThemeIsLight  1053 updateChrome
1065 applyMode  1071 closeMenus  1074 openMenu  1108 modeMenu
1121 async refreshPickableModels  1138 chooseModel  1147 moveMp  1155 renderModelPicker
1218 modelPicker  1270 renderPaneTabs  1287 applyActivePane  1293 setActivePane
1301 closePaneTab  1308 showPane  1313 hidePane  1315 paneMenu
1322 wirePanes  1345 pushTerm  1362 loadLocalSessionFlags  1368 saveLocalSessionFlags
1375 async loadSessions  1383 ago  1391 renderSessions  1438 async switchSession
1460 renderTranscript  1485 sessionMenu  1550 async loadTree  1558 treeChildren
1566 renderTree  1593 async previewFile  1609 renderFilePreview  1659 resetPreview
1675 async checkUpdates  1689 applyUpdateInfo  1748 updateStatusText  1762 esc
1775 hl  1791 md  1824 wireCopy  1835 showChat
1840 showLanding  1845 atBottom  1846 scrollDown  1847 node
1853 addUser  1855 startAssistant  1865 stripBlocks  1878 parseArtifacts
1897 syncArtifacts  1918 addArtifactCard  1931 renderArtifact  1988 addDelta
2000 endAssistant  2015 startThinking  2064 addThinking  2076 endThinking
2099 ensureToolGroup  2115 addTool  2131 renderToolGroup  2156 finishTool
2164 diffRows  2176 renderDiff  2190 renderDiffPane  2207 renderTodos
2223 renderPlan  2232 askPermission  2259 renderRing  2269 async send
2279 async handleCommand  2315 say  2317 async sendToAgent  2359 handle
2386 updatePrBar  2395 async newSession  2419 exportConv  2447 buildSlash
2448 showSlash  2459 hideSlash  2460 moveSlash  2465 acceptSlash
2471 autoGrow  2514 abort  2541 openSettings  2542 closeSettings
2551 renderSettings  2583 async refreshMeta  2586 async refreshLocals  2593 async importLocalKeys
2612 provPill  2620 provRow  2629 settingsProviders  2657 modelPreviewHtml
2666 settingsProviderDetail  2726 settingsAppearance  2757 settingsSession  2808 async loadKnowledge
2815 settingsKnowledge  2841 settingsKeys  2852 settingsAbout  2895 wireSettings
3077 toast
```

## 3. Top-level `const` (17) and `let` (37)

```
919 $  920 LS  923 DEFAULT_STATE  996 MODES
1002 EFFORTS  1003 UNITS  1005 ICONS  1015 bridge
1259 PANE_DEFS  1266 paneOpen  1267 paneBadges  1548 PREVIEW_KIND
1766 HL_RE  2012 SPARK_SVG  2013 CHEV_SVG  2427 COMMANDS
2517 SHORTCUTS
```

```
943 state  955 saveTimer  990 meta  991 appVersion
992 sessionId  993 currentMsg  994 slashIdx  1116 liveModels
1117 mpQuery  1118 mpItems  1119 mpSel  1268 activePane
1358 sessionList  1359 pinnedIds  1360 unreadIds  1543 treeEntries
1544 treeCollapsed  1545 currentFile  1546 fileView  1672 updateInfo
1673 checking  1891 artifacts  1892 msgArtifacts  1893 msgCards
1894 artifactView  1895 lastArtRender  2540 settingsSection  2576 providerDetailId
2577 provFilter  2578 connectState  2579 localStatus  2580 localFetchedAt
2581 modelListCache  2802 kFiles  2803 kView  2804 kContentCache
2805 kLoadedAt
```

Note: the script is a **classic script, not a module**. Boot is a top-level
`(async function boot(){…})()` at line 1017; the rest of the wiring runs as
top-level statements at the bottom of the script (≈3077–3135). Keep script
order and non-module status — test scripts call `state`, `applyTheme()`, `save()` globally.

## 4. Server endpoints fetched (21 paths)

| Method | Path | Used by |
|---|---|---|
| GET | `/api/providers` | boot, refreshMeta |
| GET | `/api/detect` | refreshLocals |
| POST | `/api/models` | live model discovery (refreshPickableModels, provider detail) |
| GET | `/api/sessions` | loadSessions |
| GET | `/api/sessions/messages?id=` | switchSession |
| POST | `/api/sessions/new` | newSession |
| POST | `/api/sessions/rename` | auto-title after first answer, session menu |
| POST | `/api/sessions/delete` | session menu |
| POST | `/api/chat` | sendToAgent (NDJSON streaming) |
| POST | `/api/command` | handleCommand fallthrough |
| POST | `/api/abort` | abort() — stop |
| POST | `/api/permission` | askPermission |
| GET | `/api/tree` | loadTree |
| GET | `/api/file?path=` | previewFile |
| POST | `/api/pick-folder` | settings Session, Open folder |
| POST | `/api/setroot` | settings Session |
| POST | `/api/auth` | save key |
| DELETE | `/api/auth?provider=` | remove key |
| GET | `/api/knowledge` | loadKnowledge, /knowledge command |
| GET | `/api/knowledge/file?path=` | knowledge preview |
| POST | `/api/knowledge` | knowledge upload |
| DELETE | `/api/knowledge?path=` | knowledge delete |

## 5. localStorage keys

- `ccd.state.v4` — via `const LS` (line 920); the whole `state` object (theme, root, providers, mode, effort, showThinking, autoCollapseThinking, sortAsc, defaultMode, pinned…). `load()` 944, `save()` 954, reset at 3056.
- `sc.pinned` — pinned session ids (loadLocalSessionFlags 1362 / saveLocalSessionFlags 1368).
- `sc.unread` — unread session ids (same functions).

## 6. window.desktop bridge calls

Gate: `const bridge = window.desktop && window.desktop.isElectron ? window.desktop : null` (1015). Guarded `bridge &&` everywhere; web build must keep working. Methods used: `info()`, `setTheme(theme)`, `checkUpdates()`, `updateRun({asset,latestYmlUrl})`, `openExternal(url)`, `openHtml(name,html)`, `pickFolder()`, `setRoot(root)`, `reveal(path)`. Body classes `is-electron` / `is-mac` are set from `bridge.info()` (1020–1023) — CSS relies on them.

## 7. `document.createElement` tags (5)

`a`, `button`, `div`, `iframe`, `img` — created dynamically then styled inline/with class assignment; keep the surrounding class names.

## 8. Classes referenced from script

**querySelector/querySelectorAll classes (22):** `apbody` (3×), `cp`, `diffcard`, `envrow` (2×), `menu`, `mi` (3×), `more`, `mp`, `msg-a`, `msg-u`, `pa`, `pane-row` (2×), `perm`, `sess`, `set-nav` (6×), `si` (2×), `tasklist`, `think`, `think-h`, `tools`, `tools-h` (2×), `trow`

**class names assigned via className/classList (18):** `active`, `apframe` (2×), `apimg`, `ft-item`, `hide` (3×), `is-electron`, `is-mac`, `menu` (2×), `mi`, `mp`, `ok` (2×), `on` (13×), `open` (2×), `pill` (3×), `sel`, `show`, `tools-h`, `warn`

State classes toggled from JS and relied on by CSS: `on`, `open`, `sel`, `active`, `hide`, `show`, `ok`, `warn`, `pill`, plus layout classes `is-electron`, `is-mac`.

---

## Counts / checksum

CHECKS: ids=80 unique referenced via $() (+16 via on(), +8 via querySelector #) · refs=188 · functions=109 · const=17 · let=37 · endpoints=21 · localStorage keys=3 · bridge methods=9 · createElement tags=5 · querySelector classes=22 · className classes=18 · baseline sha256=1EBE48393A75…

Generated by the baseline-inventory agent. If any count above shrinks after the restyle, something was dropped.
