import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, WINDOW_LENGTH, num } from "../core/defaults";

export { WINDOW_KEYS, type WindowKey } from "../core/defaults";

/**
 * Loads ~/.burnwatch/env into the environment.
 *
 * The systemd unit passes this file via EnvironmentFile, but nothing else did:
 * starting the daemon by hand — `bun run dev`, a login shell, any other
 * supervisor — silently ignored every setting in it, including the token. That
 * bound 0.0.0.0 with authentication disabled while the file sat there holding
 * a token, which is the opposite of what the file's presence implies.
 *
 * Anything already exported wins, so systemd and one-off overrides still lead.
 */
function loadEnvFile(): void {
  const path =
    process.env.BURNWATCH_CONF ?? join(homedir(), ".burnwatch", "env");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // Absent is normal: the file is optional.
  }

  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnvFile();

export const config = {
  port: num(process.env.BURNWATCH_PORT, 8787),
  host: process.env.BURNWATCH_HOST ?? "0.0.0.0",
  dbPath:
    process.env.BURNWATCH_DB ?? join(homedir(), ".burnwatch", "burnwatch.db"),

  /**
   * Shared secret. Collectors send it as `Authorization: Bearer <token>`.
   * Empty disables auth, which is only safe on a loopback-only bind.
   */
  token: process.env.BURNWATCH_TOKEN ?? "",

  timeZone: process.env.BURNWATCH_TZ || DEFAULTS.timeZone,

  lookback: {
    five_hour: num(process.env.BURNWATCH_LOOKBACK_5H, DEFAULTS.lookback.five_hour),
    seven_day: num(process.env.BURNWATCH_LOOKBACK_7D, DEFAULTS.lookback.seven_day),
  },

  windowLength: WINDOW_LENGTH,

  onPaceLow: DEFAULTS.onPaceLow,
  onPaceHigh: DEFAULTS.onPaceHigh,

  activeSessionS: num(
    process.env.BURNWATCH_ACTIVE_SESSION_S,
    DEFAULTS.activeSessionS,
  ),

  retentionS: num(process.env.BURNWATCH_RETENTION_S, DEFAULTS.retentionS),
} as const;
