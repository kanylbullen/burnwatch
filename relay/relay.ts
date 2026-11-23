/**
 * The burnwatch relay: a mailbox that stores ciphertext for hubs and devices
 * that have never met a server of their own. protocol/README.md is the
 * contract, and this file only enforces its shape: sizes, write-once slots,
 * expiry and who may read or write. It never decrypts anything, and it has
 * nothing to decrypt with.
 */

export type Env = {
  DB: D1Database;
  /** Per-address ceiling on every request. */
  RELAY_LIMIT?: RateLimit;
  /** Stricter per-address ceiling on creating channels and mailboxes. */
  CREATE_LIMIT?: RateLimit;
};

type RateLimit = { limit(o: { key: string }): Promise<{ success: boolean }> };

/** An idle channel lives this long after its last write: one week plus margin. */
export const CHANNEL_TTL_S = 8 * 24 * 3600;
/** A pairing has this long from its first message. */
export const MAILBOX_TTL_S = 10 * 60;
/**
 * A state envelope is a JSON reading of a few hundred bytes plus 29 bytes of
 * framing. 16 KiB leaves room for history the hub may add later, and still
 * stops anyone using a channel as free file storage.
 */
export const MAX_STATE_BYTES = 16 * 1024;
/** Mailbox slots carry two base64url values each, under 200 bytes. */
export const MAX_SLOT_BYTES = 1024;

const B64U_16 = /^[A-Za-z0-9_-]{22}$/;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const now = () => Math.floor(Date.now() / 1000);

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "cache-control": "no-store",
    },
  });

const notFound = () => reply(404, { error: "not found" });

function b64uDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64uEncode(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A base64url value of exactly `bytes` bytes, in canonical form. Comparing
 * hashes and keys as strings is only sound if each value has one spelling:
 * base64url leaves spare bits in the last character, so the value is decoded
 * and encoded again and must come back unchanged.
 */
function canonical(s: unknown, re: RegExp): s is string {
  if (typeof s !== "string" || !re.test(s)) return false;
  return b64uEncode(b64uDecode(s)) === s;
}

async function sha256b64u(data: Uint8Array): Promise<string> {
  return b64uEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

const label = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The hash of the bearer token, or null if there is none worth hashing. */
async function bearerHash(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7);
  if (!canonical(token, B64U_32)) return null;
  return sha256b64u(b64uDecode(token));
}

/**
 * Reads a body without trusting Content-Length, which a client can omit or
 * understate: the stream is cut off at the cap instead.
 */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  return concat(...parts);
}

