// store.js — SQLite storage for Chamber's chat (users, rooms, messages), one database per workspace (T-0017).
// Uses Node's built-in node:sqlite (Node 22.13+), so still zero npm dependencies.
//
// Why: the JSON file was rewritten in full on every message and capped at 500 messages. Now a message is one
// INSERT, history is unlimited, and reads are indexed. Tickets and reviews stay as JSON (small, CLI-driven).
//
// API kept deliberately close to the old file-based one so server.js barely changes:
//   load(file)            -> { users: {username: {...}}, rooms: {key: {...}}, messages: [last N, oldest first] }
//   save(file, data)      -> upserts users and rooms, inserts messages that are new since load()
//   messages(file, room, since, limit) -> [messages] (indexed query used by GET /api/messages)
// `file` is the path of the old chamber.json; the database lives beside it as chamber.db. On first open an existing
// chamber.json is imported once and renamed chamber.json.migrated.
//
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// T-0222: with the owner lock on, what people wrote is sealed in this database too: a message's text, its agent run record and its
// list of attached files, file names and room descriptions. The server sets the codec (setCodec); without one, or for a workspace
// without the lock, values pass through unchanged. Room names, people's names, times and folder names stay readable, as the owner
// was told. Each sealed value is bound to its row (message id, file id, room key), so values cannot be moved between rows unnoticed.
// While a workspace uses the lock, search reads and matches in memory instead of using the full-text index (which then holds
// only sealed text).
let codec = null;
function setCodec(c) { codec = c; }
const wsOf = file => (file ? path.basename(path.dirname(file)) : null);
const E = (file, where, v) => (v === null || v === undefined || !codec || !file) ? v : codec.enc(wsOf(file), where, String(v));
const D = (file, where, v) => (v === null || v === undefined || !codec || !file) ? v : codec.dec(wsOf(file), where, v);
const fileRow = (file, r) => (r ? { ...r, name: D(file, `f:${r.id}:name`, r.name) } : r);
const plainRow = (file, r) => ({ ...r, text: r.deleted ? '' : D(file, `m:${r.id}:text`, r.text), run: D(file, `m:${r.id}:run`, r.run), attachments: D(file, `m:${r.id}:att`, r.attachments) });

const LOAD_LIMIT = 1000;                                  // messages handed to handlers that still want the whole list
const dbs = new Map();                                    // db path -> DatabaseSync (one per workspace, kept open)
const lastUsed = new Map();                               // db path -> ms; maintenance() closes handles idle for an hour (T-0037)
const DEFAULT_ROOMS = { general: { name: 'General', topic: 'Main chamber for AI coordination' } };

function dbPathFor(file) { return path.join(path.dirname(file), path.basename(file, '.json') + '.db'); }

