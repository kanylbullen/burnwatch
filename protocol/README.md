# burnwatch relay protocol, version 1

This is the format the desktop hub, the watch and phone apps, and the relay
agree on (epic #7). The relay is a dumb mailbox: it stores what it is given,
hands it back to whoever proves they may read it, and forgets it. Nothing it
holds can be read without a secret it never sees.

Every implementation is tested against [`vectors.json`](vectors.json). A change
to anything below is a change to the vectors, and a client that disagrees with
them is wrong even if it can talk to itself.

The reference implementation is [`core/protocol.ts`](../core/protocol.ts), and
`bun run protocol:vectors` regenerates the vectors from it. Implementations
tested against them:

| Language | Where | Used by |
|---|---|---|
| TypeScript | [`core/protocol.ts`](../core/protocol.ts) | reference, relay tests |
| Rust | [`protocol/rust`](rust) | the desktop hub |

## Primitives

| Use | Primitive |
|---|---|
| Key agreement | X25519 (RFC 7748) |
| Key derivation | HKDF-SHA256 (RFC 5869) |
| Encryption | AES-256-GCM, 12-byte random nonce, 16-byte tag |
| Hashing | SHA-256 |
| Binary in JSON and URLs | base64url without padding (RFC 4648 §5) |

Every one of these is native to CryptoKit, Tink/JCA and RustCrypto. All
labels below are ASCII. `||` is concatenation, and `HKDF(ikm, salt, info, n)`
is extract-then-expand to `n` bytes. An absent salt is the empty string, which
RFC 5869 treats as 32 zero bytes.

An X25519 result of 32 zero bytes (a low-order peer key) is an error, and the
exchange must be abandoned.

## The channel

A hub owns one **channel**. It is created from two random 32-byte values that
the hub generates once and keeps:

- **`S`, the channel secret.** Every paired device gets a copy. Everything a
  reader needs is derived from it:

  ```
  channel_id = HKDF(S, "", "burnwatch/v1 channel-id", 16)
  read_token = HKDF(S, "", "burnwatch/v1 read-token", 32)
  state_key  = HKDF(S, "", "burnwatch/v1 state-key", 32)
  ```

- **`W`, the write token.** It never leaves the hub. Because it is not
  derived from `S`, a lost watch can read the channel but cannot write to it.

The relay stores `SHA-256(read_token)` and `SHA-256(W)` and nothing else
about who may do what. A leak of its storage gives no token.

### State

The hub publishes the current reading as one **state envelope**, which replaces
the previous one:

```
envelope   = 0x01 || nonce(12) || AES-256-GCM(state_key, nonce, plaintext, aad)
aad        = "burnwatch/v1 state " || channel_id
plaintext  = UTF-8 JSON {"v": 1, "issued_at": <epoch seconds>, "state": {...}}
```

`state` has the same shape as the self-hosted `GET /api/state` reply, so a
client renders either one with the same code.

Binding `channel_id` into the AAD stops the relay from serving one channel's
envelope as another's. The relay can still hand back an *older* envelope from
the same channel, so a reader remembers the highest `issued_at` it has
accepted and refuses anything below it.

The leading byte is the format version. A reader refuses a version it does
not know rather than guessing at it.

## Pairing a device

The watch (**D**, the device) and the desktop app (**H**, the hub) agree on a
key through the relay and then show the user a six-digit number. If the
numbers match, no one in the middle (the relay included) substituted a key.
Then H sends D the channel secret, encrypted to that key.

A six-digit number is only 20 bits, and a man in the middle who could choose
its keys after seeing both sides could grind through a million candidates in
a second. The commitment in step 1 prevents that. D fixes its key and nonce
before it sees H's, and H reveals its own before it sees D's. The attacker has
to choose for both sides before it knows the outcome, so its chance is one in
a million per attempt. This is the scheme Bluetooth's numeric comparison and
ZRTP use. Six digits replace the three words the epic proposed, because that
avoids a word list to ship, localise and keep identical on every platform.

### The code

D draws 40 random bits and shows them as eight Crockford base32 characters,
grouped in fours (`K7P2-QXM4`). The code is only an address on the relay and
is not a secret: the relay sees it. When a user types it in, H removes hyphens
and spaces, uppercases, and maps `I`/`L` to `1` and `O` to `0` before using it.

### Messages

D creates a fresh X25519 key pair `(dsk, dpk)` and a 32-byte nonce `nD` for
every pairing attempt, and H does the same with `(hsk, hpk)` and `nH`.

1. **D → relay, commit.** `commit = SHA-256("burnwatch/v1 pair-commit" || dpk || nD)`.
   The relay opens a mailbox under the code and refuses a code it already has.
2. **H → relay, hello.** H first reads the mailbox and **pins `commit`**, and
   only then posts `hpk`, `nH`. The relay accepts one hello per mailbox.
3. **D → relay, reveal.** D reads the mailbox, **pins the hello** it finds
   there, then posts `dpk`, `nD`.
4. **H checks** that `SHA-256("burnwatch/v1 pair-commit" || dpk || nD)` equals
   the commit it pinned in step 2, not whatever the mailbox holds now, and
   abandons the pairing if it does not.

The pinning is the whole defence, so no step may skip it. A man in the middle
learns D's number once D reveals. If H had sent its hello before fixing
`commit`, the attacker could pick `commit`, `dpk` and `nD` for H afterwards and
try candidates until H's number matched D's. That takes about a million
candidates, a second's work. With `commit` fixed before `nH` exists, the
attacker has to commit for H before it knows what H will send, and gets one
guess. Likewise D's number depends only on the hello D pinned, so a hello
swapped in later changes nothing D computes.

Both sides then compute:

```
transcript = SHA-256("burnwatch/v1 pair-transcript" || code || commit || hpk || nH || dpk || nD)
sas        = u32be(SHA-256("burnwatch/v1 pair-sas" || transcript)[0..4]) mod 1000000
shared     = X25519(own secret key, peer public key)
pair_key   = HKDF(shared, transcript, "burnwatch/v1 pair-key", 32)
```

`code` is the eight normalised ASCII characters. `sas` is shown zero-padded as
two groups of three digits (`048 213`).

5. **The user compares.** H shows the number with *Matches* and *Doesn't
   match*, and so does D. Either side cancelling deletes the mailbox.
6. **H → relay, seal.** H posts the seal only after the user confirms on H:

   ```
   seal      = 0x01 || nonce(12) || AES-256-GCM(pair_key, nonce, plaintext, aad)
   aad       = "burnwatch/v1 pair-seal " || transcript
   plaintext = UTF-8 JSON {"v": 1, "relay": "<relay base URL>", "secret": "<base64url S>"}
   ```

7. **D opens the seal** only after the user confirms on D. Then it stores `S`
   and the relay URL, and deletes the mailbox. The relay URL must be an
   `https:` URL with no credentials, query, fragment or IPv6
   literal host. Only `http://localhost`
   and `http://127.0.0.1` are allowed in the clear, for development. D refuses
   anything else.

A mailbox lives ten minutes from step 1, and the relay drops it after that
whatever state it is in.

Network failures are retried. Writing a slot again with exactly the value it
already holds succeeds, so a client whose reply was lost can repeat the
request. A 409 always means *someone else* filled the slot, and the pairing is
then abandoned. A 404 means the mailbox has expired or was cancelled.

## Relay API

The relay speaks JSON except for envelopes, which are
`application/octet-stream`. Tokens travel as `Authorization: Bearer
<base64url>`.

| Method and path | Who | Body | Replies |
|---|---|---|---|
| `PUT /v1/channels/{channel_id}` | H | `{"read_hash", "write_hash"}` | 201 created, 409 exists |
| `PUT /v1/channels/{channel_id}/state` | H, bearer `W` | envelope | 204 |
| `GET /v1/channels/{channel_id}/state` | D, bearer `read_token` | | 200 envelope, 404 none yet |
| `DELETE /v1/channels/{channel_id}` | H, bearer `W` | | 204 |
| `POST /v1/pair/{code}` | D | `{"commit"}` | 201, 409 code in use |
| `PUT /v1/pair/{code}/hello` | H | `{"hpk", "nonce"}` | 204, 404, 409 already set |
| `PUT /v1/pair/{code}/reveal` | D | `{"dpk", "nonce"}` | 204, 404, 409 already set |
| `PUT /v1/pair/{code}/seal` | H | envelope | 204, 404, 409 already set |
| `GET /v1/pair/{code}` | both | | 200 `{"commit", "hello"?, "reveal"?, "seal"?}`, 404 |
| `DELETE /v1/pair/{code}` | both | | 204 |

The hashes are base64url `SHA-256` of the raw token bytes. A wrong or missing
bearer gets 404, the same reply as a channel that does not exist, so the relay
does not confirm which channels exist. The limits (envelope size, request rate,
how long an idle channel lives) belong to the relay and are documented there.
A client treats 413 and 429 as "try later", never as data.

Every mailbox slot is write-once. Overwriting `hello` or `reveal` would let a
late attacker swap a key after the user has compared numbers.
