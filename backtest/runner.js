#!/usr/bin/env node
/**
 * backtest/runner.js
 * Orchestrates fetching all backtest data for a time range.
 *   - Creates a backtest run in DB
 *   - Runs fetch-rotation, fetch-volume, fetch-index for each time point
 *   - Runs fetch-resistance once per day
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \\
 *   node backtest/runner.js --name="test-run-1" --from=2026-06-01 --to=2026-06-17 --interval=1h
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createRun, getBacktestRun } = require('./db-util');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });

const NAME     = args['name'] || '';
const FROM     = args['from'];
const TO       = args['to'];
const INTERVAL = args['interval'] || '1h';

if (!FROM || !TO) {
  console.error('Usage: node backtest/runner.js --from=YYYY-MM-DD --to=YYYY-MM-DD --interval=1h'); process.exit(1);
}

// ── Create backtest run in DB ──
const run = createRun({
  name: NAME,
  fromTime: FROM,
  toTime: TO,
  interval: INTERVAL,
  config: { createdBy: 'runner.js' },
});

console.log(`\n══════════════════════════════════`);
console.log(`  Backtest Run Created`);
console.log(`  ID:   ${run.id}`);
console.log(`  Name: ${NAME || '(unnamed)'}`);
console.log(`  From: ${FROM} → To: ${TO}`);
console.log(`  Interval: ${INTERVAL}`);
console.log(`══════════════════════════════════\n`);

const SCRIPT_DIR = __dirname;
const NODE_PATH = process.env.NODE_PATH || `${require('path').join(__dirname, '..', 'node_modules')}:${require('path').join(__dirname, '..', '..', 'tradingview-ui-backend-dev', 'node_modules')}`;

function runScript(script, envVars = {}) {
  return new Promise((resolve, reject) => {
    const fullPath = path.join(SCRIPT_DIR, script);
    if (!fs.existsSync(fullPath)) {
      console.error(`Script not found: ${fullPath}`);
      return reject(new Error(`Script not found: ${script}`));
    }

    const child = spawn('node', [fullPath], {
      env: { ...process.env, NODE_PATH, ...envVars },
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function main() {
  const runId = run.id;
  const fromDate = new Date(FROM);
  const toDate = new Date(TO);
  const intervalMs = parseInterval(INTERVAL);

  // ── Step 1: Fetch rotation + volume + index (per time point) ──
  console.log('\n── Step 1: Fetching rotation, volume, index data ──\n');

  const rotationFrom = `${FROM}T00:00:00`;
  const rotationTo = `${TO}T23:59:59`;

  try {
    console.log('\n[Rotation]');
    await runScript('fetch-rotation.js', { BACKTEST_ID: runId },
      `--backtest-id=${runId}`, `--from=${rotationFrom}`, `--to=${rotationTo}`);
  } catch (e) {
    console.error(`[Rotation] Failed: ${e.message}`);
  }

  try {
    console.log('\n[Volume Surge]');
    await runScript('fetch-volume.js', { BACKTEST_ID: runId },
      `--backtest-id=${runId}`, `--from=${rotationFrom}`, `--to=${rotationTo}`);
  } catch (e) {
    console.error(`[Volume] Failed: ${e.message}`);
  }

  try {
    console.log('\n[Composite Index]');
    await runScript('fetch-index.js', { BACKTEST_ID: runId },
      `--backtest-id=${runId}`, `--from=${rotationFrom}`, `--to=${rotationTo}`);
  } catch (e) {
    console.error(`[Index] Failed: ${e.message}`);
  }

  // ── Step 2: Fetch resistance per unique date ──
  console.log('\n── Step 2: Fetching resistance data (per day) ──\n');

  let currentDate = new Date(fromDate);
  while (currentDate <= toDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    try {
      console.log(`\n[Resistance] ${dateStr}`);
      await runScript('fetch-resistance.js', { BACKTEST_ID: runId },
        `--backtest-id=${runId}`, `--date=${dateStr}`);
    } catch (e) {
      console.error(`[Resistance ${dateStr}] Failed: ${e.message}`);
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  // ── Done ──
  const finalRun = getBacktestRun(runId);
  const rotCount = Object.keys(finalRun.snapshots.rotation || {}).length;
  const volCount = Object.keys(finalRun.snapshots.volume_surge || {}).length;
  const idxCount = Object.keys(finalRun.snapshots.composite_index || {}).length;
  const resCount = Object.keys(finalRun.snapshots.resistance || {}).length;

  console.log(`\n══════════════════════════════════`);
  console.log(`  Backtest Complete`);
  console.log(`  ID:     ${runId}`);
  console.log(`  Rotation: ${rotCount} snapshots`);
  console.log(`  Volume:   ${volCount} snapshots`);
  console.log(`  Index:    ${idxCount} snapshots`);
  console.log(`  Resistance: ${resCount} days`);
  console.log(`  Files:  ${path.join(SCRIPT_DIR, runId, 'snapshots')}`);
  console.log(`══════════════════════════════════\n`);
}

function parseInterval(str) {
  const m = str.match(/^(\d+)([mhd])$/);
  if (!m) return 3600000;
  const n = parseInt(m[1]);
  switch (m[2]) {
    case 'm': return n * 60000;
    case 'h': return n * 3600000;
    case 'd': return n * 86400000;
    default: return 3600000;
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
