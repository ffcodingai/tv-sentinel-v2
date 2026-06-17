#!/usr/bin/env node
/**
 * backtest/data-provider.js
 * Unified entry point — loads backtest data via DB-indexed file paths.
 *
 * Usage:
 *   node backtest/data-provider.js --backtest-id=<id> --at="2026-06-14 09:30"
 *
 * Backtest mode (with --backtest-id):
 *   - Looks up file paths from DB (backtest_runs.snapshots column)
 *   - Loads the closest matching snapshot file
 *
 * Live mode (no --backtest-id):
 *   - Reads from /tmp/ files directly
 */

const fs = require('fs');
const { initDatabase, getDb } = require('../database');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
});

const BACKTEST_ID = args['backtest-id'] || null;
const AT_TIME     = args['at'] || null;
const AT_DATE     = AT_TIME ? AT_TIME.split(' ')[0] : null;

// ── DB helper ───────────────────────────────────────────────────────────────
initDatabase();

function loadSnapshotFile(runId, dataType, timestamp) {
  const row = getDb().prepare('SELECT * FROM backtest_runs WHERE id = ?').get(runId);
  if (!row) return null;
  let snapshots;
  try { snapshots = JSON.parse(row.snapshots); } catch { snapshots = {}; }

  const typeMap = snapshots[dataType];
  if (!typeMap) return null;

  // Find closest timestamp ≤ requested timestamp
  const keys = Object.keys(typeMap).sort();
  let bestKey = null, bestDiff = Infinity;
  const atMs = new Date(timestamp).getTime();
  for (const k of keys) {
    const kMs = new Date(k).getTime();
    if (isNaN(kMs)) continue;
    const diff = atMs - kMs;
    if (diff >= 0 && diff < bestDiff) {
      bestDiff = diff;
      bestKey = k;
    }
  }
  // Fallback: earliest if nothing before
  if (!bestKey && keys.length > 0) bestKey = keys[0];
  if (!bestKey) return null;

  const filePath = typeMap[bestKey];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function loadResistanceFile(runId, dateStr) {
  const row = getDb().prepare('SELECT * FROM backtest_runs WHERE id = ?').get(runId);
  if (!row) return null;
  let snapshots;
  try { snapshots = JSON.parse(row.snapshots); } catch { snapshots = {}; }
  const typeMap = snapshots['resistance'];
  if (!typeMap) return null;

  // Look for exact date or closest
  const keys = Object.keys(typeMap).sort();
  let bestKey = null;
  for (const k of keys) {
    if (k.startsWith(dateStr)) { bestKey = k; break; }
  }
  if (!bestKey && keys.length > 0) bestKey = keys[keys.length - 1];
  if (!bestKey) return null;

  const filePath = typeMap[bestKey];
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────────────────

const dataProvider = {
  getRotationData(atTime, backtestId) {
    if (atTime && backtestId) return loadSnapshotFile(backtestId, 'rotation', atTime);
    try { return JSON.parse(fs.readFileSync('/tmp/sector-rotation-ui.json', 'utf-8')); } catch { return null; }
  },

  getVolumeSurge(atTime, backtestId) {
    if (atTime && backtestId) return loadSnapshotFile(backtestId, 'volume_surge', atTime);
    try { return JSON.parse(fs.readFileSync('/tmp/volume-surge-segments.json', 'utf-8')); } catch { return null; }
  },

  getIndexData(atTime, backtestId) {
    if (atTime && backtestId) return loadSnapshotFile(backtestId, 'composite_index', atTime);
    // Live: try localhost:3334 (original behavior preserved by executors)
    return null;
  },

  getResistanceData(dateStr, backtestId) {
    if (dateStr && backtestId) return loadResistanceFile(backtestId, dateStr);
    return null;
  },
};

// ── CLI mode ────────────────────────────────────────────────────────────────
if (require.main === module) {
  console.log(`\n=== Data Provider ===`);
  console.log(`backtest-id: ${BACKTEST_ID || '(none)'}`);
  console.log(`at:         ${AT_TIME || '(live)'}\n`);

  const rotation = dataProvider.getRotationData(AT_TIME, BACKTEST_ID);
  console.log(`Rotation: ${rotation ? `✓ ${Object.keys(rotation.countries || {}).length} countries` : '✗ not found'}`);

  const volume = dataProvider.getVolumeSurge(AT_TIME, BACKTEST_ID);
  console.log(`Volume:   ${volume ? `✓ ${volume.segments?.length || 0} segments` : '✗ not found'}`);

  const index = dataProvider.getIndexData(AT_TIME, BACKTEST_ID);
  console.log(`Index:    ${index ? '✓ found' : '✗ not found'}`);

  const resistance = dataProvider.getResistanceData(AT_DATE, BACKTEST_ID);
  console.log(`Resistance: ${resistance ? '✓ found' : '✗ not found'}`);

  console.log(`\nDone.`);
}

module.exports = dataProvider;
