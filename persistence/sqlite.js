const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data.sqlite');

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    stage TEXT,
    locale TEXT,
    last_seen_at INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    who TEXT,
    text TEXT,
    ts INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS customers (
    session_id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    address TEXT,
    district TEXT,
    upazila TEXT,
    email TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS summaries (
    session_id TEXT PRIMARY KEY,
    summary TEXT,
    updated_at INTEGER
  )`);
});

function saveSession(session) {
  const stmt = db.prepare(`INSERT INTO sessions(session_id, stage, locale, last_seen_at)
    VALUES(?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET stage=excluded.stage, locale=excluded.locale, last_seen_at=excluded.last_seen_at`);
  stmt.run(session.sessionId, session.stage, session.locale, session.lastSeenAt);
  stmt.finalize();
}

function saveMessage(sessionId, who, text, ts) {
  const stmt = db.prepare(`INSERT INTO messages(session_id, who, text, ts) VALUES(?,?,?,?)`);
  stmt.run(sessionId, who, text, ts);
  stmt.finalize();
}

function loadRecentMessages(sessionId, limit = 10) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT who, text, ts FROM messages WHERE session_id=? ORDER BY ts ASC`, [sessionId], (err, rows) => {
      if (err) return reject(err);
      const last = rows.slice(-limit);
      resolve(last);
    });
  });
}

function saveCustomer(sessionId, customer) {
  const stmt = db.prepare(`INSERT INTO customers(session_id, name, phone, address, district, upazila, email)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET name=excluded.name, phone=excluded.phone, address=excluded.address, district=excluded.district, upazila=excluded.upazila, email=excluded.email`);
  stmt.run(sessionId, customer?.name || '', customer?.phone || '', customer?.address || '', customer?.district || '', customer?.upazila || '', customer?.email || '');
  stmt.finalize();
}

function loadCustomer(sessionId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT name, phone, address, district, upazila, email FROM customers WHERE session_id=?`, [sessionId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function saveSummary(sessionId, summary) {
  const stmt = db.prepare(`INSERT INTO summaries(session_id, summary, updated_at)
    VALUES(?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary, updated_at=excluded.updated_at`);
  stmt.run(sessionId, String(summary||''), Date.now());
  stmt.finalize();
}

function loadSummary(sessionId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT summary, updated_at FROM summaries WHERE session_id=?`, [sessionId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

module.exports = { db, saveSession, saveMessage, loadRecentMessages, saveCustomer, loadCustomer, saveSummary, loadSummary };


