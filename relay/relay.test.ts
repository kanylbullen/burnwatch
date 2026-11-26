import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import * as p from "../core/protocol";
import { memoryD1 } from "./d1-shim";
import {
  CHANNEL_TTL_S,
  MAILBOX_TTL_S,
  MAX_STATE_BYTES,
  handle,
  sweep,
  type Env,
} from "./relay";

const MIGRATION = `${import.meta.dir}/migrations/0001_init.sql`;
const T0 = 1_786_000_000;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

let env: Env;
beforeEach(() => {
  env = { DB: memoryD1(MIGRATION) };
  setSystemTime(new Date(T0 * 1000));
});
afterEach(() => setSystemTime());

const at = (s: number) => setSystemTime(new Date((T0 + s) * 1000));

function call(
  method: string,
  path: string,
  body?: unknown,
  bearer?: Uint8Array,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${p.b64u(bearer)}`;
  let payload: BodyInit | undefined;
  if (body instanceof Uint8Array) payload = body;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return handle(
    new Request(`https://relay.test${path}`, { method, headers, body: payload }),
    env,
  );
}

function newHub() {
  const secret = rand(32);
  const write = rand(32);
  const ch = p.deriveChannel(secret);
  const id = p.b64u(ch.channelId);
  return { secret, write, ch, id };
}

async function createChannel(h: ReturnType<typeof newHub>) {
  return call("PUT", `/v1/channels/${h.id}`, {
    read_hash: p.tokenHash(h.ch.readToken),
    write_hash: p.tokenHash(h.write),
  });
}

test("a hub creates a channel, publishes, and a reader opens what it published", async () => {
  const h = newHub();
  expect((await createChannel(h)).status).toBe(201);
  expect((await createChannel(h)).status).toBe(201);

  const env1 = p.sealState(h.ch, rand(12), { v: 1, issued_at: T0, state: { pct: 42 } });
  expect((await call("PUT", `/v1/channels/${h.id}/state`, env1, h.write)).status).toBe(204);

  const r = await call("GET", `/v1/channels/${h.id}/state`, undefined, h.ch.readToken);
  expect(r.status).toBe(200);
  const got = new Uint8Array(await r.arrayBuffer());
  expect(p.openState(h.ch, got).state).toEqual({ pct: 42 });
});

test("the read token cannot write, and the write token cannot read", async () => {
  const h = newHub();
  await createChannel(h);
  const env1 = p.sealState(h.ch, rand(12), { v: 1, issued_at: T0, state: {} });
  expect((await call("PUT", `/v1/channels/${h.id}/state`, env1, h.ch.readToken)).status).toBe(404);
  await call("PUT", `/v1/channels/${h.id}/state`, env1, h.write);
  expect((await call("GET", `/v1/channels/${h.id}/state`, undefined, h.write)).status).toBe(404);
  expect((await call("GET", `/v1/channels/${h.id}/state`)).status).toBe(404);
});

test("a wrong token gets the same reply as a channel that does not exist", async () => {
  const h = newHub();
  await createChannel(h);
  const wrong = await call("GET", `/v1/channels/${h.id}/state`, undefined, rand(32));
  const missing = await call("GET", `/v1/channels/${newHub().id}/state`, undefined, rand(32));
  expect(wrong.status).toBe(missing.status);
  expect(await wrong.text()).toBe(await missing.text());
});

test("an oversized state is refused, and so is anything that is not an envelope", async () => {
  const h = newHub();
  await createChannel(h);
  const big = new Uint8Array(MAX_STATE_BYTES + 1);
  big[0] = 1;
  expect((await call("PUT", `/v1/channels/${h.id}/state`, big, h.write)).status).toBe(413);
  expect((await call("PUT", `/v1/channels/${h.id}/state`, rand(10), h.write)).status).toBe(400);
});

test("an idle channel expires, and its hub can then create it again", async () => {
  const h = newHub();
  await createChannel(h);
  const env1 = p.sealState(h.ch, rand(12), { v: 1, issued_at: T0, state: {} });
  await call("PUT", `/v1/channels/${h.id}/state`, env1, h.write);

  at(CHANNEL_TTL_S - 1);
  expect((await call("GET", `/v1/channels/${h.id}/state`, undefined, h.ch.readToken)).status).toBe(200);
  at(CHANNEL_TTL_S + 1);
  expect((await call("GET", `/v1/channels/${h.id}/state`, undefined, h.ch.readToken)).status).toBe(404);
  expect((await call("PUT", `/v1/channels/${h.id}/state`, env1, h.write)).status).toBe(404);
  expect((await createChannel(h)).status).toBe(201);
});

test("a write keeps the channel alive", async () => {
  const h = newHub();
  await createChannel(h);
  const env1 = p.sealState(h.ch, rand(12), { v: 1, issued_at: T0, state: {} });
  at(CHANNEL_TTL_S - 10);
  await call("PUT", `/v1/channels/${h.id}/state`, env1, h.write);
  at(CHANNEL_TTL_S + 10);
  expect((await call("GET", `/v1/channels/${h.id}/state`, undefined, h.ch.readToken)).status).toBe(200);
});

