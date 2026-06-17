#!/usr/bin/env node
/**
 * backtest/runner.js
 * Orchestrates fetching all data for a time range.
 * Runs fetch-rotation, fetch-volume, fetch-index for each time point,
 * and fetch-resistance once per day.
 *
 * Usage:
 *   node backtest/runner.js --backtest-id=test001 --from=2026-06-01 --to=2026-06-17 --interval=1h
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (match) args[match[1]] = match[2];
});

const BACKTEST_ID = args['backtest-id'];
const FROM_DATE   = args['from'];   // YYYY-MM-DD
const TO_DATE     = args['to'];     // YYYY-MM-DD
const INTERVAL    = args['interval'] || '1h'; // e.g. 1h, 30m

if (!BACKTEST_ID || !FROM_DATE || !TO_DATE) {
  console.error('Usage: node backtest/runner.js --backtest-id=ID --from=YYYY-MM-DD --to=YYYY-MM-DD --interval=1h');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, BACKTEST_ID);

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseInterval(intv) {
  const match = intv.match(/^(\d+)([hmd])$/);
  if (!match) return 60 * 60 * 1000; // default 1h in ms
  const val = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function runScript(scriptName, ...scriptArgs) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    const child = spawn('node', [scriptPath, ...scriptArgs], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_PATH: process.env.NODE_PATH || '/home/sdadmin/tradingview-ui-backend-dev/node_modules',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${scriptName} exited code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.on('error', reject);
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const intervalMs   = parseInterval(INTERVAL);
  const fromMs       = new Date(FROM_DATE).getTime();
  const toMs         = new Date(TO_DATE + 'T23:59:59').getTime();

  // Generate time points
  const timePoints = [];
  for (let t = fromMs; t <= toMs; t += intervalMs) {
    timePoints.push(new Date(t));
  }

  console.log(`\n=== Backtest Runner ===`);
  console.log(`ID:       ${BACKTEST_ID}`);
  console.log(`Range:    ${FROM_DATE} → ${TO_DATE}`);
  console.log(`Interval: ${INTERVAL} (${intervalMs}ms)`);
  console.log(`Points:   ${timePoints.length}`);
  console.log('');

  // Collect unique dates for resistance fetches
  const resistanceDates = new Set();

  for (let i = 0; i < timePoints.length; i++) {
    const tp = timePoints[i];
    const fromISO = tp.toISOString();
    const toISO   = new Date(tp.getTime() + intervalMs - 1).toISOString();
    const dateStr = tp.toISOString().slice(0, 10);

    const tsLabel = formatTs(tp);
    const pct = ((i + 1) / timePoints.length * 100).toFixed(1);
    console.log(`[${pct}%] Point ${i + 1}/${timePoints.length}: ${tsLabel}`);

    // Run Kafka fetchers in sequence (they share the same topic, minimize Kafka load)
    try {
      console.log(`  Running fetch-rotation...`);
      const rot = await runScript('fetch-rotation.js',
        `--backtest-id=${BACKTEST_ID}`,
        `--from=${fromISO}`,
        `--to=${toISO}`
      );
      console.log(`    ${rot.stdout.trim().split('\n').pop()}`);
    } catch (err) {
      console.error(`  fetch-rotation failed: ${err.message}`);
    }

    try {
      console.log(`  Running fetch-volume...`);
      const vol = await runScript('fetch-volume.js',
        `--backtest-id=${BACKTEST_ID}`,
        `--from=${fromISO}`,
        `--to=${toISO}`
      );
      console.log(`    ${vol.stdout.trim().split('\n').pop()}`);
    } catch (err) {
      console.error(`  fetch-volume failed: ${err.message}`);
    }

    try {
      console.log(`  Running fetch-index...`);
      const idx = await runScript('fetch-index.js',
        `--backtest-id=${BACKTEST_ID}`,
        `--from=${fromISO}`,
        `--to=${toISO}`
      );
      console.log(`    ${idx.stdout.trim().split('\n').pop()}`);
    } catch (err) {
      console.error(`  fetch-index failed: ${err.message}`);
    }

    resistanceDates.add(dateStr);
  }

  // ── Fetch resistance once per unique date ────────────────────────────────
  console.log(`\n--- Fetching resistance data for ${resistanceDates.size} unique dates ---`);
  for (const dateStr of [...resistanceDates].sort()) {
    try {
      console.log(`  Running fetch-resistance for ${dateStr}...`);
      const res = await runScript('fetch-resistance.js',
        `--backtest-id=${BACKTEST_ID}`,
        `--date=${dateStr}`
      );
      console.log(`    ${res.stdout.trim().split('\n').pop()}`);
    } catch (err) {
      console.error(`  fetch-resistance for ${dateStr} failed: ${err.message}`);
    }
    await sleep(1000); // rate limit pause between resistance fetches
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== Summary ===`);
  const outFiles = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.json'));
  const rotFiles  = outFiles.filter(f => f.startsWith('sector-rotation-ui'));
  const volFiles  = outFiles.filter(f => f.startsWith('volume-surge'));
  const idxFiles  = outFiles.filter(f => f.startsWith('composite-index'));
  const resFiles  = outFiles.filter(f => f.startsWith('resistance'));

  console.log(`  sector-rotation-ui: ${rotFiles.length} files`);
  console.log(`  volume-surge:       ${volFiles.length} files`);
  console.log(`  composite-index:    ${idxFiles.length} files`);
  console.log(`  resistance:         ${resFiles.length} files`);
  console.log(`  Total:              ${outFiles.length} files in ${OUT_DIR}`);
  console.log(`\nDone.`);
}

function formatTs(d) {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
