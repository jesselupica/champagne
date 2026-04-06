# Branding Update Plan

Comprehensive plan to update documentation, metadata, and user-facing strings from legacy Sapling/ISL branding to Champagne.

---

## Tier 1: User-Facing Documentation

These are the files users and contributors read first. Highest impact.

### `README.md` (root)

**Current problems:**
- Tagline says "bringing ISL's excellent interface"
- Line 5 references "fork of Interactive Smartlog (ISL) from Sapling SCM"
- "What's Included" bullets say "ISL Web App" and "ISL Server"
- "Original Project" section foregrounds Sapling

**Suggested:**
```markdown
# Champagne

A universal, graphical source control GUI for Git, Sapling, Graphite, and more.

## Quick Start
(keep as-is)

## What's Included
- **Web App**: React-based UI for source control visualization
- **Server**: Node.js backend for repository operations
- **VSCode Extension**: Full IDE integration
- **Shared Libraries**: Reusable components and utilities

## Original Project
This project is based on Interactive Smartlog (ISL) from [Sapling SCM](https://sapling-scm.com/),
refactored to support multiple version control systems through a pluggable driver architecture.
```

---

### `vscode/README.md`

**Current problems:** Entire file is about Sapling SCM — title, description, links, installation instructions all reference Sapling.

**Suggested — full rewrite:**
```markdown
# Champagne SCM

A universal, graphical source control interface for Git, Sapling, Graphite, and more.

This extension provides an interactive commit graph UI directly inside VS Code.

To launch it:
- Run the **Champagne SCM: Open Champagne** command from the command palette.
- Or define a keyboard shortcut for the `sapling.open-isl` command.

## Requirements
- Git (or Sapling) must be installed and available on your PATH.
```

---

### `isl/README.md`

**Current problems:** Title is "Interactive Smartlog", intro describes ISL as "a GUI for Sapling", prose uses "ISL" and "Sapling" throughout ~383 lines.

**Suggested — targeted find-and-replace (not a full rewrite, to preserve the excellent technical content):**

| Line | Current | Suggested |
|------|---------|-----------|
| 1 | `# Interactive Smartlog` | `# Champagne Client` |
| 3 | `Interactive Smartlog (ISL) is an embeddable, web-based GUI for Sapling.` | `Champagne is an embeddable, web-based GUI for version control systems including Git, Sapling, and Graphite.` |
| 4 | `[See user documentation here](https://sapling-scm.com/docs/addons/isl).` | Remove |
| 15 | `VS Code extension for Sapling, including ISL as a webview` | `VS Code extension, including Champagne as a webview` |
| 107 | `ISL is designed to be an opinionated UI...` | `Champagne is designed to be an opinionated UI...` |
| 108 | `...features or arguments that the CLI supports` | `...features or arguments that any single CLI supports` |
| 174 | `a single Sapling repository` | `a single repository` |
| 228 | `The Sapling VS Code extension's ISL webview` | `The VS Code extension's webview` |
| 253 | `ISL started as a way to automatically re-run...` | `Champagne started as a way to automatically re-run...` |
| All other prose | `ISL` (as product name, not folder path) | `Champagne` |

---

### `isl-server/README.md`

**Current:** "server-side code for Interactive Smartlog"

**Suggested:**
```markdown
# isl-server

This is the server-side code for Champagne. It handles
running commands and reporting information to the UI.
```
(Rest of file is fine.)

---

### `components/README.md`

**Line 3:** `used internally by ISL` → `used internally by Champagne`

---

### `vscode/CONTRIBUTING.md`

| Line | Current | Suggested |
|------|---------|-----------|
| 1 | `# Sapling VS Code extension` | `# Champagne VS Code extension` |
| 4 | `the Sapling SCM provider and embedded ISL` | `the SCM provider and embedded Champagne UI` |

---

### `vscode/CHANGELOG.md`

**No changes.** This is a historical record. Past entries correctly describe what happened with "Sapling" at the time they were written.

---

## Tier 2: Package & Extension Metadata

Metadata visible in VS Code's UI, extension marketplace, and settings panels.

### `vscode/package.json`

| Line | Field | Current | Suggested |
|------|-------|---------|-----------|
| 39 | `contributes.configuration.title` | `"Sapling"` | `"Champagne"` |
| 178 | command title | `"Focus Sapling ISL Sidebar"` | `"Focus Champagne Sidebar"` |
| 104 | sidebar icon path | `"resources/Sapling_viewContainer.svg"` | Update after SVG rename (Tier 4) |
| 138 | favicon icon path | `"resources/Sapling_favicon-light-green-transparent.svg"` | Update after SVG rename (Tier 4) |

### `vscode/package.nls.json`

| Line | Key | Current Value | Suggested Value |
|------|-----|---------------|-----------------|
| 15 | `settings.commandPath.description` | `"...running Sapling commands..."` | `"...running VCS commands..."` |
| 16 | `settings.showInlineBlame.description` | `"...in Sapling repos"` | `"...in supported repos"` |