test("ids and tokens must be canonical base64url of the right length", async () => {
  const h = newHub();
  // 16 bytes take 22 characters and leave 4 spare bits in the last one, so
  // the next character up decodes to the same bytes. It must not be accepted
  // as a second spelling of the same channel.
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const alias = h.id.slice(0, -1) + ALPHA[ALPHA.indexOf(h.id.at(-1)!) + 1];
  expect(Buffer.from(alias, "base64url").toString("hex")).toBe(p.hex(h.ch.channelId));
  expect(() => p.unb64u(alias)).toThrow("canonical");
  const body = { read_hash: p.tokenHash(h.ch.readToken), write_hash: p.tokenHash(h.write) };
  expect((await call("PUT", `/v1/channels/${alias}`, body)).status).toBe(404);
  expect((await call("PUT", `/v1/channels/${h.id}x`, body)).status).toBe(404);
  const r = await call("PUT", `/v1/channels/${h.id}`, { read_hash: "short", write_hash: "x" });
  expect(r.status).toBe(400);
});

type Box = {
  commit: string;
  hello: { hpk: string; nonce: string };
  reveal: { dpk: string; nonce: string };
  seal: string;
};

async function pairThroughRelay(opts: { confirm: boolean }) {
  const h = newHub();
  await createChannel(h);

  // D: commit.
  const code = p.codeFromBytes(rand(5));
  const dsk = rand(32);
  const dpk = p.publicKeyOf(dsk);
  const nD = rand(32);
  const commit = p.pairCommit(dpk, nD);
  expect((await call("POST", `/v1/pair/${code}`, { commit: p.b64u(commit) })).status).toBe(201);

  // H: the user typed the code with a hyphen and in lower case. H reads the
  // mailbox and pins the commitment before it sends anything of its own.
  const typed = p.normalizeCode(p.formatCode(code).toLowerCase())!;
  const pinned = ((await (await call("GET", `/v1/pair/${typed}`)).json()) as Box).commit;
  const hsk = rand(32);
  const hpk = p.publicKeyOf(hsk);
  const nH = rand(32);
  expect(
    (await call("PUT", `/v1/pair/${typed}/hello`, { hpk: p.b64u(hpk), nonce: p.b64u(nH) })).status,
  ).toBe(204);

  // D: reveal, after seeing the hello.
  const seen = (await (await call("GET", `/v1/pair/${code}`)).json()) as Box;
  expect(seen.hello.hpk).toBe(p.b64u(hpk));
  expect(
    (await call("PUT", `/v1/pair/${code}/reveal`, { dpk: p.b64u(dpk), nonce: p.b64u(nD) })).status,
  ).toBe(204);

  // H: checks the commitment from what the relay returned, not from memory.
  const box = (await (await call("GET", `/v1/pair/${typed}`)).json()) as Box;
  const rdpk = p.unb64u(box.reveal.dpk);
  const rnD = p.unb64u(box.reveal.nonce);
  expect(box.commit).toBe(pinned);
  expect(p.b64u(p.pairCommit(rdpk, rnD))).toBe(pinned);

  const tr = { code, commit: p.unb64u(pinned), hpk, nH, dpk: rdpk, nD: rnD };
  const tH = p.transcriptHash(tr);
  const tD = p.transcriptHash({ code, commit, hpk: p.unb64u(seen.hello.hpk), nH: p.unb64u(seen.hello.nonce), dpk, nD });
  expect(p.sas(tH)).toBe(p.sas(tD));
  if (!opts.confirm) return { code, h };

  const sealed = p.sealPairing(p.pairKey(hsk, rdpk, tH), rand(12), tH, {
    v: 1,
    relay: "https://relay.test",
    secret: p.b64u(h.secret),
  });
  expect((await call("PUT", `/v1/pair/${typed}/seal`, sealed)).status).toBe(204);

  const done = (await (await call("GET", `/v1/pair/${code}`)).json()) as Box;
  const opened = p.openPairing(p.pairKey(dsk, hpk, tD), p.unb64u(done.seal), tD);
  expect(p.hex(opened.secret)).toBe(p.hex(h.secret));
  expect((await call("DELETE", `/v1/pair/${code}`)).status).toBe(204);
  expect((await call("GET", `/v1/pair/${code}`)).status).toBe(404);
  return { code, h };
}

test("a full pairing through the relay hands the device the channel secret", async () => {
  await pairThroughRelay({ confirm: true });
});

test("every mailbox slot is write-once", async () => {
  const { code } = await pairThroughRelay({ confirm: false });
  const again = await call("PUT", `/v1/pair/${code}/hello`, { hpk: p.b64u(rand(32)), nonce: p.b64u(rand(32)) });
  expect(again.status).toBe(409);
  expect((await call("POST", `/v1/pair/${code}`, { commit: p.b64u(rand(32)) })).status).toBe(409);
});