function open(file) {
  const p = dbPathFor(file);
  lastUsed.set(p, Date.now());
  if (dbs.has(p)) return dbs.get(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, role TEXT NOT NULL, lastSeen INTEGER NOT NULL DEFAULT 0, joinedAt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rooms (key TEXT PRIMARY KEY, name TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', dm TEXT);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room TEXT NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL,
      ts INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'message', mentions TEXT NOT NULL DEFAULT '[]');
    CREATE INDEX IF NOT EXISTS messages_room_ts ON messages (room, ts);
    CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT,
      by TEXT NOT NULL, ts INTEGER NOT NULL, room TEXT, msg_id TEXT);
    CREATE INDEX IF NOT EXISTS files_msg ON files (msg_id);
    CREATE INDEX IF NOT EXISTS files_room_ts ON files (room, ts);`);                                  // T-0064: uploads (blobs live beside the db in files/)
  // T-0035: edit/delete columns (added to existing databases on first open) and a full-text index kept in step by triggers.
  const ucols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!ucols.has('prefs')) db.exec('ALTER TABLE users ADD COLUMN prefs TEXT');                  // T-0072: per-person preferences agents may read (JSON)
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
  if (!cols.has('edited')) db.exec('ALTER TABLE messages ADD COLUMN edited INTEGER');
  if (!cols.has('deleted')) db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER');
  if (!cols.has('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to TEXT');          // T-0049
  if (!cols.has('source')) db.exec('ALTER TABLE messages ADD COLUMN source TEXT');              // T-0058: schedule:<id> | webhook:<id>
  if (!cols.has('attachments')) db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');    // T-0064: JSON [{id, name, mime, size}]
  const fcols = new Set(db.prepare('PRAGMA table_info(files)').all().map(c => c.name));          // T-0149: folders are metadata only (no on-disk moves)
  if (!fcols.has('folder')) db.exec('ALTER TABLE files ADD COLUMN folder TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, by TEXT, ts INTEGER)');    // T-0149: so an empty folder exists before anything is put in it
  if (!cols.has('run')) db.exec('ALTER TABLE messages ADD COLUMN run TEXT');                    // T-0071: an agent's progress record {state, steps, tools, ...}
  if (!cols.has('updated')) db.exec('ALTER TABLE messages ADD COLUMN updated INTEGER');         // T-0071: last change of any kind (edit, delete, run), drives since= polling
  if (!cols.has('pinned')) db.exec('ALTER TABLE messages ADD COLUMN pinned TEXT');              // T-0069: JSON {by, at} when pinned in its room
  if (!cols.has('reactions')) db.exec('ALTER TABLE messages ADD COLUMN reactions TEXT');        // T-0070: JSON {emoji: [usernames]}
  if (!cols.has('seq')) db.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');                 // T-0086: monotonic, never-reused cursor for connector polling (forward-only, VACUUM-safe)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF text ON messages BEGIN INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
  if (db.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 0 && db.prepare('SELECT COUNT(*) AS n FROM messages_fts').get().n === 0) db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");   // index history once
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
  dbs.set(p, db);
  migrate(db, file);
  if (db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n === 0) {
    for (const [k, r] of Object.entries(DEFAULT_ROOMS)) db.prepare('INSERT INTO rooms (key, name, topic, dm) VALUES (?, ?, ?, NULL)').run(k, r.name, r.topic);
  }
  // T-0086: give every row a monotonic seq (backfills existing rows and any fresh JSON import), and keep a durable counter
  // that only ever climbs — immune to row deletion and VACUUM — so connectors can poll with a forward-only cursor.
  db.exec('UPDATE messages SET seq = rowid WHERE seq IS NULL');
  db.exec('CREATE INDEX IF NOT EXISTS messages_room_seq ON messages (room, seq)');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, val INTEGER NOT NULL)');
  db.exec("INSERT OR IGNORE INTO meta (key, val) VALUES ('messages_seq', 0)");
  { const mx = db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages').get().m;
    db.prepare("UPDATE meta SET val = ? WHERE key = 'messages_seq' AND val < ?").run(mx, mx); }
  return db;
}

// One-time import of the old JSON store, so no history is lost when a workspace moves to SQLite.
function migrate(db, file) {
  if (!fs.existsSync(file)) return;
  let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  if (n === 0) {
    db.exec('BEGIN');
    try {
      const uu = db.prepare('INSERT OR REPLACE INTO users (username, role, lastSeen, joinedAt) VALUES (?, ?, ?, ?)');
      for (const u of Object.values(old.users || {})) uu.run(u.username, u.role || 'ai', u.lastSeen || 0, u.joinedAt || 0);
      const ru = db.prepare('INSERT OR REPLACE INTO rooms (key, name, topic, dm) VALUES (?, ?, ?, ?)');
      for (const [k, r] of Object.entries(old.rooms || {})) ru.run(k, r.name || k, E(file, `r:${k}:topic`, r.topic || ''), Array.isArray(r.dm) ? JSON.stringify(r.dm) : null);
      const mi = db.prepare('INSERT OR IGNORE INTO messages (id, room, username, text, ts, type, mentions, reply_to, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const m of old.messages || []) mi.run(String(m.id), m.room || 'general', m.username, m.text || '', m.ts || 0, m.type || 'message', JSON.stringify(m.mentions || []), m.reply_to || null, m.source || null);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  fs.renameSync(file, file + '.migrated');
  console.log(`[store] imported ${path.basename(file)} into SQLite (${(old.messages || []).length} messages)`);
}

function rowToMsg(r, file) {
  const m = { id: r.id, room: r.room, username: r.username, text: r.deleted ? '' : D(file, `m:${r.id}:text`, r.text), ts: r.ts, type: r.type, mentions: JSON.parse(r.mentions || '[]') };
  if (r.seq != null) m.seq = r.seq;                                                                                 // T-0086
  if (r.edited) m.edited = r.edited;
  if (r.deleted) m.deleted = true;
  if (r.reply_to) m.reply_to = r.reply_to;   // T-0049
  if (r.source) m.source = r.source;         // T-0058
  if (r.attachments && !r.deleted) { try { m.attachments = JSON.parse(D(file, `m:${r.id}:att`, r.attachments)); } catch { /* ignore */ } }   // T-0064
  if (r.run && !r.deleted) { try { m.run = JSON.parse(D(file, `m:${r.id}:run`, r.run)); } catch { /* ignore */ } }                            // T-0071
  if (r.updated) m.updated = r.updated;                                                                              // T-0071
  if (r.pinned && !r.deleted) { try { m.pinned = JSON.parse(r.pinned); } catch { /* ignore */ } }                      // T-0069
  if (r.reactions && !r.deleted) { try { const x = JSON.parse(r.reactions); if (x && Object.keys(x).length) m.reactions = x; } catch { /* ignore */ } }   // T-0070
  return m;
}

function load(file) {
  const db = open(file);
  const users = {}; for (const u of db.prepare('SELECT * FROM users').all()) { users[u.username] = { username: u.username, role: u.role, lastSeen: u.lastSeen, joinedAt: u.joinedAt }; if (u.prefs) { try { users[u.username].prefs = JSON.parse(u.prefs); } catch { /* ignore */ } } }   // T-0072
  const rooms = {}; for (const r of db.prepare('SELECT * FROM rooms').all()) { rooms[r.key] = { name: r.name, topic: D(file, `r:${r.key}:topic`, r.topic) }; if (r.dm) rooms[r.key].dm = JSON.parse(r.dm); }
  const messages = db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC').all(LOAD_LIMIT).map(r => rowToMsg(r, file));
  const data = { users, rooms, messages };
  Object.defineProperty(data, '__known', { value: new Set(messages.map(m => m.id)), enumerable: false });   // what save() must not re-insert
  return data;
}

// T-0076: a lightweight load for the hot routes (ping, presence, prefs, room ops, posting) that need only users and
// rooms, never the message history. Skips the LIMIT-1000 message read. messages starts empty and __known empty, so
// postMessage pushes exactly one new row and save() inserts only that row (INSERT OR IGNORE still guards dup ids).
// Routes that genuinely want history call load() (server-side: loadDataFull) instead.
function loadLight(file) {
  const db = open(file);
  const users = {}; for (const u of db.prepare('SELECT * FROM users').all()) { users[u.username] = { username: u.username, role: u.role, lastSeen: u.lastSeen, joinedAt: u.joinedAt }; if (u.prefs) { try { users[u.username].prefs = JSON.parse(u.prefs); } catch { /* ignore */ } } }
  const rooms = {}; for (const r of db.prepare('SELECT * FROM rooms').all()) { rooms[r.key] = { name: r.name, topic: D(file, `r:${r.key}:topic`, r.topic) }; if (r.dm) rooms[r.key].dm = JSON.parse(r.dm); }
  const data = { users, rooms, messages: [] };
  Object.defineProperty(data, '__known', { value: new Set(), enumerable: false });
  return data;
}

function save(file, data) {
  const db = open(file);
  db.exec('BEGIN');
  try {
    const uu = db.prepare('INSERT INTO users (username, role, lastSeen, joinedAt, prefs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET role = excluded.role, lastSeen = excluded.lastSeen, joinedAt = excluded.joinedAt, prefs = excluded.prefs');
    for (const u of Object.values(data.users || {})) uu.run(u.username, u.role || 'ai', u.lastSeen || 0, u.joinedAt || 0, u.prefs ? JSON.stringify(u.prefs) : null);   // T-0072: prefs
    const ru = db.prepare('INSERT INTO rooms (key, name, topic, dm) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, topic = excluded.topic, dm = excluded.dm');
    for (const [k, r] of Object.entries(data.rooms || {})) ru.run(k, r.name || k, E(file, `r:${k}:topic`, r.topic || ''), Array.isArray(r.dm) ? JSON.stringify(r.dm) : null);
    const known = data.__known || new Set();
    const bumpSeq = db.prepare("UPDATE meta SET val = val + 1 WHERE key = 'messages_seq'");       // T-0086: next monotonic seq
    const readSeq = db.prepare("SELECT val FROM meta WHERE key = 'messages_seq'");
    const mi = db.prepare('INSERT OR IGNORE INTO messages (id, room, username, text, ts, type, mentions, reply_to, source, attachments, run, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of data.messages || []) if (!known.has(m.id)) { bumpSeq.run(); const seq = readSeq.get().val; mi.run(String(m.id), m.room || 'general', m.username, E(file, `m:${m.id}:text`, m.text || ''), m.ts || 0, m.type || 'message', JSON.stringify(m.mentions || []), m.reply_to || null, m.source || null, Array.isArray(m.attachments) && m.attachments.length ? E(file, `m:${m.id}:att`, JSON.stringify(m.attachments)) : null, m.run ? E(file, `m:${m.id}:run`, JSON.stringify(m.run)) : null, seq); known.add(m.id); }   // T-0064/T-0071/T-0086
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function messages(file, room, since, limit = 500) {
  const db = open(file); since = since || 0;
  return db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room = ? AND (ts > ? OR COALESCE(updated, 0) > ? OR COALESCE(edited, 0) > ? OR COALESCE(deleted, 0) > ?) ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC').all(room, since, since, since, since, limit).map(r => rowToMsg(r, file));
}
function messagesSince(file, room, sinceSeq, limit = 500) {   // T-0086: forward-only cursor for connectors; returns only genuinely new posts (seq strictly greater), never an edited/reacted old message
  const db = open(file); sinceSeq = sinceSeq || 0;
  return db.prepare('SELECT * FROM messages WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(room, sinceSeq, Math.min(limit, 500)).map(r => rowToMsg(r, file));
}
function maxSeq(file, room) {   // T-0086: the room's current highest seq, so a connector can init its cursor and advance even on an empty poll
  return open(file).prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE room = ?').get(room).m;
}
function before(file, room, beforeTs, limit = 200) {                 // T-0035: older history, newest-first window then chronological
  const db = open(file);
  return db.prepare('SELECT * FROM (SELECT * FROM messages WHERE room = ? AND ts < ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC').all(room, beforeTs, Math.min(limit, 500)).map(r => rowToMsg(r, file));
}
function runsSince(file, sinceTs, limit = 20000) {                       // T-0194: agent answers with a run record (model, tokens, time, cost), oldest first
  return open(file).prepare('SELECT * FROM messages WHERE run IS NOT NULL AND ts >= ? ORDER BY ts DESC LIMIT ?').all(Number(sinceTs) || 0, limit).reverse().map(r => rowToMsg(r, file)).filter(m => !m.deleted);
}
function setPrefs(file, username, prefs) { open(file).prepare('UPDATE users SET prefs = ? WHERE username = ?').run(prefs ? JSON.stringify(prefs) : null, String(username)); }   // T-0072
function get(file, id) { const r = open(file).prepare('SELECT * FROM messages WHERE id = ?').get(String(id)); return r ? rowToMsg(r, file) : null; }
// T-0071: one place for every change to an existing message. `updated` is bumped on each call so since= polling and the
// live-event path pick the change up; `edited` (the "(edited)" label) is set only when the caller says so — a person's
// correction yes, an agent's progress tick no. Pass `run: null` to clear a run record.
function update(file, id, { text, type, run, mentions, pinned, markEdited } = {}) {
  const db = open(file); const now = Date.now(); const sets = ['updated = ?'], vals = [now];
  if (text !== undefined) { sets.push('text = ?'); vals.push(E(file, `m:${id}:text`, text)); }
  if (type !== undefined) { sets.push('type = ?'); vals.push(type); }
  if (run !== undefined) { sets.push('run = ?'); vals.push(run === null ? null : E(file, `m:${id}:run`, JSON.stringify(run))); }
  if (mentions !== undefined) { sets.push('mentions = ?'); vals.push(JSON.stringify(mentions)); }
  if (pinned !== undefined) { sets.push('pinned = ?'); vals.push(pinned === null ? null : JSON.stringify(pinned)); }   // T-0069
  if (markEdited) { sets.push('edited = ?'); vals.push(now); }
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND deleted IS NULL`).run(...vals, String(id));
  return get(file, id);
}
function edit(file, id, text) { return update(file, id, { text, markEdited: true }); }   // T-0035: returns the updated message or null
function remove(file, id) {                                          // T-0035: soft delete; the row stays so clients can blank it out
  const db = open(file); const now = Date.now();
  db.prepare("UPDATE messages SET text = '', deleted = ?, updated = ? WHERE id = ?").run(now, now, String(id));
  return get(file, id);
}
function ftsQuery(q) {                                               // user text -> safe FTS5 query: every word quoted, AND-ed, last word as prefix
  const words = String(q || '').replace(/["*^]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return null;
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}
function search(file, q, rooms, limit = 50, filters = {}) {           // T-0035: rooms = array the caller may see (already filtered); T-0069: operators
  if (codec && codec.active(wsOf(file))) return searchScan(file, q, rooms, limit, filters);   // T-0222
  const fq = ftsQuery(q); if (!rooms.length) return [];
  const db = open(file);
  const where = ['m.deleted IS NULL', `m.room IN (${rooms.map(() => '?').join(',')})`], vals = [...rooms];
  if (filters.from) { where.push('LOWER(m.username) = ?'); vals.push(String(filters.from).toLowerCase()); }
  if (filters.after) { where.push('m.ts > ?'); vals.push(+filters.after); }
  if (filters.before) { where.push('m.ts < ?'); vals.push(+filters.before); }
  if (filters.has === 'file') where.push('m.attachments IS NOT NULL');
  if (filters.has === 'code') where.push("m.text LIKE '%```%'");
  if (filters.has === 'link') where.push("m.text LIKE '%http%'");
  if (!fq && where.length === 2) return [];                              // nothing to search for
  try {
    const sql = fq ? `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ?`
                   : `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT ?`;
    return db.prepare(sql).all(...(fq ? [fq] : []), ...vals, Math.min(limit, 200)).map(r => rowToMsg(r, file));
  } catch (e) { console.error('[store] search:', e.message); return []; }
}
// T-0222: search while the workspace uses the owner lock. Same filters as the indexed search; the words are matched in memory
// against the opened text of the newest 20,000 messages in the rooms the person may see (every word must appear; a word may be
// part of a longer one).
function searchScan(file, q, rooms, limit = 50, filters = {}) {
  if (!rooms.length) return [];
  const words = String(q || '').toLowerCase().replace(/["*^]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 8);
  const db = open(file), where = ['m.deleted IS NULL', `m.room IN (${rooms.map(() => '?').join(',')})`], vals = [...rooms];
  if (filters.from) { where.push('LOWER(m.username) = ?'); vals.push(String(filters.from).toLowerCase()); }
  if (filters.after) { where.push('m.ts > ?'); vals.push(+filters.after); }
  if (filters.before) { where.push('m.ts < ?'); vals.push(+filters.before); }
  if (filters.has === 'file') where.push('m.attachments IS NOT NULL');
  if (!words.length && where.length === 2 && filters.has !== 'code' && filters.has !== 'link') return [];
  const out = [], max = Math.min(limit, 200);
  try {
    for (const r of db.prepare(`SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.ts DESC LIMIT 20000`).all(...vals)) {
      const m = rowToMsg(r, file), t = String(m.text || '').toLowerCase();
      if (words.length && !words.every(w => t.includes(w))) continue;
      if (filters.has === 'code' && !t.includes('```')) continue;
      if (filters.has === 'link' && !t.includes('http')) continue;
      out.push(m); if (out.length >= max) break;
    }
  } catch (e) { if (e.locked) throw e; console.error('[store] search:', e.message); return []; }
  return out;
}
// T-0222: seal (direction 'seal') or unseal the sealed columns. Messages a batch at a time (the server yields in between);
// then file names, room descriptions, the search index, and when sealing a clean rewrite of the database file (VACUUM), so no
// page of it still holds text from before. A value that merely looks sealed but does not open is sealed around, never lost.
function convertValue(ws, where, v, direction) {                      // -> the new value, or undefined when it stays as it is
  if (v === null || v === undefined || v === '') return undefined;
  const sealedNow = typeof v === 'string' && v.startsWith('enc:v1:') && codec.opens(ws, where, v);
  if (direction === 'seal') return sealedNow ? undefined : codec.seal(ws, where, String(v));
  return sealedNow ? codec.open(ws, where, v) : undefined;
}
function convertChatBatch(file, direction, after = 0, batch = 500) {
  const db = open(file), ws = wsOf(file); let changed = 0;
  const rows = db.prepare('SELECT rowid, id, text, run, attachments FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?').all(after, batch);
  const up = db.prepare('UPDATE messages SET text = ?, run = ?, attachments = ? WHERE rowid = ?');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const t = convertValue(ws, `m:${r.id}:text`, r.text, direction), u = convertValue(ws, `m:${r.id}:run`, r.run, direction), a = convertValue(ws, `m:${r.id}:att`, r.attachments, direction);
      if (t === undefined && u === undefined && a === undefined) continue;
      up.run(t === undefined ? r.text : t, u === undefined ? r.run : u, a === undefined ? r.attachments : a, r.rowid); changed++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  return { last: rows.length ? rows[rows.length - 1].rowid : after, done: rows.length < batch, changed };
}
function convertChatRest(file, direction) {
  const db = open(file), ws = wsOf(file); let changed = 0;
  db.exec('BEGIN');
  try {
    const uf = db.prepare('UPDATE files SET name = ? WHERE id = ?');
    for (const r of db.prepare('SELECT id, name FROM files').all()) { const v = convertValue(ws, `f:${r.id}:name`, r.name, direction); if (v !== undefined) { uf.run(v, r.id); changed++; } }
    const ur = db.prepare('UPDATE rooms SET topic = ? WHERE key = ?');
    for (const r of db.prepare('SELECT key, topic FROM rooms').all()) { const v = convertValue(ws, `r:${r.key}:topic`, r.topic, direction); if (v !== undefined) { ur.run(v, r.key); changed++; } }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
  if (direction === 'seal') db.exec('VACUUM');
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  return changed;
}
function toggleReaction(file, id, user, emoji) {                       // T-0070: add or remove one person's reaction; returns the message
  const db = open(file); db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('SELECT reactions, deleted FROM messages WHERE id = ?').get(String(id)); if (!r || r.deleted) { db.exec('ROLLBACK'); return null; }
    let x = {}; try { x = JSON.parse(r.reactions || '{}') || {}; } catch { x = {}; }
    const list = x[emoji] || []; const i = list.indexOf(user);
    if (i >= 0) list.splice(i, 1); else list.push(user);
    if (list.length) x[emoji] = list; else delete x[emoji];
    db.prepare('UPDATE messages SET reactions = ?, updated = ? WHERE id = ?').run(Object.keys(x).length ? JSON.stringify(x) : null, Date.now(), String(id));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return get(file, id);
}
function repliesTo(file, id, max = 200) {                             // T-0070: every message under a root, in time order (replies of replies included)
  const db = open(file); const out = []; let frontier = [String(id)]; const seen = new Set(frontier);
  for (let depth = 0; depth < 20 && frontier.length && out.length < max; depth++) {
    const rows = db.prepare(`SELECT * FROM messages WHERE reply_to IN (${frontier.map(() => '?').join(',')}) ORDER BY ts ASC`).all(...frontier);
    frontier = [];
    for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); out.push(rowToMsg(r, file)); frontier.push(r.id); }
  }
  return out.sort((a, b) => a.ts - b.ts).slice(0, max);
}
function pinnedIn(file, room, limit = 50) {                           // T-0069: a room's pinned messages, newest pin first
  return open(file).prepare('SELECT * FROM messages WHERE room = ? AND pinned IS NOT NULL AND deleted IS NULL ORDER BY ts DESC LIMIT ?').all(room, limit).map(r => rowToMsg(r, file));
}

// T-0037: called hourly by server.js. Checkpoints every open database (so the -wal file does not grow between
// backups), closes handles nobody used for an hour, and applies message retention where a workspace asked for it.
function maintenance(idleMs = 3600e3) {
  const out = { checkpointed: 0, closed: 0 };
  for (const [p, db] of [...dbs]) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); out.checkpointed++; } catch (e) { console.error('[store] checkpoint', p, e.message); }
    if (Date.now() - (lastUsed.get(p) || 0) > idleMs) { try { db.close(); } catch {} dbs.delete(p); lastUsed.delete(p); out.closed++; }
  }
  return out;
}
function retention(file, days, onFiles) {                            // delete messages older than `days`; returns how many went
  if (!days || days < 1) return 0;
  const db = open(file); const cutoff = Date.now() - days * 86400e3;
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE ts < ?').get(cutoff).n;
  const old = db.prepare('SELECT * FROM files WHERE ts < ?').all(cutoff);                    // T-0064: their uploads go too
  if (old.length) { if (onFiles) onFiles(old); db.prepare('DELETE FROM files WHERE ts < ?').run(cutoff); }
  if (n) { db.prepare('DELETE FROM messages WHERE ts < ?').run(cutoff); try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {} }
  return n;
}
// ── Files (T-0064). A row per upload; the bytes live in <ws dir>/files/<id>. `room` is set at upload time so access
// checks work before the file is attached to a message; `msg_id` is filled when the message is posted.
// ── Archives (T-0112). Pick a room's messages older than a cutoff (raw rows, oldest first) and, once the sealed archive
// is safely written and re-read, delete exactly those rows. Uploads are NOT touched: their files rows keep msg_id, so
// the orphan sweep never takes them and the Files tab still lists them.
function archivePick(file, room, beforeTs, limit = 20000) {
  return open(file).prepare('SELECT * FROM messages WHERE room = ? AND ts < ? ORDER BY ts ASC, id ASC LIMIT ?').all(String(room), beforeTs, limit).map(r => plainRow(file, r));
}
function archiveRemove(file, ids) {
  const db = open(file); const del = db.prepare('DELETE FROM messages WHERE id = ?'); let n = 0;
  db.exec('BEGIN');
  try { for (const id of ids) n += Number(del.run(String(id)).changes); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  return n;
}
function archiveRowToMsg(r) { return rowToMsg(r, null); }   // archive rows are stored plain inside the (sealed) archive
function fileAdd(file, rec) {
  open(file).prepare('INSERT INTO files (id, name, mime, size, sha256, by, ts, room, msg_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
    .run(rec.id, E(file, `f:${rec.id}:name`, rec.name), rec.mime, rec.size, rec.sha256 || null, rec.by, rec.ts, rec.room || null);
  return fileGet(file, rec.id);
}
function fileGet(file, id) { return fileRow(file, open(file).prepare('SELECT * FROM files WHERE id = ?').get(String(id))) || null; }
function filesAttach(file, ids, room, msgId) {
  const st = open(file).prepare('UPDATE files SET msg_id = ?, room = ? WHERE id = ? AND msg_id IS NULL');
  for (const id of ids) st.run(String(msgId), room, String(id));
}
function filesForMsg(file, msgId) { return open(file).prepare('SELECT * FROM files WHERE msg_id = ?').all(String(msgId)).map(r => fileRow(file, r)); }
function filesList(file, room, limit = 200, folder) {   // T-0149: folder undefined = everything; '' = top level only; 'a/b' = that folder only
  const db = open(file); const where = ['msg_id IS NOT NULL'], vals = [];
  if (room) { where.push('room = ?'); vals.push(room); }
  if (folder === '') where.push('folder IS NULL'); else if (folder) { where.push('folder = ?'); vals.push(folder); }
  return db.prepare(`SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...vals, limit).map(r => fileRow(file, r));
}
// ── Folders (T-0149). A folder is a path-like label on the file row ('installers/pi'); the bytes never move. The folders
// table only exists so an empty folder can be created first; the list below merges both and adds implied parents.
function fileSetFolder(file, id, folder) { open(file).prepare('UPDATE files SET folder = ? WHERE id = ?').run(folder || null, String(id)); }
function foldersList(file) {
  const db = open(file); const out = new Map();
  for (const r of db.prepare('SELECT path FROM folders').all()) out.set(r.path, 0);
  for (const r of db.prepare('SELECT folder, COUNT(*) AS n FROM files WHERE folder IS NOT NULL AND msg_id IS NOT NULL GROUP BY folder').all()) out.set(r.folder, r.n);
  for (const p of [...out.keys()]) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) { const anc = parts.slice(0, i).join('/'); if (!out.has(anc)) out.set(anc, 0); } }
  return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, n]) => ({ path, files: n }));
}
function folderAdd(file, p, by, ts) { open(file).prepare('INSERT OR IGNORE INTO folders (path, by, ts) VALUES (?, ?, ?)').run(p, by || null, ts || Date.now()); }
const likeUnder = p => p.replace(/[\\%_]/g, '\\$&') + '/%';   // everything strictly below a folder
function folderRename(file, from, to) {                       // moves the folder and everything under it; returns how many files moved
  const db = open(file); db.exec('BEGIN');
  try {
    const n = db.prepare("UPDATE files SET folder = ? || substr(folder, ?) WHERE folder = ? OR folder LIKE ? ESCAPE '\\'").run(to, from.length + 1, from, likeUnder(from)).changes;
    const rows = db.prepare("SELECT path, by, ts FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\'").all(from, likeUnder(from));
    const del = db.prepare('DELETE FROM folders WHERE path = ?'), ins = db.prepare('INSERT OR IGNORE INTO folders (path, by, ts) VALUES (?, ?, ?)');
    for (const r of rows) { del.run(r.path); ins.run(to + r.path.slice(from.length), r.by, r.ts); }
    ins.run(to, null, Date.now()); db.exec('COMMIT'); return n;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function folderDelete(file, p, mode) {                        // mode 'parent' moves contents up one level; anything else refuses a non-empty folder
  const db = open(file);
  const files = db.prepare("SELECT id, folder FROM files WHERE folder = ? OR folder LIKE ? ESCAPE '\\'").all(p, likeUnder(p));
  if (files.length && mode !== 'parent') return { refused: true, files: files.length };
  const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : null;
  const lift = f => { const rest = f.slice(p.length); return rest ? (parent ? parent + rest : rest.slice(1)) : parent; };   // 'p/x' -> 'parent/x' or 'x'; 'p' -> parent
  db.exec('BEGIN');
  try {
    const up = db.prepare('UPDATE files SET folder = ? WHERE id = ?'); for (const f of files) up.run(lift(f.folder), f.id);
    const rows = db.prepare("SELECT path, by, ts FROM folders WHERE path = ? OR path LIKE ? ESCAPE '\\'").all(p, likeUnder(p));
    const del = db.prepare('DELETE FROM folders WHERE path = ?'), ins = db.prepare('INSERT OR IGNORE INTO folders (path, by, ts) VALUES (?, ?, ?)');
    for (const r of rows) { del.run(r.path); const np = r.path === p ? null : lift(r.path); if (np) ins.run(np, r.by, r.ts); }
    db.exec('COMMIT'); return { refused: false, files: files.length, folders: rows.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function attachmentRemoved(file, msgId, fileId) {             // T-0149: the message stays; its chip becomes '(file removed)'
  const db = open(file); const r = db.prepare('SELECT attachments FROM messages WHERE id = ?').get(String(msgId)); if (!r || !r.attachments) return null;
  let atts; try { atts = JSON.parse(D(file, `m:${msgId}:att`, r.attachments)); } catch { return null; }
  atts = atts.map(a => a.id === fileId ? { ...a, removed: true } : a);
  db.prepare('UPDATE messages SET attachments = ?, updated = ? WHERE id = ?').run(E(file, `m:${msgId}:att`, JSON.stringify(atts)), Date.now(), String(msgId));
  return get(file, msgId);
}
function filesOrphans(file, olderThanTs) { return open(file).prepare('SELECT * FROM files WHERE msg_id IS NULL AND ts < ?').all(olderThanTs).map(r => fileRow(file, r)); }
function fileDelete(file, id) { open(file).prepare('DELETE FROM files WHERE id = ?').run(String(id)); }
function filesBytes(file) { return open(file).prepare('SELECT COALESCE(SUM(size), 0) AS b, COUNT(*) AS n FROM files').get(); }
function deleteWorkspaceDb(file) {                       // used when a workspace is deleted (the directory is removed anyway)
  const p = dbPathFor(file); const db = dbs.get(p); if (db) { try { db.close(); } catch {} dbs.delete(p); }
}

// T-0079: write an exported chat (users, rooms, messages) back into a workspace db, KEEPING every id so permalinks
// survive. Unlike save() this restores every field the export carries — reactions, pins, edits, deletes, reply_to,
// attachments, run, updated — and assigns a fresh monotonic seq in time order so the connector cursor stays forward-only.
// Intended for an empty workspace (the route enforces that); INSERT OR IGNORE makes a re-run a no-op rather than a dup.
function importChat(file, chat) {
  const db = open(file);
  db.exec('BEGIN');
  try {
    const uu = db.prepare('INSERT INTO users (username, role, lastSeen, joinedAt, prefs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET role = excluded.role, lastSeen = excluded.lastSeen, joinedAt = excluded.joinedAt, prefs = excluded.prefs');
    for (const u of Object.values(chat.users || {})) uu.run(u.username, u.role || 'ai', u.lastSeen || 0, u.joinedAt || 0, u.prefs ? JSON.stringify(u.prefs) : null);
    const ru = db.prepare('INSERT INTO rooms (key, name, topic, dm) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, topic = excluded.topic, dm = excluded.dm');
    for (const [k, r] of Object.entries(chat.rooms || {})) ru.run(k, r.name || k, E(file, `r:${k}:topic`, r.topic || ''), Array.isArray(r.dm) ? JSON.stringify(r.dm) : null);
    const bump = db.prepare("UPDATE meta SET val = val + 1 WHERE key = 'messages_seq'");
    const rd = db.prepare("SELECT val FROM meta WHERE key = 'messages_seq'");
    const mi = db.prepare('INSERT OR IGNORE INTO messages (id, room, username, text, ts, type, mentions, reply_to, source, attachments, run, edited, deleted, updated, pinned, reactions, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const msgs = (chat.messages || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));   // oldest first, so seq order matches time order
    let n = 0;
    for (const m of msgs) {
      bump.run(); const seq = rd.get().val;
      const info = mi.run(String(m.id), m.room || 'general', m.username || 'unknown', m.deleted ? '' : E(file, `m:${m.id}:text`, m.text || ''), m.ts || 0, m.type || 'message',
        JSON.stringify(m.mentions || []), m.reply_to || null, m.source || null,
        (Array.isArray(m.attachments) && m.attachments.length) ? E(file, `m:${m.id}:att`, JSON.stringify(m.attachments)) : null,
        m.run ? E(file, `m:${m.id}:run`, JSON.stringify(m.run)) : null, m.edited || null, m.deleted ? (m.updated || m.ts || Date.now()) : null, m.updated || null,
        m.pinned ? JSON.stringify(m.pinned) : null, (m.reactions && Object.keys(m.reactions).length) ? JSON.stringify(m.reactions) : null, seq);
      if (info.changes) n++;
    }
    db.exec('COMMIT');
    return { users: Object.keys(chat.users || {}).length, rooms: Object.keys(chat.rooms || {}).length, messages: n };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// T-0079: restore file metadata rows (the bytes themselves come from an optional tar, handled by the caller).
function importFiles(file, files) {
  const db = open(file); const ins = db.prepare('INSERT OR IGNORE INTO files (id, name, mime, size, sha256, by, ts, room, msg_id, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0; db.exec('BEGIN');
  try { for (const f of files || []) { const info = ins.run(String(f.id), E(file, `f:${f.id}:name`, f.name || ''), f.mime || 'application/octet-stream', f.size || 0, f.sha256 || null, f.by || '', f.ts || 0, f.room || null, f.msg_id || null, f.folder || null); if (info.changes) n++; } db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}
// T-0102: atomic workspace import — users, rooms, messages AND file metadata in ONE transaction, so a failure
// anywhere rolls the whole workspace back to empty (F2). Faithfully mirrors importChat+importFiles but shares the txn.
// File BYTES are not written here: the JSON export carries metadata only; blobs travel via the backup's files/ dir.
function importWorkspaceData(file, chat, files) {
  const db = open(file);
  db.exec('BEGIN');
  try {
    const uu = db.prepare('INSERT INTO users (username, role, lastSeen, joinedAt, prefs) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET role = excluded.role, lastSeen = excluded.lastSeen, joinedAt = excluded.joinedAt, prefs = excluded.prefs');
    for (const u of Object.values((chat && chat.users) || {})) uu.run(u.username, u.role || 'ai', u.lastSeen || 0, u.joinedAt || 0, u.prefs ? JSON.stringify(u.prefs) : null);
    const ru = db.prepare('INSERT INTO rooms (key, name, topic, dm) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name, topic = excluded.topic, dm = excluded.dm');
    for (const [k, r] of Object.entries((chat && chat.rooms) || {})) ru.run(k, r.name || k, E(file, `r:${k}:topic`, r.topic || ''), Array.isArray(r.dm) ? JSON.stringify(r.dm) : null);
    const bump = db.prepare("UPDATE meta SET val = val + 1 WHERE key = 'messages_seq'");
    const rd = db.prepare("SELECT val FROM meta WHERE key = 'messages_seq'");
    const mi = db.prepare('INSERT OR IGNORE INTO messages (id, room, username, text, ts, type, mentions, reply_to, source, attachments, run, edited, deleted, updated, pinned, reactions, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const msgs = ((chat && chat.messages) || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));   // oldest first, so seq order matches time order
    let n = 0;
    for (const m of msgs) {
      bump.run(); const seq = rd.get().val;
      const info = mi.run(String(m.id), m.room || 'general', m.username || 'unknown', m.deleted ? '' : E(file, `m:${m.id}:text`, m.text || ''), m.ts || 0, m.type || 'message',
        JSON.stringify(m.mentions || []), m.reply_to || null, m.source || null,
        (Array.isArray(m.attachments) && m.attachments.length) ? E(file, `m:${m.id}:att`, JSON.stringify(m.attachments)) : null,
        m.run ? E(file, `m:${m.id}:run`, JSON.stringify(m.run)) : null, m.edited || null, m.deleted ? (m.updated || m.ts || Date.now()) : null, m.updated || null,
        m.pinned ? JSON.stringify(m.pinned) : null, (m.reactions && Object.keys(m.reactions).length) ? JSON.stringify(m.reactions) : null, seq);
      if (info.changes) n++;
    }
    const fi = db.prepare('INSERT OR IGNORE INTO files (id, name, mime, size, sha256, by, ts, room, msg_id, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let nf = 0;
    for (const f of files || []) { const info = fi.run(String(f.id), E(file, `f:${f.id}:name`, f.name || ''), f.mime || 'application/octet-stream', f.size || 0, f.sha256 || null, f.by || '', f.ts || 0, f.room || null, f.msg_id || null, f.folder || null); if (info.changes) nf++; }
    db.exec('COMMIT');
    return { users: Object.keys((chat && chat.users) || {}).length, rooms: Object.keys((chat && chat.rooms) || {}).length, messages: n, fileRefs: nf };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { setCodec, convertChatBatch, convertChatRest, runsSince, archivePick, archiveRemove, archiveRowToMsg, load, loadLight, save, importChat, importFiles, importWorkspaceData, messages, messagesSince, maxSeq, before, get, edit, update, remove, search, pinnedIn, toggleReaction, repliesTo, setPrefs, maintenance, retention, deleteWorkspaceDb,
                   fileAdd, fileGet, filesAttach, filesForMsg, filesList, filesOrphans, fileDelete, filesBytes,   // T-0064
                   fileSetFolder, foldersList, folderAdd, folderRename, folderDelete, attachmentRemoved };        // T-0149
