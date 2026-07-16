# Branch Explorer (btrad)

A combined **Branches + GitHub Actions** sidebar for [Cursor](https://cursor.com)
and any VS Code-based editor. Styled to match the BT AI Hub palette. 100%
local — no telemetry, no marketplace, no auth tokens of its own (uses your
existing `git` and `gh` CLI installs). Self-updates from this repo via
GitHub Releases.

Made by Michael Walding for the FST Cursor group.

![Activity bar icon location](https://img.shields.io/badge/sidebar-Branches-c45f20)
![Self-update](https://img.shields.io/badge/auto--update-via%20gh%20api-c45f20)
![No marketplace](https://img.shields.io/badge/marketplace-not%20required-c45f20)

---

## Table of contents

1. [What you get](#what-you-get)
2. [Prerequisites](#prerequisites)
3. [Setup — Cursor (the recommended path)](#setup--cursor-the-recommended-path)
4. [Setup — VS Code](#setup--vs-code)
5. [First-time verification](#first-time-verification)
6. [Self-update — how it works](#self-update--how-it-works)
7. [Download tracking](#download-tracking)
8. [Configuration](#configuration)
9. [Troubleshooting](#troubleshooting)
10. [Updating (for maintainers)](#updating-for-maintainers)
11. [Local development](#local-development)

---

## What you get

A single sidebar view under the **Branches** activity-bar icon, with a
tabs bar at the top to switch between two views:

### 🌿 Branches tab

- Local branch list with the **current branch highlighted** in btrad orange
  and a `YOU ARE HERE` pill.
- Mirror status per branch: `↑N` ahead of GitHub, `↓N` behind, `local only`,
  `GitHub gone`.
- **Uncommitted-changes badge + one-button commit** on the current branch.
  Whenever your working tree is dirty, the current-branch row shows an amber
  `N uncommitted` pill (tooltip breaks down staged / modified / untracked /
  conflicts and previews the first 12 paths) and a `✎ Commit (N)` button
  that runs `git add -A && git commit -m <your message>` after prompting
  for a message. Pre-commit hook failures (gitleaks, lint-staged, prettier)
  surface in a notification with a `Show in terminal` action so you can
  iterate on hook output live. Disabled for unresolved merge conflicts —
  use the Source Control panel for those.
- **Click any row to checkout** that branch.
- Per-branch hover actions: `↑ Push`, `↓ Pull`, `↑ Publish` (for local-only),
  `✎ Commit` (current branch with uncommitted changes),
  `Open PR →` (compare page targeting your repo's default branch),
  `delete`.
- **`Open PR →`** is one-click — if you have unpushed commits it offers to
  push them first so they're included in the PR.
- **Default-branch protection** — `main` (or whatever `origin/HEAD` points
  at, plus `master` / `develop`) can never be deleted from the UI. Bulk
  prune skips them too.
- **Remote-only section** lists branches on GitHub you haven't checked out
  yet, with one-click `↓ Checkout` and `Open PR →`.
- **Multi-repo workspace support** — if your workspace has multiple git
  folders, the repo badge shows a `▼ N` caret. Click it to pick which repo
  the panel shows.

### ⚙️ GitHub Actions tab

- The last 30 workflow runs across the repo, grouped by commit so a single
  push that fires 3 workflows reads as one logical unit.
- Live status badges with a pulsing dot for in-progress / queued runs.
- Per-run actions: `Logs` (streams in a terminal via `gh run view --log`),
  `Watch`, `Re-run` (failed jobs only or all), `Cancel`.
- A small pulsing count on the **Actions** tab label tells you when CI is
  running, even while you're looking at the Branches tab.

---

## Prerequisites

### 1. `git` — required

You almost certainly already have it. If `git --version` works in a
terminal, you're set.

### 2. `gh` CLI — required for Actions tab and self-update

The GitHub CLI handles all GitHub network access (workflow runs, release
checks, PR creation pages). It's free and well-supported.

| Platform | Install command |
|---|---|
| **macOS** (Homebrew) | `brew install gh` |
| **macOS** (download) | https://cli.github.com/ |
| **Windows** (winget) | `winget install --id GitHub.cli` |
| **Windows** (Scoop) | `scoop install gh` |
| **Linux** (apt) | https://github.com/cli/cli/blob/trunk/docs/install_linux.md |

After installing, log in to your **PwC GitHub Enterprise** account:

```bash
gh auth login
```

When prompted:
- **What account do you want to log into?** → `GitHub.com`
- **What is your preferred protocol for Git operations?** → `HTTPS`
- **Authenticate Git with your GitHub credentials?** → `Y`
- **How would you like to authenticate GitHub CLI?** → `Login with a web browser`
- A browser tab opens — sign in with your PwC SSO.

Verify it worked:

```bash
gh auth status
```

You should see `✓ Logged in to github.com account <your-handle>`.

---

## Setup — Cursor (the recommended path)

### Step 1 — Download the latest release

Go to the [releases page](https://github.com/michael0120w/Github-Extension/releases/latest)
and download the `branch-explorer-X.Y.Z.vsix` asset from the most recent
release.

Or grab it from the terminal:

```bash
gh release download --repo michael0120w/Github-Extension \
  --pattern '*.vsix' --dir ~/Downloads
```

### Step 2 — Install the VSIX

**Option A: from the command line** (fastest)

| Platform | Command |
|---|---|
| **macOS** | `/Applications/Cursor.app/Contents/Resources/app/bin/cursor --install-extension ~/Downloads/branch-explorer-*.vsix` |
| **Windows** | `cursor --install-extension %USERPROFILE%\Downloads\branch-explorer-*.vsix` |
| **Linux** | `cursor --install-extension ~/Downloads/branch-explorer-*.vsix` |

> **macOS tip:** if you've enabled "Install 'cursor' command in PATH" from
> Cursor's command palette, you can just use `cursor --install-extension …`
> like the other platforms.

**Option B: from the Cursor UI**

1. Open Cursor.
2. `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows / Linux) → type
   `Extensions: Install from VSIX…`
3. Pick the downloaded `branch-explorer-X.Y.Z.vsix` file.
4. Click **Reload** when prompted.

### Step 3 — Open the panel

Look at the left **activity bar** (the vertical strip of icons on the far
left of the window). You should see a new **branch icon** ⎇ underneath
the source-control icon. Click it to reveal the **Branches & Actions**
panel.

If you don't see it:
- Right-click the activity bar → make sure **Branches** is checked.
- `Cmd+Shift+P` → `View: Show Branches` (the view container).

---

## Setup — VS Code

The extension is API-compatible with VS Code 1.80+. The install steps are
identical to Cursor — just substitute `code` for the CLI command and use
VS Code's command palette.

### Step 1 — Download the VSIX

Same as Cursor — grab the latest from
[releases](https://github.com/michael0120w/Github-Extension/releases/latest).

### Step 2 — Install

**Option A: from the command line**

```bash
code --install-extension ~/Downloads/branch-explorer-X.Y.Z.vsix
```

**Option B: from the VS Code UI**

1. Open VS Code.
2. Open the Extensions sidebar (`Cmd+Shift+X` / `Ctrl+Shift+X`).
3. Click the `…` menu at the top of the Extensions panel → **Install from VSIX…**.
4. Pick the file. Click **Reload** when prompted.

### Step 3 — Open the panel

Click the new branch icon ⎇ in the activity bar on the left.

> **Note about self-update in VS Code:** the install step falls back to the
> `code` CLI if the built-in `workbench.extensions.installExtension` command
> isn't available, so updates work identically. Both editors share the same
> `gh` auth via the system-level `gh` install.

---

## First-time verification

After installing, run through this checklist to confirm everything's wired up:

| Check | Where | What "good" looks like |
|---|---|---|
| **Extension is loaded** | Activity bar | A new branch icon ⎇ appears |
| **Branches tab works** | Branches & Actions panel → Branches | Your local branches listed; current branch highlighted in orange |
| **Repo is detected** | Top of the panel | Shows `owner/repo` as a clickable link |
| **`gh` is wired up** | Switch to the **Actions** tab | Workflow runs appear (or "No recent workflow runs.") |
| **Self-update is working** | Footer | Shows `v0.5.0 · up to date` (or similar) |
| **Update check responds** | Click the version pill in the footer | Briefly shows `v0.5.0 · checking…`, then `· up to date` |

If any of those fail, jump to [Troubleshooting](#troubleshooting).

---

## Self-update — how it works

The footer at the bottom of the panel polls
[this repo's Releases](https://github.com/michael0120w/Github-Extension/releases)
once an hour:

> btrad · Branch Explorer · made by Michael Walding · **v0.5.0 · up to date** · [repo](https://github.com/michael0120w/Github-Extension)

When a newer release is published, the footer changes to show a pulsing
orange **Update** button:

> … · `v0.5.0` → **`Update to v0.5.1 →`** · …

Click it. The extension:
1. Downloads the release's `.vsix` asset (via `gh api`, so it inherits
   your PwC SSO automatically — no extra auth).
2. Installs it through Cursor / VS Code's built-in command.
3. Prompts you to reload the window.

A one-time toast also pops the first time a new release is detected, so
you don't have to be staring at the panel to notice.

You can also force an immediate check via the command palette
(`Cmd+Shift+P` → `Branch Explorer: Check for updates`) or by clicking the
version pill itself.

**Triggers:**
- 5 seconds after Cursor / VS Code starts.
- Every hour while running.
- Whenever you click the version pill in the footer.
- Whenever you run the `Branch Explorer: Check for updates` command.

A 5-minute floor between calls prevents redundant checks regardless of
trigger source.

---

## Download tracking

Every install — manual or self-update — is tracked by GitHub's release
asset `download_count`. (The self-update path uses
`gh api -H 'Accept: application/octet-stream' /repos/.../releases/assets/{id}`
which GitHub officially counts toward the download counter, the same as
the public `browser_download_url`.)

There are three ways to look at the numbers:

### 1. In the extension itself

Command palette → **`Branch Explorer: Show download stats`**.

Opens an output channel with:

```
Branch Explorer · download stats
  repo:     michael0120w/Github-Extension
  total:    42 downloads
  releases: 3
  latest:   v0.5.1

  RELEASE      PUBLISHED    DOWNLOADS
  -------      ---------    ---------
  v0.5.1       2026-05-19   12
  v0.5.0       2026-05-18   28
  v0.4.0       2026-05-15   2
```

…plus a toast with **`View DOWNLOADS.md`** and **`Open Releases`** buttons
for one-click drill-in.

### 2. From the CLI

```bash
cd ~/dev/cursor-extensions/branch-explorer

./scripts/downloads.sh             # pretty terminal output
./scripts/downloads.sh --markdown  # markdown table
./scripts/downloads.sh --json      # JSON (pipe to jq, etc.)
```

The script uses the same `gh api` call as the extension and produces
identical numbers.

### 3. As a file in the repo

[`DOWNLOADS.md`](https://github.com/michael0120w/Github-Extension/blob/HEAD/DOWNLOADS.md) at the root of this repo is
auto-regenerated by
[`.github/workflows/downloads.yml`](https://github.com/michael0120w/Github-Extension/blob/HEAD/.github/workflows/downloads.yml):

- every 6 hours (cron)
- on every release publish / edit / delete
- on demand via `gh workflow run downloads.yml`

So if you want a permalink someone can refresh in a browser, send them
the [`DOWNLOADS.md`](https://github.com/michael0120w/Github-Extension/blob/main/DOWNLOADS.md) link.

> **Note about download counts and self-update:** A "download" is one
> install event. A single user who has the extension and gets 5 updates
> over time counts as 6 downloads (the first install + 5 self-updates).
> To estimate unique installs, divide total downloads by the number of
> releases-they-could-have-seen-the-update-prompt-for, or just look at
> the latest release's download count which closely approximates "users
> with this version installed right now."

---

## Configuration

Open `Settings → Extensions → Branch Explorer` (or `settings.json` directly):

```jsonc
{
  // Path to the gh CLI (default: assumes gh is on PATH).
  // Set this if you have gh installed somewhere non-standard.
  "branchExplorer.ghBinary": "gh"
}
```

---

## Troubleshooting

### "I don't see the branch icon in the activity bar"

- Right-click the activity bar → make sure **Branches** is checked.
- Open the command palette and run `View: Show Branches`.
- If the extension didn't install, run
  `Extensions: Show Installed Extensions` and look for "Branch Explorer (btrad)".

### "Actions tab shows 'GitHub CLI not found'"

Install `gh` per [Prerequisites](#prerequisites). Then click **Refresh** in
the panel, or open the command palette → `Branch Explorer: Refresh GitHub
Actions`.

### "Actions tab shows 'GitHub CLI not authenticated'"

Run `gh auth login` in a terminal (see [Prerequisites](#prerequisites) for
the prompts). Then refresh the panel.

### "Self-update says 'check failed' in the footer"

Hover the pill to see the error tooltip. Common causes:
- **`gh` not installed** — install it.
- **`gh` not authenticated** — run `gh auth login`.
- **Repo permission denied** — make sure your GitHub account has read
  access to `michael0120w/Github-Extension`.

You can also test directly in a terminal:

```bash
gh api repos/michael0120w/Github-Extension/releases/latest \
  --jq '{tag: .tag_name, assets: [.assets[].name]}'
```

If that command works, the extension's update check will work too.

### "Update install failed"

Hover the error toast to see the actual message. Usually one of:
- **Asset download failed** — re-run `gh auth login` and try again.
- **`workbench.extensions.installExtension` failed** — make sure you're on
  a recent Cursor / VS Code build (1.80+). The CLI fallback will be
  attempted automatically.

You can always install the latest manually:

```bash
gh release download --repo michael0120w/Github-Extension \
  --pattern '*.vsix' --dir ~/Downloads
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension ~/Downloads/branch-explorer-*.vsix --force
```

### "I'm in a multi-folder workspace and the wrong repo is showing"

Click the repo badge at the top of the panel — it'll have a `▼ N` caret
when there's more than one git repo in your workspace. Pick the one you
want to view. The selection survives until you close Cursor.

---

## Updating (for maintainers)

When you've made changes and want to push a new version to everyone:

```bash
cd ~/dev/cursor-extensions/branch-explorer

# 1. Add an entry to CHANGELOG.md under "## [0.5.1] - <date>"

# 2. Run the release script
./scripts/release.sh 0.5.1
```

The script will:
1. Bump `package.json` `version` to the value you passed.
2. Package the `.vsix`.
3. Commit + tag `v0.5.1`.
4. Push to `origin/main` plus the tag.
5. Create a GitHub Release for the tag with the `.vsix` attached and
   release notes pulled from `CHANGELOG.md` (or use `--notes "..."` to
   override).

Within ~1 hour every installed copy of the extension will see the orange
**Update** button in their footer. Or they can click the version pill to
get it instantly.

---

## Local development

```bash
cd ~/dev/cursor-extensions/branch-explorer
$EDITOR extension.js

# Build + install a local test build (without bumping the version or
# creating a release):
npx -y @vscode/vsce package --allow-missing-repository --no-yarn
/Applications/Cursor.app/Contents/Resources/app/bin/cursor \
  --install-extension branch-explorer-*.vsix --force

# Reload Cursor: Cmd+Shift+P → "Developer: Reload Window"
```

The whole extension is a single `extension.js` file (~4500 LOC). Webview
HTML / CSS / JS is all in-file too — no build step, no `npm install`,
no node_modules.

### Before you edit the webview `<script>` block

The inline webview script body lives inside an outer JS template literal
inside `baseHtml()`. This means **backslash escapes get processed by the
outer template literal before the browser sees them**. Writing `'\n'` in
the source produces an unterminated string literal in the rendered HTML
and silently breaks every button in the panel (this has bitten us once,
v0.5.19 → v0.5.25 — see CHANGELOG for the gory details).

**Rule**: inside the `<script nonce="...">` block, double-escape every
backslash. Write `'\\n'` to get `'\n'` in the browser, `'\\\\'` for a
literal backslash, etc.

Verify the rendered output parses before shipping — see
[`docs/WEBVIEW-GOTCHAS.md`](https://github.com/michael0120w/Github-Extension/blob/HEAD/docs/WEBVIEW-GOTCHAS.md) for the full
explanation, the verification script, and other webview footguns.

---

## License

Internal PwC tool — for use within the FST Cursor group.