test("retrying a write with the same value succeeds", async () => {
  const h = newHub();
  expect((await createChannel(h)).status).toBe(201);
  expect((await createChannel(h)).status).toBe(201);
  const other = newHub();
  const clash = await call("PUT", `/v1/channels/${h.id}`, {
    read_hash: p.tokenHash(other.ch.readToken),
    write_hash: p.tokenHash(other.write),
  });
  expect(clash.status).toBe(409);

  const code = p.codeFromBytes(rand(5));
  const commit = { commit: p.b64u(rand(32)) };
  expect((await call("POST", `/v1/pair/${code}`, commit)).status).toBe(201);
  expect((await call("POST", `/v1/pair/${code}`, commit)).status).toBe(201);
  const hello = { hpk: p.b64u(rand(32)), nonce: p.b64u(rand(32)) };
  expect((await call("PUT", `/v1/pair/${code}/hello`, hello)).status).toBe(204);
  expect((await call("PUT", `/v1/pair/${code}/hello`, hello)).status).toBe(204);
});

test("a reveal that does not match the commitment is refused", async () => {
  const code = p.codeFromBytes(rand(5));
  const dpk = p.publicKeyOf(rand(32));
  const nD = rand(32);
  await call("POST", `/v1/pair/${code}`, { commit: p.b64u(p.pairCommit(dpk, nD)) });
  await call("PUT", `/v1/pair/${code}/hello`, { hpk: p.b64u(rand(32)), nonce: p.b64u(rand(32)) });
  const forged = await call("PUT", `/v1/pair/${code}/reveal`, { dpk: p.b64u(rand(32)), nonce: p.b64u(nD) });
  expect(forged.status).toBe(400);
  const real = await call("PUT", `/v1/pair/${code}/reveal`, { dpk: p.b64u(dpk), nonce: p.b64u(nD) });
  expect(real.status).toBe(204);
});

test("slots must be filled in order", async () => {
  const code = p.codeFromBytes(rand(5));
  const dpk = p.publicKeyOf(rand(32));
  const nD = rand(32);
  await call("POST", `/v1/pair/${code}`, { commit: p.b64u(p.pairCommit(dpk, nD)) });
  const early = await call("PUT", `/v1/pair/${code}/reveal`, { dpk: p.b64u(dpk), nonce: p.b64u(nD) });
  expect(early.status).toBe(409);
  const seal = new Uint8Array(40);
  seal[0] = 1;
  expect((await call("PUT", `/v1/pair/${code}/seal`, seal)).status).toBe(409);
});

test("a mailbox expires after ten minutes, and the code can then be reused", async () => {
  const code = p.codeFromBytes(rand(5));
  await call("POST", `/v1/pair/${code}`, { commit: p.b64u(rand(32)) });
  at(MAILBOX_TTL_S + 1);
  expect((await call("GET", `/v1/pair/${code}`)).status).toBe(404);
  expect((await call("POST", `/v1/pair/${code}`, { commit: p.b64u(rand(32)) })).status).toBe(201);
});

test("a code that is not normalised is not an address", async () => {
  const code = p.codeFromBytes(rand(5));
  expect((await call("POST", `/v1/pair/${code.toLowerCase()}`, { commit: p.b64u(rand(32)) })).status).toBe(404);
  expect((await call("POST", `/v1/pair/${p.formatCode(code)}`, { commit: p.b64u(rand(32)) })).status).toBe(404);
});

test("an oversized slot body is refused", async () => {
  const code = p.codeFromBytes(rand(5));
  const r = await call("POST", `/v1/pair/${code}`, { commit: "A".repeat(2000) });
  expect(r.status).toBe(413);
});

test("the sweep deletes only what has expired", async () => {
  const old = newHub();
  await createChannel(old);
  at(CHANNEL_TTL_S + 1);
  const fresh = newHub();
  await createChannel(fresh);
  await sweep(env);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM channels").first<{ n: number }>();
  expect(n!.n).toBe(1);
});

test("the rate limiters are consulted", async () => {
  let calls = 0;
  env.CREATE_LIMIT = { limit: async () => ({ success: ++calls > 99 }) };
  const r = await call("POST", `/v1/pair/${p.codeFromBytes(rand(5))}`, { commit: p.b64u(rand(32)) });
  expect(r.status).toBe(429);
  env.RELAY_LIMIT = { limit: async () => ({ success: false }) };
  expect((await call("GET", `/v1/pair/${p.codeFromBytes(rand(5))}`)).status).toBe(429);
});

test("a reveal for an expired mailbox does not land in the one reopened under its code", async () => {
  const code = p.codeFromBytes(rand(5));
  const dpk = p.publicKeyOf(rand(32));
  const nD = rand(32);
  await call("POST", `/v1/pair/${code}`, { commit: p.b64u(p.pairCommit(dpk, nD)) });
  at(MAILBOX_TTL_S + 1);
  await call("POST", `/v1/pair/${code}`, { commit: p.b64u(rand(32)) });
  await call("PUT", `/v1/pair/${code}/hello`, { hpk: p.b64u(rand(32)), nonce: p.b64u(rand(32)) });
  const stale = await call("PUT", `/v1/pair/${code}/reveal`, { dpk: p.b64u(dpk), nonce: p.b64u(nD) });
  expect(stale.status).toBe(400);
});
