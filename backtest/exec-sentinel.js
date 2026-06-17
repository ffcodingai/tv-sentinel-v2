#!/usr/bin/env node
/**
 * backtest/exec-sentinel.js
 * 對指定哨兵跑回測 — 用 data-provider 餵歷史數據
 *
 * ⚠️ 執行前需先 fetch 好數據，且 executor.js / executor-trend.js 尚未接入
 *    data-provider，目前為 stub 結構。
 *
 * Usage (future):
 *   node backtest/exec-sentinel.js \
 *     --backtest-id=<id> \
 *     --sentinel=lt \
 *     --at="2026-06-14 09:30"
 *
 *   --sentinel: lt | st | trend | check
 *   --at:       時間點 (ISO 或 "YYYY-MM-DD HH:mm")
 *   --from / --to / --interval: 批量模式
 *
 * 結果寫入: backtest/<id>/results/ + DB registerResult()
 */

const fs = require('fs');
const path = require('path');
const { initDatabase, getDb } = require('../database');
const { getBacktestRun, getResultDir, regResult } = require('./db-util');

initDatabase();

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });

const BACKTEST_ID = args['backtest-id'];
const SENTINEL    = args['sentinel'];   // lt | st | trend | check
const AT_TIME     = args['at'];         // 單點模式
const FROM        = args['from'];       // 批量模式
const TO          = args['to'];
const INTERVAL    = args['interval'] || '1h';

if (!BACKTEST_ID || !SENTINEL) {
  console.error('Usage: node backtest/exec-sentinel.js --backtest-id=ID --sentinel=lt|st|trend|check [--at=TIME] [--from=DATE --to=DATE]');
  process.exit(1);
}

if (!['lt', 'st', 'trend', 'check'].includes(SENTINEL)) {
  console.error(`Invalid sentinel: ${SENTINEL}. Must be lt, st, trend, or check.`);
  process.exit(1);
}

// ── Sentinel to executor file mapping ──
const EXECUTOR_MAP = {
  lt:     'executor-lt.js',
  st:     'executor-st.js',
  trend:  'executor-trend.js',
  check:  'executor.js',
};

function parseInterval(str) {
  const m = str.match(/^(\d+)([mhd])$/);
  if (!m) return 3600000;
  switch (m[2]) {
    case 'm': return parseInt(m[1]) * 60000;
    case 'h': return parseInt(m[1]) * 3600000;
    case 'd': return parseInt(m[1]) * 86400000;
    default: return 3600000;
  }
}

/**
 * 在單一時間點執行哨兵
 * TODO: 真正接入 executor 時:
 *   const { main: runSentinel } = require(`../${EXECUTOR_MAP[SENTINEL]}`);
 *   const dataProvider = require('./data-provider');
 *   改寫 executor 內的 fetchRotationData/fetchVolumeSurge/fetchIndexData
 *   改為呼叫 dataProvider.getRotationData(atTime, BACKTEST_ID) 等
 *   結果寫入 resultDir / 註冊 DB
 */
async function runAt(atTime) {
  const resultDir = getResultDir(BACKTEST_ID);
  fs.mkdirSync(resultDir, { recursive: true });

  // ── 先用 data-provider 確認數據是否存在 ──
  const dp = require('./data-provider');
  const rotation = dp.getRotationData(atTime, BACKTEST_ID);
  const volume   = dp.getVolumeSurge(atTime, BACKTEST_ID);
  const index    = dp.getIndexData(atTime, BACKTEST_ID);
  const dateStr  = atTime.split(' ')[0];
  const resist   = dp.getResistanceData(dateStr, BACKTEST_ID);

  const hasIssues = [];
  if (!rotation) hasIssues.push('rotation');
  if (!volume)   hasIssues.push('volume_surge');
  if (!index)    hasIssues.push('composite_index');
  if (!resist)   hasIssues.push('resistance');

  const result = {
    timestamp: atTime,
    sentinel: SENTINEL,
    backtestId: BACKTEST_ID,
    dataProvider: {
      rotation: !!rotation,
      volume_surge: !!volume,
      composite_index: !!index,
      resistance: !!resist,
      missing: hasIssues,
    },
    executor: null,
    status: 'pending_executor_integration',
    message: hasIssues.length > 0
      ? `⚠️ 缺少數據源: ${hasIssues.join(', ')}`
      : `✅ 數據齊全, 等待 executor 接入 data-provider 後即可執行`,
  };

  // 寫入結果
  const tsSafe = atTime.replace(/[: ]/g, '-');
  const fileName = `${SENTINEL}-${tsSafe}.json`;
  const outFile = path.join(resultDir, fileName);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  regResult(BACKTEST_ID, SENTINEL, atTime, fileName);

  console.log(`  [${atTime}] ${result.message} → ${fileName}`);
  return result;
}

async function main() {
  const run = getBacktestRun(BACKTEST_ID);
  if (!run) {
    console.error(`Backtest run not found: ${BACKTEST_ID}`);
    process.exit(1);
  }

  console.log(`\n═══════════ 哨兵回測 ═══════════`);
  console.log(`  Run ID:    ${BACKTEST_ID}`);
  console.log(`  Sentinel:  ${SENTINEL}`);
  console.log(`  Executor:  ${EXECUTOR_MAP[SENTINEL]}`);
  console.log(`════════════════════════════════\n`);

  // 單點模式
  if (AT_TIME) {
    await runAt(AT_TIME);
    console.log(`\nDone.`);
    return;
  }

  // 批量模式
  if (FROM && TO) {
    console.log(`  Range: ${FROM} → ${TO} (${INTERVAL})`);
    const startMs = new Date(FROM).getTime();
    const endMs   = new Date(TO).getTime();
    const intMs   = parseInterval(INTERVAL);
    let count = 0;

    for (let t = startMs; t <= endMs; t += intMs) {
      const dt = new Date(t);
      const tsLabel = dt.toISOString().replace('T', ' ').substring(0, 19);
      await runAt(tsLabel);
      count++;
    }

    console.log(`\nDone: ${count} points executed.`);
    return;
  }

  console.error('Provide --at for single point or --from/--to for batch.');
  process.exit(1);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
