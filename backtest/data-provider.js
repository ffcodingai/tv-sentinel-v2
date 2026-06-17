#!/usr/bin/env node
/**
 * backtest/data-provider.js
 * Unified entry point for LT/ST executors to load backtest data.
 *
 * Usage:
 *   node backtest/data-provider.js --backtest-id=test001 --at="2026-06-14 09:30"
 *
 * When --at is provided with --backtest-id:
 *   - rotation: loads backtest/<id>/sector-rotation-ui-<closest-ts>.json
 *   - volume:   loads backtest/<id>/volume-surge-<closest-ts>.json
 *   - index:    loads backtest/<id>/composite-index-<closest-ts>.json
 *   - resistance: loads backtest/<id>/resistance-<date>.json
 *
 * When --at is null/omitted: reads live files from /tmp/.
 */

const fs = require('fs');
const path = require('path');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (match) args[match[1]] = match[2];
});

const BACKTEST_ID = args['backtest-id'] || null;
const AT_TIME     = args['at'] || null; // "2026-06-14 09:30"

// ── Helpers ─────────────────────────────────────────────────────────────────

const BACKTEST_DIR = BACKTEST_ID ? path.join(__dirname, BACKTEST_ID) : null;
const AT_DATE      = AT_TIME ? AT_TIME.split(' ')[0] : null; // "2026-06-14"

function formatTs(d) {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

// Find the file with the closest timestamp ≤ AT_TIME
function findClosestFile(prefix) {
  if (!BACKTEST_DIR || !fs.existsSync(BACKTEST_DIR)) return null;
  const files = fs.readdirSync(BACKTEST_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();

  if (files.length === 0) return null;

  // Files are named: prefix-YYYY-MM-DD HH:mm:ss.json
  // Find the closest one ≤ AT_TIME
  const atMs = new Date(AT_TIME).getTime();
  let bestFile = null;
  let bestDiff = Infinity;

  for (const f of files) {
    // Extract timestamp from filename after prefix
    const tsPart = f.slice(prefix.length + 1, -5); // remove "prefix-" and ".json"
    const tsMs = new Date(tsPart).getTime();
    if (isNaN(tsMs)) continue;
    const diff = atMs - tsMs;
    if (diff >= 0 && diff < bestDiff) {
      bestDiff = diff;
      bestFile = f;
    }
  }

  // If nothing before atMs, take the earliest
  if (!bestFile && files.length > 0) {
    bestFile = files[0];
  }

  return bestFile ? path.join(BACKTEST_DIR, bestFile) : null;
}

// Find resistance file for a given date
function findResistanceFile(dateStr) {
  if (!BACKTEST_DIR || !fs.existsSync(BACKTEST_DIR)) return null;
  const f = `resistance-${dateStr}.json`;
  const fp = path.join(BACKTEST_DIR, f);
  return fs.existsSync(fp) ? fp : null;
}

// ── Sleeper (temporary file watches for live mode) ──────────────────────────
const LIVE_FILES = [
  { prefix: 'sector-rotation-ui', path: '/tmp/sector-rotation-ui.json' },
  { prefix: 'volume-surge',       path: '/tmp/volume-surge-segments.json' },
  { prefix: 'composite-index',    path: '/tmp/composite-index-data.json' },
];

function readLiveOrEmpty(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Public API (exported for programmatic use) ──────────────────────────────

const dataProvider = {
  /**
   * Get rotation data.
   * @param {string|null} atTime  - Timestamp or null for live
   * @param {string|null} backtestId
   * @returns {object|null}
   */
  getRotationData(atTime, backtestId) {
    const bd = backtestId ? path.join(__dirname, backtestId) : null;
    if (atTime && bd) {
      const file = findClosestFileInDir('sector-rotation-ui', atTime, bd);
      if (!file) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return readLiveOrEmpty('/tmp/sector-rotation-ui.json');
  },

  /**
   * Get volume surge data.
   */
  getVolumeSurge(atTime, backtestId) {
    const bd = backtestId ? path.join(__dirname, backtestId) : null;
    if (atTime && bd) {
      const file = findClosestFileInDir('volume-surge', atTime, bd);
      if (!file) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return readLiveOrEmpty('/tmp/volume-surge-segments.json');
  },

  /**
   * Get composite index data.
   */
  getIndexData(atTime, backtestId) {
    const bd = backtestId ? path.join(__dirname, backtestId) : null;
    if (atTime && bd) {
      const file = findClosestFileInDir('composite-index', atTime, bd);
      if (!file) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return readLiveOrEmpty('/tmp/composite-index-data.json');
  },

  /**
   * Get resistance data for a specific date.
   * @param {string} dateStr - YYYY-MM-DD
   */
  getResistanceData(dateStr, backtestId) {
    const bd = backtestId ? path.join(__dirname, backtestId) : null;
    if (dateStr && bd) {
      const file = path.join(bd, `resistance-${dateStr}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return readLiveOrEmpty('/tmp/stock-resistance.json');
  },
};

// ── Internal helper (needed since this is a dual standalone/lib module) ─────
function findClosestFileInDir(prefix, atTime, dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .sort();

  if (files.length === 0) return null;

  const atMs = new Date(atTime).getTime();
  let bestFile = null;
  let bestDiff = Infinity;

  for (const f of files) {
    const tsPart = f.slice(prefix.length + 1, -5);
    const tsMs = new Date(tsPart).getTime();
    if (isNaN(tsMs)) continue;
    const diff = atMs - tsMs;
    if (diff >= 0 && diff < bestDiff) {
      bestDiff = diff;
      bestFile = f;
    }
  }

  if (!bestFile) bestFile = files[0];
  return path.join(dir, bestFile);
}

// ── CLI mode ────────────────────────────────────────────────────────────────
if (require.main === module) {
  (function runCLI() {
    console.log(`\n=== Data Provider ===`);
    console.log(`backtest-id: ${BACKTEST_ID || '(none)'}`);
    console.log(`at:         ${AT_TIME || '(live)'}\n`);

    // Rotation
    const rotation = dataProvider.getRotationData(AT_TIME, BACKTEST_ID);
    console.log(`Rotation: ${rotation ? `✓ ${Object.keys(rotation.countries || {}).length} countries` : '✗ not found'}`);

    // Volume
    const volume = dataProvider.getVolumeSurge(AT_TIME, BACKTEST_ID);
    console.log(`Volume:   ${volume ? `✓ ${volume.segments?.length || 0} segments` : '✗ not found'}`);

    // Index
    const index = dataProvider.getIndexData(AT_TIME, BACKTEST_ID);
    console.log(`Index:    ${index ? `✓ compIdx=${index.compositeIndex?.length || 0} spread=${index.spreadRecords?.length || 0} segs=${index.segments?.length || 0}` : '✗ not found'}`);

    // Resistance
    const resistance = dataProvider.getResistanceData(AT_DATE, BACKTEST_ID);
    if (resistance) {
      const marketCount = Object.keys(resistance.data?.markets || {}).length;
      const totalStocks = resistance.data?.totals?.reduce((s, t) => s + t.count, 0) || 0;
      console.log(`Resistance: ✓ ${marketCount} markets, ${totalStocks} stocks`);
    } else {
      console.log(`Resistance: ✗ not found`);
    }

    console.log(`\nDone.`);
  })();
}

module.exports = dataProvider;
