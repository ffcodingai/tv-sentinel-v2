#!/usr/bin/env node
/**
 * backtest/runner.js
 * 回測指揮中心 — 可選 fetch / exec / 全流程
 *
 * Usage:
 *   # 只拉數據
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \
 *   node backtest/runner.js --action=fetch \
 *     --from=2026-06-01 --to=2026-06-07 \
 *     --sources=rotation,volume
 *
 *   # 只跑哨兵 (需先 fetch 好)
 *   node backtest/runner.js --action=exec \
 *     --backtest-id=<id> \
 *     --sentinels=lt,st \
 *     --from=2026-06-01 --to=2026-06-07
 *
 *   # 全流程
 *   node backtest/runner.js --action=all \
 *     --name="my-test" \
 *     --from=2026-06-01 --to=2026-06-07 \
 *     --sources=rotation,volume,index --sentinels=lt,st
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createRun } = require('./db-util');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--') && !a.includes('=')) args[a.slice(2)] = true;
});

const ACTION = args['action'] || 'fetch';  // fetch | exec | all
const NAME   = args['name'] || '';
const FROM   = args['from'];
const TO     = args['to'];
const SOURCES    = args['sources'] || 'rotation,volume,index,resistance';
const SENTINELS  = args['sentinels'] || 'lt,st';
const INTERVAL   = args['interval'] || '1h';

if (!FROM || !TO) {
  console.error('Usage: node backtest/runner.js --action=fetch|exec|all --from=DATE --to=DATE [options]');
  console.error('  --action=fetch   只拉數據');
  console.error('  --action=exec    只跑哨兵 (需已有 --backtest-id)');
  console.error('  --action=all     拉數據 + 跑哨兵');
  console.error('  --sources=rotation,volume,index,resistance');
  console.error('  --sentinels=lt,st,trend,check');
  process.exit(1);
}

const SCRIPT_DIR = __dirname;
const NODE_PATH = process.env.NODE_PATH ||
  `${path.join(SCRIPT_DIR, '..', 'node_modules')}:${path.join(SCRIPT_DIR, '..', '..', 'tradingview-ui-backend-dev', 'node_modules')}`;

function runScript(script, extraArgs = []) {
  const fullPath = path.join(SCRIPT_DIR, script);
  if (!fs.existsSync(fullPath)) {
    console.error(`Script not found: ${fullPath}`);
    return Promise.reject(new Error(`Not found: ${script}`));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('node', [fullPath, ...extraArgs], {
      env: { ...process.env, NODE_PATH },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`)));
    child.on('error', reject);
  });
}

async function main() {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║     tv-sentinel 回測指揮中心      ║`);
  console.log(`╚══════════════════════════════════╝`);
  console.log(`  Action:    ${ACTION}`);
  console.log(`  From:      ${FROM} → ${TO}`);
  if (ACTION !== 'exec') console.log(`  Sources:   ${SOURCES}`);
  if (ACTION !== 'fetch') console.log(`  Sentinels: ${SENTINELS}`);

  let runId = args['backtest-id'] || null;

  // ── Step 1: Fetch ──
  if (ACTION === 'fetch' || ACTION === 'all') {
    console.log('\n── 📡 Step 1: 數據抓取 ──\n');
    try {
      await runScript('fetch.js', [
        `--backtest-id=${runId || ''}`,
        `--from=${FROM}`,
        `--to=${TO}`,
        `--sources=${SOURCES}`,
        `--name=${NAME || `runner ${FROM}~${TO}`}`,
      ]);
    } catch (e) {
      console.error(`Fetch failed: ${e.message}`);
      if (ACTION === 'fetch') process.exit(1);
    }

    // 如果是 all 流程, 從 data-provider CLI 輸出擷取 runId
    // 但更方便: fetch.js 會印出 runId, 我們從 DB 拿最新的
    if (!runId) {
      const { listBacktestRuns } = require('./db-util');
      const runs = listBacktestRuns(1);
      if (runs.length > 0) runId = runs[0].id;
    }
  }

  // ── Step 2: Exec Sentinels ──
  if (ACTION === 'exec' || ACTION === 'all') {
    if (!runId) {
      console.error('No backtest-id available for exec. Run fetch first or provide --backtest-id.');
      process.exit(1);
    }

    const sentinelList = SENTINELS.split(',').map(s => s.trim().toLowerCase());

    for (const sentinel of sentinelList) {
      console.log(`\n── 🎯 Step 2: 哨兵 ${sentinel.toUpperCase()} ──\n`);
      try {
        await runScript('exec-sentinel.js', [
          `--backtest-id=${runId}`,
          `--sentinel=${sentinel}`,
          `--from=${FROM}`,
          `--to=${TO}`,
          `--interval=${INTERVAL}`,
        ]);
      } catch (e) {
        console.error(`Sentinel ${sentinel} failed: ${e.message}`);
      }
    }
  }

  // ── Summary ──
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║     回測完成                      ║`);
  if (runId) console.log(`║     ID: ${runId}`);
  console.log(`╚══════════════════════════════════╝\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
