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

umask 077
cat > "$CONF" <<EOF
BURNWATCH_URL=$URL
BURNWATCH_TOKEN=$TOKEN
BURNWATCH_TZ=${BURNWATCH_TZ:-Europe/Stockholm}
EOF
chmod 600 "$CONF"
echo "Wrote $CONF"

if [ "$MODE" = server ]; then
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
    echo "  Unit written to $UNIT_DIR/burnwatch.service — enable it from a login"
    echo "  shell with: systemctl --user enable --now burnwatch"
    if ! curl -sSf -m 2 "$URL/healthz" >/dev/null 2>&1; then
      ( set -a; . "$CONF"; set +a
        setsid nohup "$(command -v bun)" run "$ROOT/daemon/server.ts" \
          >"$CONF_DIR/daemon.log" 2>&1 </dev/null & )
      sleep 1
    fi
  fi
fi

chmod +x "$ROOT/collector/statusline.sh"

cat <<EOF

Add this to your Claude Code settings (~/.claude/settings.json):

  "statusLine": { "type": "command", "command": "$ROOT/collector/statusline.sh" }

Daemon URL:   $URL
Token:        $TOKEN
EOF
