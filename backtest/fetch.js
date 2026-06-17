#!/usr/bin/env node
/**
 * backtest/fetch.js
 * 統一數據抓取 CLI — 可選 source，取代個別呼叫多個 fetch-*.js
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \
 *   node backtest/fetch.js \
 *     --backtest-id=<id> \
 *     --from=2026-06-01 --to=2026-06-07 \
 *     --sources=rotation,volume,index,resistance
 *
 *   --sources 預設全部, 可選子集如 --sources=rotation,resistance
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createRun, getBacktestRun } = require('./db-util');

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });

let RUN_ID = args['backtest-id'];
const FROM = args['from'];
const TO   = args['to'];
const SOURCES = (args['sources'] || 'rotation,volume,index,resistance').split(',').map(s => s.trim().toLowerCase());
const NAME = args['name'] || '';

if (!FROM || !TO) {
  console.error('Usage: node backtest/fetch.js --backtest-id=ID --from=YYYY-MM-DD --to=YYYY-MM-DD [--sources=rotation,volume,index,resistance]');
  process.exit(1);
}

// ── 若無 backtest-id, 自動 create ──
if (!RUN_ID) {
  const run = createRun({
    name: NAME || `fetch ${FROM}~${TO}`,
    fromTime: FROM,
    toTime: TO,
    config: { sources: SOURCES },
  });
  RUN_ID = run.id;
  console.log(`\n📌 Created backtest run: ${RUN_ID}\n`);
}

const SCRIPT_DIR = __dirname;
// 優先使用現有 NODE_PATH, 否則補上 dev node_modules
const NODE_PATH = process.env.NODE_PATH ||
  `${path.join(SCRIPT_DIR, '..', 'node_modules')}:${path.join(SCRIPT_DIR, '..', '..', 'tradingview-ui-backend-dev', 'node_modules')}`;

const SRC_MAP = {
  rotation:    'fetch-rotation.js',
  volume:      'fetch-volume.js',
  index:       'fetch-index.js',
  resistance:  'fetch-resistance.js',
};

const FROM_FULL = `${FROM}T00:00:00`;
const TO_FULL   = `${TO}T23:59:59`;

async function runScript(script, extraArgs = []) {
  const fullPath = path.join(SCRIPT_DIR, script);
  if (!fs.existsSync(fullPath)) {
    console.error(`  ❌ Script not found: ${fullPath}`);
    return;
  }

  return new Promise((resolve, reject) => {
    const childArgs = [
      fullPath,
      `--backtest-id=${RUN_ID}`,
      `--from=${FROM_FULL}`,
      `--to=${TO_FULL}`,
      ...extraArgs,
    ];
    const child = spawn('node', childArgs, {
      env: { ...process.env, NODE_PATH },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exit code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  console.log(`\n═══════════ 數據抓取 ═══════════`);
  console.log(`  Run ID:    ${RUN_ID}`);
  console.log(`  From:      ${FROM} → ${TO}`);
  console.log(`  Sources:   ${SOURCES.join(', ')}`);
  console.log(`════════════════════════════════\n`);

  // ── Rotation ──
  if (SOURCES.includes('rotation')) {
    console.log('\n── Rotation ──');
    try { await runScript('fetch-rotation.js'); }
    catch (e) { console.error(`  [Rotation] ${e.message}`); }
  }

  // ── Volume Surge ──
  if (SOURCES.includes('volume')) {
    console.log('\n── Volume Surge ──');
    try { await runScript('fetch-volume.js'); }
    catch (e) { console.error(`  [Volume] ${e.message}`); }
  }

  // ── Composite Index ──
  if (SOURCES.includes('index')) {
    console.log('\n── Composite Index ──');
    try { await runScript('fetch-index.js'); }
    catch (e) { console.error(`  [Index] ${e.message}`); }
  }

  // ── Resistance (per day) ──
  if (SOURCES.includes('resistance')) {
    console.log('\n── Resistance ──');
    const start = new Date(FROM);
    const end   = new Date(TO);
    let cur = new Date(start);
    while (cur <= end) {
      const ds = cur.toISOString().split('T')[0];
      try {
        await runScript('fetch-resistance.js', [`--date=${ds}`]);
      } catch (e) {
        console.error(`  [Resistance ${ds}] ${e.message}`);
      }
      cur.setDate(cur.getDate() + 1);
    }
  }

  // ── Summary ──
  const run = getBacktestRun(RUN_ID);
  console.log(`\n═══════════ 完成 ═══════════`);
  if (run) {
    for (const [src, paths] of Object.entries(run.snapshots)) {
      const count = Object.keys(paths).length;
      console.log(`  ${src.padEnd(15)} ${count} 筆`);
    }
  }
  console.log(`  Run ID: ${RUN_ID}`);
  console.log(`════════════════════════════\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