async function readJson(req: Request): Promise<Record<string, unknown> | "too large" | null> {
  const raw = await readCapped(req, MAX_SLOT_BYTES);
  if (raw === null) return "too large";
  try {
    const v = JSON.parse(new TextDecoder().decode(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const tooLarge = () => reply(413, { error: "too large" });
const bad = (why: string) => reply(400, { error: why });
const conflict = () => reply(409, { error: "already set" });

// --- Channels -------------------------------------------------------------

async function createChannel(req: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too large") return tooLarge();
  if (!body || !canonical(body.read_hash, B64U_32) || !canonical(body.write_hash, B64U_32)) {
    return bad("expected read_hash and write_hash");
  }
  const t = now();
  // An expired row is taken over rather than refused. Otherwise a hub that was
  // switched off for a fortnight could never recreate its own channel, since
  // the id is derived from a secret it still holds.
  const res = await env.DB.prepare(
    `INSERT INTO channels (id, read_hash, write_hash, touched, state)
     VALUES (?1, ?2, ?3, ?4, NULL)
     ON CONFLICT (id) DO UPDATE SET
       read_hash = excluded.read_hash, write_hash = excluded.write_hash,
       touched = excluded.touched, state = NULL
     WHERE channels.touched <= ?5`,
  )
    .bind(id, body.read_hash, body.write_hash, t, t - CHANNEL_TTL_S)
    .run();
  if (res.meta.changes) return reply(201);
  // A hub whose reply was lost retries with the same hashes, and that must
  // not look like someone else holding the id.
  const row = await env.DB.prepare(
    `SELECT read_hash, write_hash FROM channels WHERE id = ?1`,
  )
    .bind(id)
    .first<{ read_hash: string; write_hash: string }>();
  return row?.read_hash === body.read_hash && row.write_hash === body.write_hash
    ? reply(201)
    : reply(409, { error: "exists" });
}

async function writeState(req: Request, env: Env, id: string): Promise<Response> {
  const hash = await bearerHash(req);
  if (!hash) return notFound();
  const body = await readCapped(req, MAX_STATE_BYTES);
  if (body === null) return tooLarge();
  // Version byte, nonce and tag. Anything shorter cannot be an envelope, and
  // the relay may as well say so rather than store it.
  if (body.length < 29 || body[0] !== 0x01) return bad("not an envelope");
  const t = now();
  const res = await env.DB.prepare(
    `UPDATE channels SET state = ?1, touched = ?2
     WHERE id = ?3 AND write_hash = ?4 AND touched > ?5`,
  )
    .bind(body, t, id, hash, t - CHANNEL_TTL_S)
    .run();
  return res.meta.changes ? reply(204) : notFound();
}

async function readState(req: Request, env: Env, id: string): Promise<Response> {
  const hash = await bearerHash(req);
  if (!hash) return notFound();
  const row = await env.DB.prepare(
    `SELECT state FROM channels
     WHERE id = ?1 AND read_hash = ?2 AND touched > ?3`,
  )
    .bind(id, hash, now() - CHANNEL_TTL_S)
    .first<{ state: ArrayBuffer | Uint8Array | number[] | null }>();
  if (!row?.state) return notFound();
  const bytes =
    row.state instanceof Uint8Array ? row.state : new Uint8Array(row.state as ArrayBuffer);
  return new Response(bytes, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

async function deleteChannel(req: Request, env: Env, id: string): Promise<Response> {
  const hash = await bearerHash(req);
  if (!hash) return notFound();
  const res = await env.DB.prepare(
    `DELETE FROM channels WHERE id = ?1 AND write_hash = ?2`,
  )
    .bind(id, hash)
    .run();
  return res.meta.changes ? reply(204) : notFound();
}

// --- Pairing --------------------------------------------------------------

type MailboxRow = {
  commit_: string;
  hello: string | null;
  reveal: string | null;
  seal: string | null;
};

async function openMailbox(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too large") return tooLarge();
  if (!body || !canonical(body.commit, B64U_32)) return bad("expected commit");
  const t = now();
  // Like a channel, an expired mailbox under the same code is reused rather
  // than blocking the code until the nightly sweep.
  const res = await env.DB.prepare(
    `INSERT INTO mailboxes (code, created, commit_) VALUES (?1, ?2, ?3)
     ON CONFLICT (code) DO UPDATE SET
       created = excluded.created, commit_ = excluded.commit_,
       hello = NULL, reveal = NULL, seal = NULL
     WHERE mailboxes.created <= ?4`,
  )
    .bind(code, t, body.commit, t - MAILBOX_TTL_S)
    .run();
  if (res.meta.changes) return reply(201);
  const row = await liveMailbox(env, code);
  return row?.commit_ === body.commit ? reply(201) : reply(409, { error: "code in use" });
}

async function liveMailbox(env: Env, code: string): Promise<MailboxRow | null> {
  return env.DB.prepare(
    `SELECT commit_, hello, reveal, seal FROM mailboxes
     WHERE code = ?1 AND created > ?2`,
  )
    .bind(code, now() - MAILBOX_TTL_S)
    .first<MailboxRow>();
}

/**
 * Fills one write-once slot. The `IS NULL` in the update is what makes it
 * write-once: two racing writers both pass any check made before it, and only
 * one of them changes a row.
 */
async function fillSlot(
  env: Env,
  code: string,
  slot: "hello" | "reveal" | "seal",
  value: string,
  requires?: "hello" | "reveal",
): Promise<Response> {
  const res = await env.DB.prepare(
    `UPDATE mailboxes SET ${slot} = ?1
     WHERE code = ?2 AND created > ?3 AND ${slot} IS NULL
     ${requires ? `AND ${requires} IS NOT NULL` : ""}`,
  )
    .bind(value, code, now() - MAILBOX_TTL_S)
    .run();
  if (res.meta.changes) return reply(204);
  const row = await liveMailbox(env, code);
  if (!row) return notFound();
  // The same value again is a retry after a lost reply, not a conflict.
  if (row[slot] === value) return reply(204);
  if (row[slot] !== null) return conflict();
  return reply(409, { error: `${requires} not set yet` });
}

async function putHello(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too large") return tooLarge();
  if (!body || !canonical(body.hpk, B64U_32) || !canonical(body.nonce, B64U_32)) {
    return bad("expected hpk and nonce");
  }
  return fillSlot(env, code, "hello", JSON.stringify({ hpk: body.hpk, nonce: body.nonce }));
}

async function putReveal(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too large") return tooLarge();
  if (!body || !canonical(body.dpk, B64U_32) || !canonical(body.nonce, B64U_32)) {
    return bad("expected dpk and nonce");
  }
  // The relay can check the commitment as cheaply as the hub can, and doing it
  // here means a stranger who guessed the code cannot occupy the reveal slot
  // with a key that was never committed to.
  const row = await liveMailbox(env, code);
  if (!row) return notFound();
  const commit = await sha256b64u(
    concat(label("burnwatch/v1 pair-commit"), b64uDecode(body.dpk), b64uDecode(body.nonce)),
  );
  if (commit !== row.commit_) return bad("reveal does not match commit");
  return fillSlot(
    env,
    code,
    "reveal",
    JSON.stringify({ dpk: body.dpk, nonce: body.nonce }),
    "hello",
  );
}

async function putSeal(req: Request, env: Env, code: string): Promise<Response> {
  const body = await readCapped(req, MAX_SLOT_BYTES);
  if (body === null) return tooLarge();
  if (body.length < 29 || body[0] !== 0x01) return bad("not an envelope");
  return fillSlot(env, code, "seal", b64uEncode(body), "reveal");
}

async function getMailbox(env: Env, code: string): Promise<Response> {
  const row = await liveMailbox(env, code);
  if (!row) return notFound();
  return reply(200, {
    commit: row.commit_,
    ...(row.hello ? { hello: JSON.parse(row.hello) } : {}),
    ...(row.reveal ? { reveal: JSON.parse(row.reveal) } : {}),
    ...(row.seal ? { seal: row.seal } : {}),
  });
}

async function deleteMailbox(env: Env, code: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM mailboxes WHERE code = ?1`).bind(code).run();
  return reply(204);
}

// --- Routing --------------------------------------------------------------

async function limited(limit: RateLimit | undefined, req: Request): Promise<boolean> {
  if (!limit) return false;
  const key = req.headers.get("cf-connecting-ip") ?? "unknown";
  return !(await limit.limit({ key })).success;
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const m = req.method;

  if (parts.length === 1 && parts[0] === "healthz") return reply(200, { ok: true });
  if (parts[0] !== "v1") return notFound();
  if (await limited(env.RELAY_LIMIT, req)) return reply(429, { error: "slow down" });

  const creates =
    (m === "PUT" && parts[1] === "channels" && parts.length === 3) ||
    (m === "POST" && parts[1] === "pair" && parts.length === 3);
  if (creates && (await limited(env.CREATE_LIMIT, req))) {
    return reply(429, { error: "slow down" });
  }

  if (parts[1] === "channels" && canonical(parts[2], B64U_16)) {
    const id = parts[2];
    if (parts.length === 3 && m === "PUT") return createChannel(req, env, id);
    if (parts.length === 3 && m === "DELETE") return deleteChannel(req, env, id);
    if (parts.length === 4 && parts[3] === "state") {
      if (m === "PUT") return writeState(req, env, id);
      if (m === "GET") return readState(req, env, id);
    }
  }

  if (parts[1] === "pair" && parts[2] !== undefined && CODE.test(parts[2])) {
    const code = parts[2];
    if (parts.length === 3) {
      if (m === "POST") return openMailbox(req, env, code);
      if (m === "GET") return getMailbox(env, code);
      if (m === "DELETE") return deleteMailbox(env, code);
    }
    if (parts.length === 4 && m === "PUT") {
      if (parts[3] === "hello") return putHello(req, env, code);
      if (parts[3] === "reveal") return putReveal(req, env, code);
      if (parts[3] === "seal") return putSeal(req, env, code);
    }
  }

  return notFound();
}

/** Deletes what has expired. Reads already ignore it; this just frees rows. */
export async function sweep(env: Env, t = now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM channels WHERE touched <= ?1`).bind(t - CHANNEL_TTL_S),
    env.DB.prepare(`DELETE FROM mailboxes WHERE created <= ?1`).bind(t - MAILBOX_TTL_S),
  ]);
}

