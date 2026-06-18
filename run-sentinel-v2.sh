#!/bin/bash
# Sentinel v2 Executor Loop — 串行运行 4 个计算 + 写入 DB + Kafka
BASE_DIR="/home/sdadmin/tv-sentinel-v2"
LOG_DIR="/tmp/sentinel-v2-logs"
mkdir -p "${LOG_DIR}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sentinel v2 executor loop started"

while true; do
  CYCLE_START=$(date +%s)
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') Series start ---"
  
  # 1. Trend (一致趋势)
  TREND_RESULT=$(cd "${BASE_DIR}" && node executor-trend.js --json 2>&1)
  echo "${TREND_RESULT}" >> "${LOG_DIR}/trend.log"
  
  # 2. Turn (一致转折)
  TURN_RESULT=$(cd "${BASE_DIR}" && node executor.js --json 2>&1)
  echo "${TURN_RESULT}" >> "${LOG_DIR}/turn.log"
  
  # 3. LT (上涨转折)
  LT_RESULT=$(cd "${BASE_DIR}" && node executor-lt.js --json 2>&1)
  echo "${LT_RESULT}" >> "${LOG_DIR}/lt.log"
  
  # 4. ST (下跌转折)
  ST_RESULT=$(cd "${BASE_DIR}" && node executor-st.js --json 2>&1)
  echo "${ST_RESULT}" >> "${LOG_DIR}/st.log"
  
  # 合并写入 sentinel.db
  cd "${BASE_DIR}" && node -e "
    const db = require('./tools/database');
    const h = require('./tools/helpers');
    db.ensureSignalColumn();
    const trend = JSON.parse(process.argv[1] || '{}');
    const turn  = JSON.parse(process.argv[2] || '{}');
    const lt    = JSON.parse(process.argv[3] || '{}');
    const st    = JSON.parse(process.argv[4] || '{}');
    const now = new Date().toISOString();
    db.createExecution({ sentinel_type:'trend', source:'cli', timestamp:now, triggered:trend.consensusTrendConfirmed, signal:trend.signal, summary:trend.reason||'', result_json:JSON.stringify(trend), sources:trend.sources||'' });
    db.createExecution({ sentinel_type:'check', source:'cli', timestamp:now, triggered:turn.triggered, signal:turn.signal, summary:turn.triggerReason||'', result_json:JSON.stringify(turn), sources:turn.sources||'' });
    db.createExecution({ sentinel_type:'lt', source:'cli', timestamp:now, triggered:lt.ltTriggered, signal:lt.signal, summary:lt.ltReason||'', result_json:JSON.stringify(lt), sources:lt.sources||'' });
    db.createExecution({ sentinel_type:'st', source:'cli', timestamp:now, triggered:st.stTriggered, signal:st.signal, summary:st.stReason||'', result_json:JSON.stringify(st), sources:st.sources||'' });
    console.log('[DB] 4 executions written');
  " "${TREND_RESULT}" "${TURN_RESULT}" "${LT_RESULT}" "${ST_RESULT}"
  
  # 推送 Kafka（合并一条）
  cd "${BASE_DIR}" && node -e "
    const kafka = require('./tools/kafka');
    const h = require('./tools/helpers');
    const trend = JSON.parse(process.argv[1] || '{}');
    const turn  = JSON.parse(process.argv[2] || '{}');
    const lt    = JSON.parse(process.argv[3] || '{}');
    const st    = JSON.parse(process.argv[4] || '{}');
    const {markets} = h.getActiveMarkets();
    const merged = {
      ts: new Date().toLocaleString('zh-HK', {timeZone:'Asia/Hong_Kong'}),
      dateKey: trend.dateKey || '',
      activeMarkets: markets,
      trend: { signal: trend.signal, direction: trend.trendDirection, reason: trend.reason||'', hasTrend: trend.signal === 'FL' || trend.signal === 'FS' },
      turn:  { signal: turn.signal,  triggered: !!turn.triggered,  reason: turn.triggerReason||'' },
      lt:    { signal: lt.signal,    triggered: !!lt.ltTriggered,  reason: lt.ltReason||'' },
      st:    { signal: st.signal,    triggered: !!st.stTriggered,  reason: st.stReason||'' },
    };
    kafka.pushSignal(merged).then(() => console.log('[Kafka] Signal pushed'));
  " "${TREND_RESULT}" "${TURN_RESULT}" "${LT_RESULT}" "${ST_RESULT}"
  
  CYCLE_END=$(date +%s)
  DURATION=$((CYCLE_END - CYCLE_START))
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cycle done in ${DURATION}s" >> "${LOG_DIR}/cycle.log"
  
  SLEEP=$((300 - DURATION))
  if [ ${SLEEP} -lt 10 ]; then SLEEP=10; fi
  sleep ${SLEEP}
done
