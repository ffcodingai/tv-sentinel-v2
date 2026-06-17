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
const { initDatabase, getDb, createExecution } = require('../database');
const { getBacktestRun, getResultDir, regResult } = require('./db-util');
const { pushExecution, disconnect: kafkaDisconnect } = require('./kafka-push');

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

/** Extract key signals from executor result for Kafka payload */
function extractKeySignals(result, sentinelType) {
  const signals = {};
  // Try to find volume_surge in result steps
  if (result.steps) {
    for (const s of result.steps) {
      if (s.volumeSurge) signals.volume_surge = s.volumeSurge.hasSurge;
      if (s.detail && s.detail.includes('全球')) signals.global_consensus = s.detail;
      if (s.slope != null) signals.slope = s.slope;
      if (s.spread) signals.spread = s.spread;
      if (s.premium?.spread != null) signals.spread = s.premium.spread;
      if (s.name && s.name.includes('折溢')) signals.spread = signals.spread || (s.premium?.spread);
    }
  }
  // Direct fields from result
  if (result.volumeSurge) signals.volume_surge = result.volumeSurge.hasSurge;
  if (result.slopeVal != null) signals.slope = result.slopeVal;
  return signals;
}

/**
 * 在單一時間點執行哨兵 — 直接呼叫 executor
 */
async function runAt(atTime) {
  const resultDir = getResultDir(BACKTEST_ID);
  fs.mkdirSync(resultDir, { recursive: true });

  // ── 呼叫 executor ──
  const { main: runSentinel } = require(`../${EXECUTOR_MAP[SENTINEL]}`);
  const executorResult = await runSentinel({ at: atTime, backtestId: BACKTEST_ID, json: true });

  // 寫入結果檔案
  const tsSafe = atTime.replace(/[: ]/g, '-');
  const fileName = `${SENTINEL}-${tsSafe}.json`;
  const outFile = path.join(resultDir, fileName);
  fs.writeFileSync(outFile, JSON.stringify(executorResult, null, 2));
  regResult(BACKTEST_ID, SENTINEL, atTime, fileName);

  // 寫入 sentinel_executions (每次執行一條記錄)
  const triggerKeys = { lt: 'ltTriggered', st: 'stTriggered', trend: 'trendHealthy', check: 'triggered' };
  const triggered = !!executorResult[triggerKeys[SENTINEL]];
  const reason = executorResult.ltReason || executorResult.stReason || executorResult.triggerReason || executorResult.reason || '';
  createExecution({
    sentinel_type: SENTINEL,
    source: 'backtest',
    backtest_id: BACKTEST_ID,
    timestamp: atTime,
    triggered,
    summary: `${triggered ? '🚨 觸發' : '✅ 未觸發'} — ${reason.substring(0, 200)}`,
    result_json: JSON.stringify(executorResult),
  });

  // 推 Kafka
  const dt = new Date(atTime);
  const tsMs = isNaN(dt.getTime()) ? Date.now() : dt.getTime();
  pushExecution({
    sentinelType: SENTINEL,
    source: 'backtest',
    backtestId: BACKTEST_ID,
    timestampMs: tsMs,
    triggered,
    summary: reason.substring(0, 200),
    keySignals: extractKeySignals(executorResult, SENTINEL),
  }).catch(() => {});

  // 印摘要
  const icon = triggered ? '🚨' : '✅';
  console.log(`  [${atTime}] ${icon} ${triggered ? '觸發' : '未觸發'} — ${reason.substring(0, 80)}`);

  return executorResult;
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
    const toFull = TO.includes('T') ? TO : `${TO}T23:59:59`;
    const fromFull = FROM.includes('T') ? FROM : `${FROM}T00:00:00`;
    console.log(`  Range: ${fromFull} → ${toFull} (${INTERVAL})`);
    const startMs = new Date(fromFull).getTime();
    const endMs   = new Date(toFull).getTime();
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
