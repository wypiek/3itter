// Database setup using Node's built-in SQLite driver (no dependencies).
// Tables are created on first run; later versions add columns through small idempotent migrations.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Databases created before the rename to 3itter were called orbit.db.
const DB_FILE = path.join(DATA_DIR, '3itter.db');
const LEGACY_DB = path.join(DATA_DIR, 'orbit.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(LEGACY_DB)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(LEGACY_DB + ext)) fs.renameSync(LEGACY_DB + ext, DB_FILE + ext);
}
export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  location      TEXT NOT NULL DEFAULT '',
  website       TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  avatar        TEXT,
  banner        TEXT,
  avatar_shape  TEXT NOT NULL DEFAULT 'cookie9',
  hue           INTEGER NOT NULL DEFAULT 285,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text       TEXT NOT NULL DEFAULT '',
  image      TEXT,
  reply_to   INTEGER REFERENCES posts(id),
  quote_of   INTEGER REFERENCES posts(id),
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_reply  ON posts(reply_to);
CREATE INDEX IF NOT EXISTS posts_quote  ON posts(quote_of);
CREATE INDEX IF NOT EXISTS posts_time   ON posts(created_at DESC);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS reposts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS reposts_post ON reposts(post_id);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  post_id    INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, id DESC);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  read         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_pair ON messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS msg_recipient ON messages(recipient_id, read);

-- v2 -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS blocks (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS mutes (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',     -- open | resolved
  resolution  TEXT,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS reports_status ON reports(status, id DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Federation: other 3itter instances this one talks to.
CREATE TABLE IF NOT EXISTS peers (
  id          INTEGER PRIMARY KEY,
  domain      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  base_url    TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  public_key  TEXT NOT NULL,
  status      TEXT NOT NULL,    -- pending_out | pending_in | active | removed | blocked
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  last_error  TEXT
);
CREATE TABLE IF NOT EXISTS fed_outbox (
  id           INTEGER PRIMARY KEY,
  peer_id      INTEGER NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  activity     TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_next ON fed_outbox(next_attempt);
CREATE TABLE IF NOT EXISTS fed_seen (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);

-- v3 -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS polls (
  post_id    INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  options    TEXT NOT NULL,              -- JSON array of option labels
  multiple   INTEGER NOT NULL DEFAULT 0,
  ends_at    INTEGER NOT NULL,
  fed_counts TEXT                        -- remote polls: {"counts":[..],"voters":n} from the origin
);
CREATE TABLE IF NOT EXISTS poll_votes (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  choice     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id, choice)
);
CREATE TABLE IF NOT EXISTS post_edits (
  id        INTEGER PRIMARY KEY,
  post_id   INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  cw        TEXT NOT NULL DEFAULT '',
  edited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS post_edits_post ON post_edits(post_id, id);

-- v4: passkeys (WebAuthn credentials). Only public keys are stored.
CREATE TABLE IF NOT EXISTS passkeys (
  id         TEXT PRIMARY KEY,               -- credential ID (base64url)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,                  -- SPKI PEM
  alg        INTEGER NOT NULL,               -- COSE algorithm (-7 ES256, -8 EdDSA, -257 RS256)
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  name       TEXT NOT NULL DEFAULT 'Passkey',
  aaguid     TEXT NOT NULL DEFAULT '',
  backed_up  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);

-- v5: lists, scheduled posts, views, announcements, invites
CREATE TABLE IF NOT EXISTS lists (
  id          INTEGER PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  private     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lists_owner ON lists(owner_id);
CREATE TABLE IF NOT EXISTS list_members (
  list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX IF NOT EXISTS list_members_user ON list_members(user_id);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id         INTEGER PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload    TEXT NOT NULL,          -- JSON: text, cw, savedImages, sensitive, poll, replyPolicy, quoteOf
  publish_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | published | failed
  post_id    INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled_posts(status, publish_at);
CREATE TABLE IF NOT EXISTS post_views (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  viewer  TEXT NOT NULL,             -- user id, or a daily-salted hash for anonymous embeds
  day     INTEGER NOT NULL,
  PRIMARY KEY (post_id, viewer, day)
);
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  tone       TEXT NOT NULL DEFAULT 'info',   -- info | success | warning
  link       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT NOT NULL DEFAULT '',
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// users
addColumn('users', 'verified', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");          // user | moderator | admin
addColumn('users', 'suspended', 'INTEGER NOT NULL DEFAULT 0');       // 0 ok | 1 by staff | 2 instance defederated
addColumn('users', 'deleted_at', 'INTEGER');
addColumn('users', 'domain', 'TEXT');                                // NULL = local account
addColumn('users', 'pinned_post_id', 'INTEGER');
addColumn('users', 'dm_policy', "TEXT NOT NULL DEFAULT 'everyone'"); // everyone | following | none
addColumn('users', 'notif_prefs', "TEXT NOT NULL DEFAULT '{}'");
addColumn('users', 'language', 'TEXT');
addColumn('users', 'discoverable', 'INTEGER NOT NULL DEFAULT 1');
addColumn('users', 'fed_counts', 'TEXT');
addColumn('users', 'remote_avatar_src', 'TEXT');
addColumn('users', 'remote_banner_src', 'TEXT');
addColumn('users', 'fetched_at', 'INTEGER');
addColumn('users', 'pronouns', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'flags', "TEXT NOT NULL DEFAULT '[]'");
addColumn('users', 'muted_words', "TEXT NOT NULL DEFAULT '[]'");
addColumn('users', 'webauthn_id', 'TEXT');                         // stable WebAuthn user handle
// posts
addColumn('posts', 'remote_uri', 'TEXT');
addColumn('posts', 'fed_likes', 'INTEGER');
addColumn('posts', 'fed_reposts', 'INTEGER');
addColumn('posts', 'fed_replies', 'INTEGER');
addColumn('posts', 'images', 'TEXT');                                   // JSON [{src, alt}], up to 4
addColumn('posts', 'sensitive', 'INTEGER NOT NULL DEFAULT 0');          // blur media until tapped
addColumn('posts', 'cw', "TEXT NOT NULL DEFAULT ''");                   // content warning text
addColumn('posts', 'edited_at', 'INTEGER');
addColumn('posts', 'reply_policy', "TEXT NOT NULL DEFAULT 'everyone'"); // everyone | following | mentioned
addColumn('posts', 'views', 'INTEGER NOT NULL DEFAULT 0');
addColumn('posts', 'hidden_reply', 'INTEGER NOT NULL DEFAULT 0');          // hidden by the parent post's author
addColumn('users', 'invited_with', 'TEXT');
// sessions
addColumn('sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
addColumn('sessions', 'ip', "TEXT NOT NULL DEFAULT ''");
addColumn('sessions', 'last_used', 'INTEGER');

db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS posts_remote ON posts(remote_uri) WHERE remote_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_domain ON users(domain);
`);

// Prepared-statement cache helpers.
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
export const all = (sql, params = {}) => stmt(sql).all(params);
export const get = (sql, params = {}) => stmt(sql).get(params);
export const run = (sql, params = {}) => stmt(sql).run(params);

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}

export const getSetting = (key, fallback = null) => get('SELECT value FROM settings WHERE key = :key', { key })?.value ?? fallback;
export const setSetting = (key, value) => run(
  'INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  { key, value: String(value) },
);
