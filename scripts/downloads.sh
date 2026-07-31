#!/usr/bin/env bash
# Fetch .vsix download_count from GitHub Releases and print stats.
# Same numbers as the extension's "Show download stats" command and DOWNLOADS.md.
#
# Usage:
#   ./scripts/downloads.sh             # pretty terminal output
#   ./scripts/downloads.sh --markdown  # markdown table (for DOWNLOADS.md)
#   ./scripts/downloads.sh --json      # JSON (pipe to jq, etc.)

set -euo pipefail

REPO="${DOWNLOADS_REPO:-michael0120w/Github-Extension}"
MODE="pretty"

case "${1:-}" in
  --markdown|-m) MODE="markdown" ;;
  --json|-j)     MODE="json" ;;
  --help|-h)
    cat <<'EOF'
Usage: downloads.sh [--markdown|--json]

  (default)     Pretty terminal table
  --markdown    Markdown suitable for DOWNLOADS.md
  --json        Machine-readable JSON
EOF
    exit 0
    ;;
  "") ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Usage: downloads.sh [--markdown|--json]" >&2
    exit 2
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI is required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

# --paginate may concatenate multiple JSON arrays; join them into one.
raw="$(
  gh api --paginate \
    -H 'Accept: application/vnd.github+json' \
    "repos/${REPO}/releases"
)"
raw="$(printf '%s' "$raw" | tr -d '\n' | sed 's/]\[/,/g')"
if [[ -z "$raw" ]]; then
  raw='[]'
fi

rows="$(
  printf '%s' "$raw" | jq -c --arg repo "$REPO" '
    [ .[]
      | {
          tag: (.tag_name // ""),
          published: (if .published_at then (.published_at | split("T")[0]) else "" end),
          published_at: (.published_at // ""),
          downloads: (
            [ (.assets // [])[]
              | select(.name | endswith(".vsix"))
              | (.download_count // 0)
            ] | add // 0
          )
        }
    ]
    | {
        repo: $repo,
        total: (map(.downloads) | add // 0),
        releases: length,
        latest: (.[0].tag // "—"),
        rows: .
      }
  '
)"

total="$(printf '%s' "$rows" | jq -r '.total')"
releases="$(printf '%s' "$rows" | jq -r '.releases')"
latest="$(printf '%s' "$rows" | jq -r '.latest')"
now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

case "$MODE" in
  json)
    printf '%s\n' "$rows" | jq --arg updated "$now" '. + {updated: $updated}'
    ;;
  markdown)
    cat <<EOF
# Branch Explorer download stats

_Auto-generated from \`gh api repos/${REPO}/releases\` — counts every \`.vsix\` asset download (manual or self-update)._

**Total downloads:** \`${total}\` across ${releases} release(s) · **Latest:** \`${latest}\`

| Release | Published | Downloads |
|---|---|---|
EOF
    printf '%s' "$rows" | jq -r '.rows[] | "| `\(.tag)` | \(.published) | `\(.downloads)` |"'
    cat <<EOF

_Last updated: ${now}_
EOF
    ;;
  pretty)
    echo "Branch Explorer · download stats"
    echo "  repo:     ${REPO}"
    echo "  total:    ${total} downloads"
    echo "  releases: ${releases}"
    echo "  latest:   ${latest}"
    echo ""
    printf '  %-12s %-12s %s\n' "RELEASE" "PUBLISHED" "DOWNLOADS"
    printf '  %-12s %-12s %s\n' "-------" "---------" "---------"
    printf '%s' "$rows" | jq -r '.rows[] | "\(.tag)\t\(.published)\t\(.downloads)"' \
      | while IFS=$'\t' read -r tag published downloads; do
          printf '  %-12s %-12s %s\n' "$tag" "$published" "$downloads"
        done
    echo ""
    echo "(Counts come from GitHub's release asset download_count, which"
    echo " increments on every direct download AND every self-update install.)"
    ;;
esac
