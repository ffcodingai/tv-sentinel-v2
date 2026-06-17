const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'sentinel.db');
const ALLOWED_SENTINEL_TYPES = ['up_trend','up_turn','down_trend','down_turn','sector_rotation','lt','st'];
const ALLOWED_MARKET_STATES = ['uptrend','up_turning','downtrend','down_turning','rotation_up','rotation_down','neutral','up_st','down_lt'];

let db;

function migrationNeeded() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sentinels'").get();
  if (!row) return false;
  // Check if schema includes lt and st
  return !row.sql.includes("'lt'");
}

function recreateSentinelsTable() {
  db.exec(`DROP TABLE IF EXISTS sentinel_logs`);
  db.exec(`DROP TABLE IF EXISTS market_states`);
  db.exec(`DROP TABLE IF EXISTS data_assignments`);
  db.exec(`DROP TABLE IF EXISTS sentinels`);
  createTables();
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinels (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','disabled')),
      config      TEXT DEFAULT '{}',
      data_sources TEXT DEFAULT '[]',
      market      TEXT,
      symbol      TEXT,
      interval    TEXT DEFAULT '5m',
      last_triggered_at TEXT,
      last_error_at   TEXT,
      last_error_msg  TEXT,
      created_at  TEXT DEFAULT (datetime('now','localtime')),
      updated_at  TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sentinel_logs (
      id          TEXT PRIMARY KEY,
      sentinel_id TEXT NOT NULL REFERENCES sentinels(id) ON DELETE CASCADE,
      event       TEXT NOT NULL CHECK(event IN ('triggered','resolved','error','state_change','info')),
      message     TEXT,
      old_state   TEXT,
      new_state   TEXT,
      triggered_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS market_states (
      id          TEXT PRIMARY KEY,
      sentinel_id TEXT NOT NULL REFERENCES sentinels(id) ON DELETE CASCADE,
      market      TEXT NOT NULL,
      state       TEXT NOT NULL,
      confidence  REAL DEFAULT 0,
      detail      TEXT DEFAULT '{}',
      detected_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS data_assignments (
      id          TEXT PRIMARY KEY,
      sentinel_id TEXT NOT NULL REFERENCES sentinels(id) ON DELETE CASCADE,
      agent_id    TEXT NOT NULL,
      endpoint    TEXT,
      params      TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id          TEXT PRIMARY KEY,
      name        TEXT DEFAULT '',
      from_time   TEXT,
      to_time     TEXT,
      interval    TEXT DEFAULT '1h',
      status      TEXT DEFAULT 'pending',
      config      TEXT DEFAULT '{}',
      snapshots   TEXT DEFAULT '{}',
      results     TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now','localtime')),
      updated_at  TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
}

function initDatabase() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('foreign_keys = ON');

  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sentinels'").get();

  if (!tableExists) {
    createTables();
  } else if (migrationNeeded()) {
    // Upgrade: remove CHECK constraint to support new types
    console.log('[DB] Migration: upgrading sentinel types schema...');
    // Save data before recreating
    const oldSentinels = db.prepare('SELECT * FROM sentinels').all();
    const oldLogs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sentinel_logs'").get()
      ? db.prepare('SELECT * FROM sentinel_logs').all() : [];
    const oldStates = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_states'").get()
      ? db.prepare('SELECT * FROM market_states').all() : [];

    recreateSentinelsTable();

    // Restore data
    const insertS = db.prepare(`INSERT INTO sentinels (id,name,type,description,status,config,data_sources,market,symbol,interval,last_triggered_at,last_error_at,last_error_msg,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of oldSentinels) {
      try { insertS.run(r.id,r.name,r.type,r.description,r.status,r.config,r.data_sources,r.market,r.symbol,r.interval,r.last_triggered_at,r.last_error_at,r.last_error_msg,r.created_at,r.updated_at); } catch(e) {}
    }
  }

  return db;
}

function getDb() {
  if (!db) initDatabase();
  return db;
}

// ── Sentinel CRUD ──

function getAllSentinels() {
  const rows = db.prepare('SELECT * FROM sentinels ORDER BY created_at DESC').all();
  return rows.map(r => ({ ...r, config: safeJson(r.config), data_sources: safeJson(r.data_sources) }));
}

function getSentinel(id) {
  const r = db.prepare('SELECT * FROM sentinels WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, config: safeJson(r.config), data_sources: safeJson(r.data_sources) };
}

function createSentinel({ name, type, description, config, data_sources, market, symbol, interval }) {
  if (!ALLOWED_SENTINEL_TYPES.includes(type)) throw new Error(`Invalid sentinel type: ${type}`);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO sentinels (id, name, type, description, config, data_sources, market, symbol, interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, type, description || '', JSON.stringify(config || {}), JSON.stringify(data_sources || []), market || null, symbol || null, interval || '5m');
  return getSentinel(id);
}

function updateSentinel(id, fields) {
  const allowed = ['name', 'type', 'status', 'description', 'config', 'data_sources', 'market', 'symbol', 'interval'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  db.prepare(`UPDATE sentinels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getSentinel(id);
}

function deleteSentinel(id) {
  db.prepare('DELETE FROM sentinels WHERE id = ?').run(id);
  return { success: true };
}

// ── Sentinel status ──

function setSentinelStatus(id, status, errorMsg) {
  const fields = { status };
  if (errorMsg) {
    fields.last_error_msg = errorMsg;
    fields.last_error_at = new Date().toISOString().replace('T', ' ').substring(0, 19);
  }
  updateSentinel(id, fields);
}

function setTriggered(id) {
  db.prepare(`UPDATE sentinels SET last_triggered_at = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE id = ?`).run(id);
}

// ── Logs ──

function addLog(sentinelId, event, message, oldState, newState) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sentinel_logs (id, sentinel_id, event, message, old_state, new_state) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, sentinelId, event, message, oldState || null, newState || null);
  return id;
}

function getLogs(sentinelId, limit = 50) {
  if (sentinelId) {
    return db.prepare('SELECT * FROM sentinel_logs WHERE sentinel_id = ? ORDER BY triggered_at DESC LIMIT ?').all(sentinelId, limit);
  }
  return db.prepare('SELECT sl.*, s.name as sentinel_name FROM sentinel_logs sl LEFT JOIN sentinels s ON s.id = sl.sentinel_id ORDER BY sl.triggered_at DESC LIMIT ?').all(limit);
}

// ── Market states ──

function getMarketStates() {
  return db.prepare(`SELECT ms.*, s.name as sentinel_name, s.type as sentinel_type FROM market_states ms JOIN sentinels s ON s.id = ms.sentinel_id ORDER BY ms.detected_at DESC`).all();
}

function setMarketState(sentinelId, market, state, confidence, detail) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO market_states (id, sentinel_id, market, state, confidence, detail) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, sentinelId, market, state, confidence || 0, JSON.stringify(detail || {}));
  return id;
}

// ── Data assignments ──

function addDataAssignment(sentinelId, agentId, endpoint, params) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO data_assignments (id, sentinel_id, agent_id, endpoint, params) VALUES (?, ?, ?, ?, ?)`)
    .run(id, sentinelId, agentId, endpoint || null, JSON.stringify(params || {}));
  return id;
}

function getDataAssignments(sentinelId) {
  return db.prepare('SELECT * FROM data_assignments WHERE sentinel_id = ?').all(sentinelId);
}

// ── Stats ──

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM sentinels').get().c;
  const byStatus = db.prepare(`SELECT status, COUNT(*) as c FROM sentinels GROUP BY status`).all();
  const byType = db.prepare(`SELECT type, COUNT(*) as c FROM sentinels GROUP BY type`).all();
  const activeCounts = {}, typeCounts = {};
  for (const s of byStatus) activeCounts[s.status] = s.c;
  for (const t of byType) typeCounts[t.type] = t.c;
  const lastTriggered = db.prepare(`SELECT name, type, last_triggered_at FROM sentinels WHERE last_triggered_at IS NOT NULL ORDER BY last_triggered_at DESC LIMIT 5`).all();
  return { total, byStatus: activeCounts, byType: typeCounts, recentTriggers: lastTriggered };
}

function safeJson(str) {
  try { return JSON.parse(str); } catch (_) { return str; }
}

function closeDatabase() {
  if (db) db.close();
}

// ── Backtest Runs ──

function createBacktestRun({ name, from_time, to_time, interval, config }) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO backtest_runs (id, name, from_time, to_time, interval, config)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name || '', from_time || '', to_time || '', interval || '1h', JSON.stringify(config || {}));
  return getBacktestRun(id);
}

function getBacktestRun(id) {
  const r = db.prepare('SELECT * FROM backtest_runs WHERE id = ?').get(id);
  if (!r) return null;
  return { ...r, config: safeJson(r.config), snapshots: safeJson(r.snapshots), results: safeJson(r.results) };
}

function listBacktestRuns(limit = 20) {
  return db.prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function updateBacktestRun(id, fields) {
  const allowed = ['name', 'status', 'config', 'snapshots', 'results'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (sets.length === 0) return getBacktestRun(id);
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  db.prepare(`UPDATE backtest_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getBacktestRun(id);
}

function registerSnapshot(runId, dataType, timestamp, filePath) {
  const run = getBacktestRun(runId);
  if (!run) return null;
  const snapshots = run.snapshots;
  if (!snapshots[dataType]) snapshots[dataType] = {};
  snapshots[dataType][timestamp] = filePath;
  return updateBacktestRun(runId, { snapshots });
}

function registerResult(runId, sentinelType, timestamp, filePath) {
  const run = getBacktestRun(runId);
  if (!run) return null;
  const results = run.results;
  if (!results[sentinelType]) results[sentinelType] = {};
  results[sentinelType][timestamp] = filePath;
  return updateBacktestRun(runId, { results });
}

module.exports = {
  initDatabase, getDb, closeDatabase,
  getAllSentinels, getSentinel, createSentinel, updateSentinel, deleteSentinel,
  setSentinelStatus, setTriggered,
  addLog, getLogs,
  getMarketStates, setMarketState,
  addDataAssignment, getDataAssignments,
  getStats,
  createBacktestRun, getBacktestRun, listBacktestRuns,
  updateBacktestRun, registerSnapshot, registerResult,
};
