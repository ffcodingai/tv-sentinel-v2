#!/bin/bash
# Sentinel v2 Executor Loop — 串行运行计算 + 写入 DB + Kafka
# 链路: trend → turn → slow-turn → rotation → state-machine → DB → Kafka
BASE_DIR="/home/sdadmin/tv-sentinel-v2"
LOG_DIR="/tmp/sentinel-v2-logs"
TMP_DIR="/tmp/sentinel-v2-tmp"
mkdir -p "${LOG_DIR}" "${TMP_DIR}"

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
  
  # 3. Slow-Turn (慢转折检测，替代旧 LT + ST)
  SLOW_RESULT=$(cd "${BASE_DIR}" && node executor-slow-turn.js --json 2>&1)
  echo "${SLOW_RESULT}" >> "${LOG_DIR}/slow.log"
  
  # 4. Rotation-Turn (确认轮动转折)
  ROTATION_RESULT=$(cd "${BASE_DIR}" && node executor-rotation.js --trend "${TREND_RESULT}" --json 2>&1)
  echo "${ROTATION_RESULT}" >> "${LOG_DIR}/rotation.log"
  
  # 写入临时文件避免 Argument list too long
  echo "${TREND_RESULT}" > "${TMP_DIR}/trend.json"
  echo "${TURN_RESULT}" > "${TMP_DIR}/turn.json"
  echo "${SLOW_RESULT}" > "${TMP_DIR}/slow.json"
  echo "${ROTATION_RESULT}" > "${TMP_DIR}/rotation.json"
  
  # 5. 狀態機 (State Machine) — 从文件读取参数
  SM_RESULT=$(cd "${BASE_DIR}" && node executor-state-machine.js \
    --trend-file "${TMP_DIR}/trend.json" \
    --turn-file "${TMP_DIR}/turn.json" \
    --slow-file "${TMP_DIR}/slow.json" 2>&1)
  echo "${SM_RESULT}" > "${TMP_DIR}/sm.json"
  echo "${SM_RESULT}" >> "${LOG_DIR}/sm.log"
  SM_STATE=$(echo "${SM_RESULT}" | grep -o '"current":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "  → State: ${SM_STATE}"
  
  # 合并写入 sentinel.db
  cd "${BASE_DIR}" && node -e "
    const db = require('./tools/database');
    const fs = require('fs');
    db.ensureSignalColumn();
    const tmpDir = '${TMP_DIR}';
    const trend    = JSON.parse(fs.readFileSync(tmpDir+'/trend.json','utf-8'));
    const turn     = JSON.parse(fs.readFileSync(tmpDir+'/turn.json','utf-8'));
    const slow     = JSON.parse(fs.readFileSync(tmpDir+'/slow.json','utf-8'));
    const rotation = JSON.parse(fs.readFileSync(tmpDir+'/rotation.json','utf-8'));
    const sm       = JSON.parse(fs.readFileSync(tmpDir+'/sm.json','utf-8'));
    const now = new Date().toISOString();
    db.createExecution({ sentinel_type:'trend',    source:'cli', timestamp:now, triggered:trend.consensusTrendConfirmed, signal:trend.signal, summary:trend.reason||'', result_json:JSON.stringify(trend), sources:trend.sources||'' });
    db.createExecution({ sentinel_type:'check',    source:'cli', timestamp:now, triggered:turn.triggered, signal:turn.signal, summary:turn.triggerReason||'', result_json:JSON.stringify(turn), sources:turn.sources||'' });
    db.createExecution({ sentinel_type:'slow',     source:'cli', timestamp:now, triggered:slow.signal!=='NONE', signal:slow.signal, summary:slow.summary||'', result_json:JSON.stringify(slow), sources:slow.sources||'' });
    db.createExecution({ sentinel_type:'rotation', source:'cli', timestamp:now, triggered:rotation.rtTriggered, signal:rotation.signal, summary:rotation.reason||'', result_json:JSON.stringify(rotation), sources:rotation.sources||'' });
    db.createExecution({ sentinel_type:'sm',       source:'cli', timestamp:now, triggered:sm.triggered, signal:sm.signal, summary:sm.summary||sm.reason||'', result_json:JSON.stringify(sm), sources:sm.sources||'state_machine' });
    console.log('[DB] 5 executions written');
  "
  
  # 推送 Kafka（合并一条）
  cd "${BASE_DIR}" && node -e "
    const kafka = require('./tools/kafka');
    const h = require('./tools/helpers');
    const fs = require('fs');
    const tmpDir = '${TMP_DIR}';
    const trend    = JSON.parse(fs.readFileSync(tmpDir+'/trend.json','utf-8'));
    const turn     = JSON.parse(fs.readFileSync(tmpDir+'/turn.json','utf-8'));
    const slow     = JSON.parse(fs.readFileSync(tmpDir+'/slow.json','utf-8'));
    const rotation = JSON.parse(fs.readFileSync(tmpDir+'/rotation.json','utf-8'));
    const sm       = JSON.parse(fs.readFileSync(tmpDir+'/sm.json','utf-8'));
    const {markets} = h.getActiveMarkets();
    const merged = {
      ts: new Date().toLocaleString('zh-HK', {timeZone:'Asia/Hong_Kong'}),
      dateKey: trend.dateKey || '',
      activeMarkets: markets,
      trend: { signal: trend.signal, direction: trend.trendDirection, reason: trend.reason||'', hasTrend: trend.signal === 'FL' || trend.signal === 'FS' },
      turn:  { signal: turn.signal,  triggered: !!turn.triggered,  reason: turn.triggerReason||'' },
      slow:  {
        signal: slow.signal,
        triggered: slow.signal !== 'NONE',
        direction: slow.triggerDirection,
        summary: slow.summary || '',
        sectors: (slow.sectorResults || []).map(s => ({
          sector: s.sector,
          confirmed: s.confirmed,
          direction: s.direction,
          g1: s.g1,
          g2: s.g2,
          detail: s.detail,
        })),
      },
      rotation: { signal: rotation.signal||'NONE', triggered: !!rotation.rtTriggered, direction: rotation.monitorList?.direction, sectors: rotation.monitorList?.sectors, pendingSectors: rotation.monitorList?.pendingSectors, reason: rotation.reason||'' },
      state: { current: sm.current, signal: sm.signal, changed: !!sm.triggered, reason: sm.reason||'' },
    };
    kafka.pushSignal(merged).then(() => console.log('[Kafka] Signal pushed'));
  "
  
  CYCLE_END=$(date +%s)
  DURATION=$((CYCLE_END - CYCLE_START))
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Cycle done in ${DURATION}s" >> "${LOG_DIR}/cycle.log"
  
  SLEEP=$((300 - DURATION))
  if [ ${SLEEP} -lt 10 ]; then SLEEP=10; fi
  sleep ${SLEEP}
done
