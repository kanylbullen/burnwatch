#!/usr/bin/env bash
# Set up burnwatch on this machine.
#
#   ./install/setup.sh server           daemon + collector on this host
#   ./install/setup.sh client <url>     collector only, reporting to <url>
#
# Re-running is safe: an existing token is kept, so every machine after the
# first can be pointed at the same daemon without rotating the secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF_DIR="$HOME/.burnwatch"
CONF="$CONF_DIR/env"
MODE="${1:-server}"

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"

if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090
  . "$CONF"
fi

case "$MODE" in
  server)
    URL="${BURNWATCH_URL:-http://127.0.0.1:8787}"
    ;;
  client)
    URL="${2:-}"
    [ -n "$URL" ] || { echo "usage: setup.sh client <daemon-url>" >&2; exit 2; }
    URL="${URL%/}"
    ;;
  *)
    echo "usage: setup.sh [server|client <url>]" >&2
    exit 2
    ;;
esac

TOKEN="${BURNWATCH_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  if [ "$MODE" = client ]; then
    echo "No token found. Copy BURNWATCH_TOKEN from the daemon host into $CONF first." >&2
    exit 1
  fi
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | cut -c1-32)"
  echo "Generated a new daemon token."
fi

# Every documented setting is carried through, not just the three this script
# happens to care about: it rewrites the file wholesale, and silently dropping
# a tuning the user had set there would be a rude surprise.
umask 077
cat > "$CONF" <<EOF
BURNWATCH_URL=$URL
BURNWATCH_TOKEN=$TOKEN
BURNWATCH_TZ=${BURNWATCH_TZ:-Europe/Stockholm}
EOF
for extra in BURNWATCH_PORT BURNWATCH_HOST BURNWATCH_DB BURNWATCH_LOOKBACK_5H \
             BURNWATCH_LOOKBACK_7D BURNWATCH_ACTIVE_SESSION_S BURNWATCH_RETENTION_S; do
  eval "value=\${$extra:-}"
  [ -n "$value" ] && printf '%s=%s\n' "$extra" "$value" >> "$CONF"
done
chmod 600 "$CONF"
echo "Wrote $CONF"

if [ "$MODE" = server ]; then
  command -v bun >/dev/null 2>&1 || {
    echo "bun not found on PATH. Install it from https://bun.sh, then re-run." >&2
    exit 1
  }

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed "s#ExecStart=.*#ExecStart=$(command -v bun) run $ROOT/daemon/server.ts#" \
    "$ROOT/install/burnwatch.service" > "$UNIT_DIR/burnwatch.service"

  # A user unit is the right home for this, but SSH sessions on a box whose
  # user D-Bus is not reachable cannot talk to systemd --user. Fall back to a
  # detached process so the install still leaves a running daemon behind.
  if systemctl --user daemon-reload 2>/dev/null &&
     systemctl --user enable --now burnwatch.service 2>/dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || true
    echo "Daemon enabled: systemctl --user status burnwatch"
  else
    echo "systemd --user unreachable from this session; starting detached instead."
    echo "  A detached daemon does NOT survive a reboot. Enable the unit from a"
    echo "  login shell to make it permanent:"
    echo "    systemctl --user enable --now burnwatch"
    echo "    loginctl enable-linger $USER   # so it also runs while logged out"

    # Restart rather than leave the old process running: after a token change
    # an already-running daemon still expects the previous one, so every
    # collector would start failing while this script reported success.
    RUNNING=$(pgrep -u "$USER" -f 'daemon/server\.ts' | head -1 || true)
    [ -n "$RUNNING" ] && kill "$RUNNING" 2>/dev/null && sleep 1

    ( set -a; . "$CONF"; set +a
      setsid nohup "$(command -v bun)" run "$ROOT/daemon/server.ts" \
        >"$CONF_DIR/daemon.log" 2>&1 </dev/null & )
    sleep 1
  fi
fi

chmod +x "$ROOT/collector/statusline.sh"

# What the OTHER machines have to point at. A loopback address is only ever
# right for this one, so say so rather than handing it out as the answer.
SHARE_URL="$URL"
case "$URL" in
  *//127.0.0.1*|*//localhost*)
    SHARE_URL="http://$(hostname -f 2>/dev/null || hostname):${URL##*:}  (other machines cannot use 127.0.0.1)"
    ;;
esac

cat <<EOF

Add this to your Claude Code settings (~/.claude/settings.json):

  "statusLine": { "type": "command", "command": "$ROOT/collector/statusline.sh" }

  Then restart any running Claude Code session — the setting is read at startup.

This machine:   $URL
Other machines: $SHARE_URL
Token:          $TOKEN
EOF
