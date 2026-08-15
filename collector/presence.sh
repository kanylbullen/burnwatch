#!/bin/sh
# burnwatch presence hook — reports that this machine is working.
#
# The status-line collector only runs in the interactive terminal. Anything
# headless — the IDE extensions, web and remote-control sessions, `claude -p`,
# the SDK — renders no status line, so that machine never appears at all.
#
# Hooks do fire in every one of those modes. They carry no rate_limits, so this
# sends no numbers: those come from the Worker's poll, which reads the whole
# account. What this adds is the machine's name and an active session, so the
# host list reflects where you are actually working.
#
# Install by adding to ~/.claude/settings.json:
#   "hooks": {
#     "SessionStart":      [{ "hooks": [{ "type": "command", "command": "~/burnwatch/collector/presence.sh" }] }],
#     "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "~/burnwatch/collector/presence.sh" }] }]
#   }
set -u

INPUT=$(cat)

_env_url="${BURNWATCH_URL:-}"
_env_token="${BURNWATCH_TOKEN:-}"
CONF="${BURNWATCH_CONF:-$HOME/.burnwatch/env}"
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
[ -n "$_env_url" ] && BURNWATCH_URL="$_env_url"
[ -n "$_env_token" ] && BURNWATCH_TOKEN="$_env_token"

: "${BURNWATCH_URL:=http://127.0.0.1:8787}"
: "${BURNWATCH_TOKEN:=}"
BURNWATCH_URL="${BURNWATCH_URL%/}"

HOST=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)

# Only the session id leaves the machine. The hook payload also carries the
# transcript path and working directory, which say nothing about usage.
if command -v jq >/dev/null 2>&1; then
  PAYLOAD=$(printf '%s' "$INPUT" | jq -c '{ session_id: .session_id }')
else
  PAYLOAD=''
fi

# Detached, like the status-line collector: a hook that blocks delays the
# thing it is attached to, and a heartbeat is never worth that.
if [ -n "$PAYLOAD" ]; then
  (
    printf '%s' "$PAYLOAD" | curl -sS -m 2 \
      -X POST "$BURNWATCH_URL/ingest" \
      -H 'content-type: application/json' \
      -H "authorization: Bearer $BURNWATCH_TOKEN" \
      -H "x-burnwatch-host: $HOST" \
      --data-binary @- >/dev/null 2>&1 &
  ) >/dev/null 2>&1
fi

# Hooks must not write to stdout unless they mean to speak to the session.
exit 0
