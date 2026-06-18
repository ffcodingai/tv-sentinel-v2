// ── sentinel.db 寫入工具（v2）──
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'sentinel-v2.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = TRUNCATE');
  return db;
}

/**
 * 確保 sentinel_executions 表有 signal 列
 */
function ensureSignalColumn() {
  const db = getDb();
  try {
    const row = db.prepare("PRAGMA table_info(sentinel_executions)").all();
    const hasSignal = row.some(c => c.name === 'signal');
    if (!hasSignal) {
      db.exec("ALTER TABLE sentinel_executions ADD COLUMN signal TEXT DEFAULT 'NONE'");
  try { db.exec("ALTER TABLE sentinel_executions ADD COLUMN sources TEXT DEFAULT ''"); } catch(e){}
      console.log('[DB] Added signal column to sentinel_executions');
    }
  } catch (e) {
    console.error('[DB] Migration error:', e.message);
  }
  db.close();
}

/**
 * 寫入一條執行記錄
 * @param {object} opts - { sentinel_type, source, timestamp, triggered, signal, summary, result_json }
 */
function createExecution(opts) {
  const db = getDb();
  const { sentinel_type, source, timestamp, triggered, signal, summary, result_json, sources } = opts;
  const id = require('crypto').randomUUID();
  db.prepare(`
    INSERT INTO sentinel_executions (id, sentinel_type, source, timestamp, triggered, signal, summary, result_json, sources, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))
  `).run(id, sentinel_type, source || 'live', timestamp || new Date().toISOString(), triggered ? 1 : 0, signal || 'NONE', summary || '', result_json || '{}', sources || '');
  db.close();
  return id;
}

module.exports = { ensureSignalColumn, createExecution };
