# burnwatch

**A desk widget for your Claude Code rate limits — how much of the weekly and
5-hour allowance is gone, how fast you are burning it, and whether you run dry
before the reset.**

Claude Code tells you your usage percentage if you go looking for it. burnwatch
puts it on your desktop and, more usefully, turns it into a *rate*: at the pace
of the last day, do you finish the week with allowance to spare, or does it run
out on Thursday morning?

> Built after seeing someone put the same idea on an ESP32-S3. The daemon
> speaks plain JSON over HTTP, so the desktop widget here and a future firmware
> are just two clients of one feed.

<p align="center">
  <img src="docs/screen-weekly.png" width="240" alt="Weekly allowance: 23% used, +23% today, 1D 22H to reset">
  <img src="docs/screen-burn.png" width="240" alt="Burn rate: SPEED UP, 7.9x current pace to max out">
  <img src="docs/screen-session.png" width="240" alt="5-hour session allowance: 38% used">
</p>

---

## How it works

```
  Claude Code (any machine)          one daemon                  clients
  ┌──────────────────────┐         ┌──────────────┐        ┌─────────────────┐
  │ statusLine collector ├─POST───▶│  burnwatch   │◀─GET───┤ desktop widget  │
  │  every machine you   │ /ingest │  SQLite +    │ /api/  │ browser         │
  │  code on             │         │  forecast    │ state  │ ESP32-S3 (todo) │
  └──────────────────────┘         └──────────────┘        └─────────────────┘
```

Claude Code pipes a JSON payload to its `statusLine` command on every render,
and that payload carries the real rate-limit block:

```json
"rate_limits": {
  "five_hour": { "used_percentage": 12.5, "resets_at": 1786610276 },
  "seven_day": { "used_percentage": 23.0, "resets_at": 1786772276 }
}
```

Three things follow from using that as the source:

- **It is documented and supported.** No OAuth token is copied anywhere and no
  undocumented endpoint is called, so a Claude Code release cannot quietly
  break it.
- **The numbers are account-wide.** One reading already covers every machine on
  the account, phones included. Parsing local transcript files would only ever
  see the usage produced on the machine doing the parsing.
- **You need one daemon, not one per machine.** Any host running the collector
  reports the same account totals.

The block is absent before a session's first API response, and for accounts
without a Claude subscription. The collector handles both by forwarding
whatever it was handed.

## Burn rate and forecast

Percentages alone do not tell you whether you are in trouble. Every rate is
measured against **wall-clock time**, because a gap in the samples is real
information: the collector only reports while Claude Code runs, and usage only
accrues while Claude Code runs. Six quiet hours are six hours of genuine zero
burn, not missing data.

| Verdict | Meaning | Headline |
|---|---|---|
| `speed_up` | You will not use the allowance before it resets | `7.9× CURRENT PACE TO MAX OUT` |
| `on_pace` | Landing near 100% right around the reset | `ON PACE` |
| `runs_out` | You hit 100% early | `2D 4H EARLY`, plus the wall-clock time |

The multiplier is `required_pace / current_pace`, where the required pace is
what it would take to finish exactly at the reset. Worked example: 23% used
with 47h left and +5%/day observed gives a required `77/47 = 1.64 %/h` against
an observed `5/24 = 0.21 %/h` — so **7.9×**.

## Requirements

