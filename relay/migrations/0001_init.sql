-- burnwatch relay schema (protocol/README.md).
--
-- The relay knows nothing it could leak: hashes of two tokens, ciphertext, and
-- the public half of a pairing in progress. Rows expire by time, checked on
-- every read and swept by a nightly cron, so an abandoned channel or pairing
-- goes away without anyone deleting it.

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT    NOT NULL PRIMARY KEY, -- base64url, 16 bytes
  read_hash  TEXT    NOT NULL,             -- base64url SHA-256 of read_token
  write_hash TEXT    NOT NULL,             -- base64url SHA-256 of W
  touched    INTEGER NOT NULL,             -- last create or state write
  state      BLOB                          -- the current envelope, or NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_touched ON channels (touched);

-- Each slot is write-once. A pairing code is an address, not a secret, so the
-- one thing a stranger who guesses it must not be able to do is replace a key
-- after the user has compared numbers.
CREATE TABLE IF NOT EXISTS mailboxes (
  code    TEXT    NOT NULL PRIMARY KEY, -- eight normalised Crockford characters
  created INTEGER NOT NULL,
  commit_ TEXT    NOT NULL,
  hello   TEXT,                         -- JSON {"hpk","nonce"}
  reveal  TEXT,                         -- JSON {"dpk","nonce"}
  seal    TEXT                          -- base64url envelope
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_created ON mailboxes (created);
