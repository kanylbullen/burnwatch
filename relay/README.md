# burnwatch relay

The mailbox from [`protocol/README.md`](../protocol/README.md): it lets a
desktop hub and a watch that have no server of their own exchange encrypted
state. It stores hashes of tokens, ciphertext, and the public half of pairings
in progress. It holds no key that opens any of it.

## Limits

| What | Limit | Reply past it |
|---|---|---|
| State envelope | 16 KiB | 413 |
| Mailbox slot body | 1 KiB | 413 |
| Requests per source address | 120 a minute | 429 |
| Channel or mailbox creations per address | 10 a minute | 429 |
| Idle channel | 8 days after its last write, then gone | 404 |
| Mailbox | 10 minutes after the commit, then gone | 404 |

An expired channel can be created again by the hub that owns it, since its id
comes from a secret the hub still holds. Paired devices keep working once it
publishes again.

## What the relay checks

- Ids, hashes, keys and nonces are **canonical** base64url of the right length.
  A value with a second spelling would let two strings name one channel.
- A **reveal** must match the mailbox's commitment. So a stranger who guesses
  a code cannot fill the slot with a key the device never committed to.
- Mailbox slots are **write-once** and **filled in order**: hello, then
  reveal, then seal. The `IS NULL` guard is in the `UPDATE` itself, so two
  racing writers cannot both win.
- A wrong or missing token gets **404**, the same as a channel that does not
  exist.

## Develop

```sh
bun test relay
npx wrangler dev -c relay/wrangler.jsonc
```

The tests run the real SQL against `bun:sqlite` through a small D1 shim
(`d1-shim.ts`). `index.ts` is only the Worker entry point: workerd refuses a module
whose named exports are not handlers, so the code and its constants live in
`relay.ts`.
