#!/usr/bin/env node
// tools/snapshot.js — consistent copy of a Chamber data directory, and verification of one (T-0026).
//
//   node tools/snapshot.js <data-dir> <dest-dir>   copy accounts/workspace JSON files and take a transactional
//                                                  snapshot of every SQLite chat database (VACUUM INTO), then
//                                                  integrity-check each copy. Prints one JSON summary line.
//   node tools/snapshot.js <data-dir> <dest-dir> --no-files
//                                                  the same, but leaves out the bytes of uploaded files (ws/<id>/files/).
//                                                  chamber-backup v3 copies those to backup storage ONCE each instead of
//                                                  inside every nightly archive (T-0183); the summary counts what was left out.
//   node tools/snapshot.js --verify <dir>          integrity-check every chamber.db under <dir> and parse every
//                                                  JSON file; prints the same summary. Exit 1 on any problem.
//
// Why not tar the live directory: chamber.db plus its -wal file change while tar reads them, so a restore could
// get a database that never existed. VACUUM INTO writes a clean single-file copy inside one read transaction.
// Sessions are deliberately left out (they are short-lived and hold login tokens).
//
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SKIP = new Set(['sessions.json', 'backup-status.json', 'restore-drill-status.json']);
const summary = { ok: true, workspaces: 0, databases: 0, messages: 0, json_files: 0, bytes: 0, problems: [] };
const NO_FILES = process.argv[4] === '--no-files', IS_UPLOAD = rel => /^(ws\/[^/]+\/)?files\//.test(rel.split(path.sep).join('/'));   // T-0183

function walk(dir, fn, rel = '') {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;                                      // dotfiles/dirs (.aws cli cache etc.) are not Chamber data
    const r = path.join(rel, e.name);
    if (e.isDirectory()) walk(dir, fn, r); else fn(r, e);
  }
}

function snapshotDb(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* a writer was busy; VACUUM INTO is still consistent */ }
    db.prepare('VACUUM INTO ?').run(dest);
  } finally { db.close(); }
}

function checkDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]).join(';');
    if (ic !== 'ok') { summary.ok = false; summary.problems.push(`${file}: integrity_check ${ic.slice(0, 120)}`); return; }
    summary.databases++;
    summary.messages += db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  } catch (e) { summary.ok = false; summary.problems.push(`${file}: ${e.message}`); }
  finally { db.close(); }
}

function checkJson(file) {
  try { JSON.parse(fs.readFileSync(file, 'utf8')); summary.json_files++; }
  catch (e) { summary.ok = false; summary.problems.push(`${file}: bad JSON (${e.message})`); }
}

const [a, b] = process.argv.slice(2);
if (a === '--verify' && b) {
  walk(b, (rel) => {
    const f = path.join(b, rel);
    if (rel.endsWith('.db')) checkDb(f);
    else if (rel.endsWith('.json') && !SKIP.has(path.basename(rel))) checkJson(f);
    summary.bytes += fs.statSync(f).size;
  });
  summary.workspaces = fs.existsSync(path.join(b, 'ws')) ? fs.readdirSync(path.join(b, 'ws')).length : 0;
} else if (a && b && a !== '--verify') {
  const src = a, dest = b;
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  walk(src, (rel) => {
    const base = path.basename(rel);
    if (rel.split(path.sep).join('/').startsWith('deploy/browser-last/')) return;   // screenshots of the last release check: not customer data, megabytes every night
    if (NO_FILES && IS_UPLOAD(rel)) { if (!base.endsWith('.part')) { summary.files_left_out = (summary.files_left_out || 0) + 1; summary.file_bytes_left_out = (summary.file_bytes_left_out || 0) + fs.statSync(path.join(src, rel)).size; } return; }
    if (SKIP.has(base) || base.endsWith('.db-wal') || base.endsWith('.db-shm') || base.endsWith('.migrated') || /\.tmp\.\d+$/.test(base)) return;
    const from = path.join(src, rel), to = path.join(dest, rel);
    if (base.endsWith('.db')) { snapshotDb(from, to); checkDb(to); }
    else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); if (base.endsWith('.json')) checkJson(to); }
    fs.chmodSync(to, 0o600);
    summary.bytes += fs.statSync(to).size;
  });
  summary.workspaces = fs.existsSync(path.join(dest, 'ws')) ? fs.readdirSync(path.join(dest, 'ws')).length : 0;
} else {
  console.error('usage: snapshot.js <data-dir> <dest-dir> | --verify <dir>'); process.exit(2);
}
console.log(JSON.stringify(summary));
process.exit(summary.ok ? 0 : 1);