- [Bun](https://bun.sh) on the machine running the daemon.
- A Claude subscription — the `rate_limits` block is not sent otherwise.
- For the desktop widget: Rust, and WebView2 (preinstalled on Windows 11).
- `jq` on Linux/macOS machines, for the status-line text only. Reporting works
  without it.

## 1. Daemon (once, on one machine)

```bash
git clone https://github.com/kanylbullen/burnwatch ~/burnwatch
cd ~/burnwatch
./install/setup.sh server
```

This generates a token, writes `~/.burnwatch/env`, installs a systemd user
unit, and prints the URL and token the other machines need.

If the box has no reachable user D-Bus — common over plain SSH — the script
says so and starts the daemon detached instead. Enable the unit later from a
login shell with `systemctl --user enable --now burnwatch`.

The daemon binds `0.0.0.0` by default. If only this machine will report, set
`BURNWATCH_HOST=127.0.0.1` and skip the firewall entirely. Otherwise open the
port to your LAN only:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 8787 proto tcp
```

## 2. Collector (on every machine you code on)

The collector prints a normal status line — `Opus 5 · myproject · 5h 41% ·
7d 24%` — and reports in the background. It never waits on the network:
measured at ~15 ms even when pointed at an unroutable address.

### Linux / macOS

```bash
git clone https://github.com/kanylbullen/burnwatch ~/burnwatch
mkdir -p ~/.burnwatch && chmod 700 ~/.burnwatch
printf 'BURNWATCH_URL=http://DAEMON:8787\nBURNWATCH_TOKEN=YOUR_TOKEN\n' > ~/.burnwatch/env
chmod 600 ~/.burnwatch/env
chmod +x ~/burnwatch/collector/statusline.sh
```

Then add to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "/home/you/burnwatch/collector/statusline.sh"
}
```

### Windows

Copy `collector/burnwatch.env.example` to `collector/burnwatch.env` and fill in
the URL and token, then add to `%USERPROFILE%\.claude\settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/you/burnwatch/collector/statusline.ps1"
}
```

**Use forward slashes in that path.** See [Gotchas](#gotchas) — with
backslashes it fails silently and nothing is ever reported.

Claude Code reads `statusLine` at startup, so **restart any running session**
before expecting data.

## 3. Widget

Open the daemon in a browser for the zero-build version:

```
http://DAEMON:8787/?token=YOUR_TOKEN
```

Add `&page=2&norotate=1` to pin one card. For the real thing — frameless,
always on top, out of the taskbar:

```bash
cd widget/src-tauri
cargo build --release
```

The binary lands in `widget/src-tauri/target/release/`. Point it at the daemon
with the `BURNWATCH_URL` and `BURNWATCH_TOKEN` environment variables, or with a
`config.json` in the app config directory (`%APPDATA%\io.github.kanylbullen.burnwatch\` on
Windows, `~/.config/io.github.kanylbullen.burnwatch/` on Linux):

```json
{
  "url": "http://DAEMON:8787",
  "token": "YOUR_TOKEN",
  "width": 260,
  "height": 260,
  "always_on_top": true
}
```

Environment wins over the file, which the app rewrites when you move or resize
the window. Click to page, drag to move, scroll or arrow keys to navigate, and
use the tray icon to unpin or quit — a frameless window with no taskbar entry
has no other way to be closed.

## The JSON API

`GET /api/state` — the contract any client reads, including firmware.

```jsonc
{
  "ok": true,
  "now": 1786603076,
  "tz": "Europe/Stockholm",
  "active_sessions": 2,         // sessions that reported in the last 15 min
  "hosts": [                    // every host ever seen, newest first
    { "name": "desktop", "last_seen_s": 4, "active": true },
    { "name": "laptop", "last_seen_s": 5400, "active": false }
  ],
  "last_contact_s": 0,          // liveness: since ANY collector reported
  "windows": {
    "seven_day": {
      "pct": 23,
      "resets_at": 1786772276,
      "resets_in_s": 169200,
      "window_length_s": 604800,
      "rate_pct_per_h": 0.2083,
      "required_pct_per_h": 1.6383,
      "pace_ratio": 0.1272,
      "verdict": "speed_up",     // speed_up | on_pace | runs_out | unknown
      "speed_up_x": 7.88,        // null when no burn has been measured
      "runs_out_at": null,
      "early_by_s": null,
      "used_today_pct": 1.81,    // null for windows shorter than a day
      "samples": 145,
      "last_change_s": 0         // idleness, NOT health — use last_contact_s
    },
    "five_hour": { }
  }
}
```

Both windows are `null` until the first sample arrives. `POST /ingest` takes
Claude Code's status-line JSON verbatim, with an optional `X-Burnwatch-Host`
header.

## Configuration

Read by the daemon from `~/.burnwatch/env`:

| Variable | Default | Notes |
|---|---|---|
| `BURNWATCH_PORT` | `8787` | |
| `BURNWATCH_HOST` | `0.0.0.0` | `127.0.0.1` if only this machine reports |
| `BURNWATCH_TOKEN` | *(empty)* | Empty disables auth — only safe on loopback |
| `BURNWATCH_DB` | `~/.burnwatch/burnwatch.db` | |
| `BURNWATCH_TZ` | `Europe/Stockholm` | Drives "used today" and displayed clock times |
| `BURNWATCH_LOOKBACK_7D` | `86400` | Window for measuring weekly pace |
| `BURNWATCH_LOOKBACK_5H` | `3600` | Window for measuring session pace |
| `BURNWATCH_RETENTION_S` | `2592000` | Samples older than this are pruned |

## Gotchas

Four things cost real debugging time. They are documented here because none of
them announce themselves.

**Forward slashes in the Windows `statusLine` path.** Claude Code runs the
command through bash (git bash) on Windows, where every backslash is an escape
character. `C:\Users\you\...` arrives at PowerShell as `C:Usersyou...`, which
does not exist; PowerShell exits 127 and Claude Code swallows the error. The
status line simply never appears and nothing is reported, with no message
anywhere to say why.

**`System.Net.Http` is not loaded in Windows PowerShell 5.1.**
`[System.Net.Http.HttpClient]::new()` throws "Unable to find type", and inside
a `try`/`catch` that is invisible — leaving a collector that prints a perfect
status line and never reports. The script uses `curl.exe` instead, which ships
with Windows 10+ and costs about 10 ms against a daemon on the LAN.

**`statusline.ps1` must stay pure ASCII.** PowerShell 5.1 decodes a BOM-less
file as the legacy ANSI code page, so a stray em dash inside a quoted string
can terminate it early. Separately, the console is often not UTF-8, so
non-ASCII *output* has to be built from code points at runtime with
`[Console]::OutputEncoding` forced. CI enforces the ASCII rule.

**CSP source expressions default to the scheme's port.** In the Tauri shell,
`connect-src http://*` permits port 80 only, so a daemon on 8787 is blocked and
the widget reports "failed to fetch". It needs `http://*:*`.

To tell "never invoked" from "invoked but failed to report", look in `%TEMP%`
(or `$TMPDIR`) for `burnwatch-<session-id>.json`. The collector writes that file
before calling curl, so its presence proves the script ran.

## Security

The token is the only thing protecting the feed, and it travels over **plain
HTTP**. That is fine on a trusted LAN or over Tailscale/WireGuard. Do not expose
the port to the internet as-is; put it behind a TLS reverse proxy if it has to
leave the network.

Static widget files are served without the token — they are inert markup
carrying no usage data, and a stylesheet fetched by a relative `href` cannot
present a credential. Everything under `/api/` requires it.

## Development

```bash
bun test                  # forecast maths
bun run dev               # daemon on :8787
```

The tests cover window rollovers, idle gaps counting as zero burn, run-out
forecasting, the zero-pace case, exhausted windows and time-zone handling.
`widget/src/app.js` is the reference implementation for anyone writing another
client — it consumes exactly the payload documented above.

## Roadmap

- **ESP32-S3 firmware.** The original inspiration. `/api/state` is the
  interface and the widget is the reference for what to draw.
- **Codex.** No equivalent status-line hook exists, so it needs its own
  collector.
- **A native collector.** The PowerShell one costs ~600 ms per render, of
  which ~266 ms is PowerShell startup. A small compiled binary would be ~5 ms.
- **Alerts.** Right now you have to look at the widget to learn you are about
  to run out.

## License

MIT — see [LICENSE](LICENSE).
