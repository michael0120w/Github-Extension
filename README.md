# Branch Explorer (btrad)

A combined **Branches + GitHub Actions** sidebar for [Cursor](https://cursor.com) and VS Code-based editors. Self-updates from [GitHub Releases](https://github.com/michael0120w/Github-Extension/releases).

Made by Michael Walding.

## Install

1. Download the latest `branch-explorer-*.vsix` from [Releases](https://github.com/michael0120w/Github-Extension/releases/latest)
2. In Cursor: **Cmd+Shift+P** → **Extensions: Install from VSIX…**
3. Or from terminal:

```bash
cursor --install-extension ~/Downloads/branch-explorer-0.5.13.vsix
```

## Prerequisites

- `git` on PATH
- `gh` CLI for Actions tab and self-updates (`brew install gh`, then `gh auth login`)

## Features

- Local + GitHub branch list with ahead/behind status
- **+ New branch** — create and switch from the panel
- Per-branch push, pull, publish, PR, delete
- GitHub Actions tab with logs, watch, re-run, cancel
- Self-update from this repo's releases

## Publishing a release (maintainers)

```bash
cd ~/Developer/Github-Extension
npx @vscode/vsce package --no-dependencies
gh release create v0.5.13 branch-explorer-0.5.13.vsix --title "v0.5.13" --notes-file CHANGELOG.md
```