---

## Tier 3: User-Facing UI Strings

Error messages and tooltips shown to users in the web app and VS Code webview.

### `isl/src/App.tsx:182`

```
Current:  "$cwd is not a valid Sapling repository. Clone or init a repository to use ISL."
Suggested: "$cwd is not a valid repository. Clone or init a repository to use Champagne."
```

### `isl/src/App.tsx:255`

```
Current:  "Invalid Sapling command. Is Sapling installed correctly?"
Suggested: "Invalid VCS command. Is your version control system installed correctly?"
```

### `isl/src/CwdSelector.tsx:413`

```
Current:  "Path $path does not appear to be a valid Sapling repository"
Suggested: "Path $path does not appear to be a valid repository"
```

### `isl/src/CommitInfoView/CommitInfoView.tsx:977`

```
Current:  "You can configure Sapling to use either $pr or $ghstack to submit for code review on GitHub."
Suggested: "You can configure either $pr or $ghstack to submit for code review on GitHub."
```

### `isl/src/SettingsTooltip.tsx:431`

```
Current:  "You can configure Sapling and ISL to use a custom external merge tool"
Suggested: "You can configure a custom external merge tool"
```

### `isl/src/debug/DebugToolsMenu.tsx:62`

```
Current:  "debugging Interactive Smartlog"
Suggested: "debugging Champagne"
```

---

## Tier 4: Resource File Renames

SVG icons still carry the Sapling name.

### Files to rename

| Current | Suggested |
|---------|-----------|
| `vscode/resources/Sapling_favicon-light-green-transparent.svg` | `champagne-favicon-light-green-transparent.svg` |
| `vscode/resources/Sapling_favicon-light-green.svg` | `champagne-favicon-light-green.svg` |
| `vscode/resources/Sapling_viewContainer.svg` | `champagne-viewContainer.svg` |

### References to update after rename

| File | Line | What to change |
|------|------|----------------|
| `vscode/package.json` | 104 | Icon path for sidebar view container |
| `vscode/package.json` | 138 | Icon path for command |
| `vscode/extension/islWebviewPanel.ts` | 450 | Favicon reference |

---

## Tier 5: Extension Source Code (defer to dedicated refactor)

These are internal identifiers. Not user-visible except where noted. Recommend batching into a single refactor PR.

### Do now (user-visible)

| File | Line | Current | Suggested |
|------|------|---------|-----------|
| `vscode/extension/VSCodeRepo.ts` | 211 | `t('Sapling')` | `t('Champagne')` — visible in VS Code SCM sidebar |
| `vscode/extension/extension.ts` | 112 | `'Sapling ISL'` | `'Champagne'` — visible in VS Code output channel picker |

### Defer (internal only)

| File | Items |
|------|-------|
| `vscode/extension/SaplingFileDecorationProvider.ts` | Filename and class name |
| `vscode/extension/DiffContentProvider.ts` | `SaplingDiffContentProvider` class, `encodeSaplingDiffUri`/`decodeSaplingDiffUri` functions, `SaplingDiffEncodedUri`/`SaplingURIEncodedData` types |
| `vscode/extension/VSCodeRepo.ts` | `SaplingResourceState`, `SaplingResourceGroup` types, `SaplingRepository` import |
| `vscode/extension/extension.ts` | `registerSaplingDiffContentProvider`, `SaplingISLUriHandler` |

---

## Do Not Update

| Item | Reason |
|------|--------|
| `vscode/CHANGELOG.md` | Historical record — past entries correctly reference Sapling |
| `isl-server/src/vcs/SaplingDriver.ts` | This IS the Sapling backend driver |
| `CommandRunner.Sapling` enum | Correctly identifies Sapling as a command runner |
| `vcsType: 'sapling' \| 'git'` in serverTypes | Functional routing code |
| `'sapling-smartlog-*'` watchman subscription names | Internal identifiers; changing risks breaking existing subscriptions |
| `isl/src/RestackBehavior.tsx:21` comment | Accurately describes that this config is Sapling-specific |
| `isl/src/CommandHistoryAndProgress.tsx:39` comment | Accurately describes Sapling-style arg translation |
| `isl-server/src/CodeReviewProvider.ts:34` comment | Accurate description of Sapling behavior |
| Test files with `CommandRunner.Sapling` | Correctly testing Sapling code paths |
| `vscode/package.json` activation events (`sapling.open-isl`, etc.) | These are extension command IDs — changing is a breaking change for users with custom keybindings; defer to major version bump |
| `vscode/package.nls.json` key names (`sapling.*`) | Internal keys that map to user-visible values; the values are already updated |
| `isl-server/src/analytics/eventNames.ts` | `SaplingISLUriHandlerHandle` — analytics event; changing breaks continuity of tracking data |
