#!/bin/sh
# burnwatch collector — Claude Code statusLine command.
#
# Claude Code pipes its status-line JSON to this script on every render. That
# JSON carries the real, account-wide `rate_limits` block, so forwarding it is
# all the daemon needs: no OAuth token, no undocumented endpoint, no parsing.
#
# Install by adding to ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "~/burnwatch/collector/statusline.sh" }
#
# Configure with BURNWATCH_URL and BURNWATCH_TOKEN in your shell profile.
set -u

INPUT=$(cat)

# Config comes from ~/.burnwatch/env so a new machine needs one file copied and
# no shell profile touched. Anything already exported still wins, which keeps
# one-off overrides possible when testing against a second daemon.
_env_url="${BURNWATCH_URL:-}"
_env_token="${BURNWATCH_TOKEN:-}"
CONF="${BURNWATCH_CONF:-$HOME/.burnwatch/env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
[ -n "$_env_url" ] && BURNWATCH_URL="$_env_url"
[ -n "$_env_token" ] && BURNWATCH_TOKEN="$_env_token"

: "${BURNWATCH_URL:=http://127.0.0.1:8787}"
: "${BURNWATCH_TOKEN:=}"

# A trailing slash would make every POST hit //ingest and 404 forever, silently.
BURNWATCH_URL="${BURNWATCH_URL%/}"

HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)
STATUS="${TMPDIR:-/tmp}/burnwatch-status"

# Fire-and-forget in a detached subshell. The status line renders on every
# keystroke-ish event, so it must never block on the network — a slow or dead
# daemon has to cost zero milliseconds here.
#
# The background job leaves its outcome in $STATUS, because otherwise this
# collector has no failure signal whatsoever: misconfigure it and it reports
# nothing, forever, while printing a perfectly healthy status line.
(
  {
    printf '%s' "$INPUT" | curl -sS -m 2 \
      -X POST "$BURNWATCH_URL/ingest" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $BURNWATCH_TOKEN" \
      -H "x-burnwatch-host: $HOST" \
      --data-binary @- >/dev/null 2>&1
    printf '%s exit=%s url=%s/ingest\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$?" "$BURNWATCH_URL" > "$STATUS"
  } &
) >/dev/null 2>&1

# Everything below is only the terminal display; the daemon already has its copy.
if ! command -v jq >/dev/null 2>&1; then
  printf '%s' "$INPUT" | sed -n 's/.*"display_name":"\([^"]*\)".*/\1/p' | head -1
  exit 0
fi

printf '%s' "$INPUT" | jq -r '
  def pct(w): if (.rate_limits[w] // empty | .used_percentage) != null
              then (.rate_limits[w].used_percentage | floor | tostring) + "%"
              else "--" end;
  [ (.model.display_name // "claude"),
    ((.workspace.current_dir // "") | split("/") | last // ""),
    ("5h " + pct("five_hour")),
    ("7d " + pct("seven_day"))
  ] | map(select(. != "")) | join("  ·  ")
'
