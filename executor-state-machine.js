#!/usr/bin/env node
/**
 * executor-state-machine.js — 狀態機哨兵 (v2)
 *
 * current 只輸出 L / S，中間觸發用 array 記錄。
 *
 * Usage:
 *   node executor-state-machine.js \
 *     --trend '{"consensusTrendConfirmed":true,...}' \
 *     --turn  '{"triggered":false,...}' \
 *     --lt    '{"ltTriggered":false,...}' \
 *     --st    '{"stTriggered":false,...}'
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const STATE_FILE = path.join(__dirname, 'state-machine.json');
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';
const INDEX_SERVER = 'http://localhost:3334';

const DEFAULT_STATE = {
  current: '?',
  trendStartTime: null,   // 趋势开始时间（状态切换时更新）
  ltTriggers: [],
  lttTriggers: [],
  stTriggers: [],
  sttTriggers: [],
  transitions: [],
};

// ── 工具 ──
function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { ...DEFAULT_STATE, ltTriggers: [], lttTriggers: [], stTriggers: [], sttTriggers: [], transitions: [] };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[SM] Save error:', e.message);
  }
}

function nowISO() {
  return new Date().toISOString();
}

// ── 條件提取 ──
function extractConditions(trend, turn, lt, st) {
  return {
    a1: turn?.conditionA1?.growing || lt?.conditionA1?.growing || st?.conditionA1?.growing || false,
    a2: turn?.conditionA2?.growing || lt?.conditionA2?.growing || st?.conditionA2?.growing || false,
    a3: turn?.conditionA3?.growing || lt?.conditionA3?.growing || st?.conditionA3?.growing || false,
    volumeSurge: false,
    eventConfirmed: false,
    ma30Broken: false,
    ma30Breakout: false,
    resistancePattern: lt?.resistanceCheck?.resistanceFound || false,
    supportPattern: st?.supportCheck?.supportFound || false,
  };
}

function checkVolumeSurge() {
  try {
    const raw = fs.readFileSync(VOLUME_SURGE_PATH, 'utf-8');
    const d = JSON.parse(raw);
    const segs = Object.values(d.segments || {});
    return segs.filter((s) => s.status === 'active' && (s.ratio || 0) >= 1.2).length >= 2;
  } catch {
    return false;
  }
}

async function checkMA30() {
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    if (!data?.indexData?.length) return { broken: false, breakout: false };
    const last = data.indexData[data.indexData.length - 1];
    const curSeg = last.segmentType || last.segmentId || '';
    return {
      broken: curSeg === 'LTT' || curSeg === 'S',
      breakout: curSeg === 'STT' || curSeg === 'L',
    };
  } catch {
    return { broken: false, breakout: false };
  }
}

// ── 主邏輯 ──
async function run(trend, turn, lt, st) {
  const state = loadState();

  // 條件
  const ct = extractConditions(trend, turn, lt, st);
  ct.volumeSurge = checkVolumeSurge();
  const ma30 = await checkMA30();
  ct.ma30Broken = ma30.broken;
  ct.ma30Breakout = ma30.breakout;

  // 信號判斷
  const consensus = !!trend?.consensusTrendConfirmed;
  const direction = trend?.trendDirection || null;
  const FL = consensus && direction === 'up';
  const FS_cond = consensus && direction === 'down';
  const LT_trig = lt?.ltTriggered || lt?.signal === 'LT';
  const ST_trig = st?.stTriggered || st?.signal === 'ST';
  const LTT_trig = turn?.triggered && turn?.signal === 'LTT';
  const STT_trig = turn?.triggered && turn?.signal === 'STT';

  // LTT/STT 也可以從 condition 推斷（如果 executor 沒觸發但數據滿足）
  const LTT_cond = ct.a1 && ct.a2 && ct.a3 && ct.ma30Broken;
  const STT_cond = ct.a1 && ct.a2 && ct.a3 && ct.ma30Breakout;

  let cur = state.current;
  let changed = false;
  let reason = '';
  let signal = 'NONE';

  // 來源摘要
  const srcParts = [];
  srcParts.push(FL ? 'FL✅' : FS_cond ? 'FS✅' : '共識❌');
  srcParts.push('A1:' + (ct.a1 ? '小→大' : '—'));
  srcParts.push('A2:' + (ct.a2 ? '分歧' : '—'));
  srcParts.push('LT:' + (LT_trig ? '觸發' : '—'));
  srcParts.push('ST:' + (ST_trig ? '觸發' : '—'));
  srcParts.push('LTT:' + (LTT_trig || LTT_cond ? '可轉' : '—'));
  srcParts.push('STT:' + (STT_trig || STT_cond ? '可轉' : '—'));

  // ═══════════════ L 側 ═══════════════
  if (cur === '?' || cur === 'L') {
    if (cur === '?') {
      cur = (direction === 'down') ? 'S' : 'L';
      reason = '初始' + (cur === 'S' ? '下跌' : '上漲');
      changed = true;
    }

    // FL 出現 → 清空 LT/LTT trigger
    if (FL) {
      if (state.ltTriggers.length > 0 || state.lttTriggers.length > 0) {
        state.ltTriggers = [];
        state.lttTriggers = [];
        reason = 'FL, 清空觸發';
        changed = true;
      }
    }

    // LTT 發生 → 推入 → 直接轉 S
    if (LTT_trig || LTT_cond) {
      state.lttTriggers.push({ at: nowISO(), reason: LTT_trig ? turn?.triggerReason || 'LTT觸發' : 'LTT條件滿足' });
      state.ltTriggers = [];
      cur = 'S';
      signal = 'LTT';
      reason = 'LTT → 轉S';
      changed = true;
      state.transitions.push({ from: 'L', to: 'S', at: nowISO(), reason: 'LTT一致上漲轉折' });
    }
    // LT 發生 → 推入（只在 L 時）
    else if (LT_trig) {
      state.ltTriggers.push({ at: nowISO(), reason: lt?.ltReason || 'LT觸發' });
      reason = 'LT+' + state.ltTriggers.length + '次';
      changed = true;
    }

    // 有 LT trigger + FS → 轉 S
    if (state.ltTriggers.length > 0 && FS_cond) {
      state.lttTriggers = [];
      cur = 'S';
      signal = 'FS';
      reason = 'LT' + state.ltTriggers.length + '次+FS → 轉S';
      changed = true;
      state.transitions.push({ from: 'L', to: 'S', at: nowISO(), reason: 'LT累積+一致下跌' });
    }
  }

  // ═══════════════ S 側 ═══════════════
  if (cur === 'S') {
    // FS 出現 → 清空 ST/STT trigger
    if (FS_cond) {
      if (state.stTriggers.length > 0 || state.sttTriggers.length > 0) {
        state.stTriggers = [];
        state.sttTriggers = [];
        reason = 'FS, 清空觸發';
        changed = true;
      }
    }

    // STT 發生 → 推入 → 直接轉 L
    if (STT_trig || STT_cond) {
      state.sttTriggers.push({ at: nowISO(), reason: STT_trig ? turn?.triggerReason || 'STT觸發' : 'STT條件滿足' });
      state.stTriggers = [];
      cur = 'L';
      signal = 'STT';
      reason = 'STT → 轉L';
      changed = true;
      state.transitions.push({ from: 'S', to: 'L', at: nowISO(), reason: 'STT一致下跌轉折' });
    }
    // ST 發生 → 推入（只在 S 時）
    else if (ST_trig) {
      state.stTriggers.push({ at: nowISO(), reason: st?.stReason || 'ST觸發' });
      reason = 'ST+' + state.stTriggers.length + '次';
      changed = true;
    }

    // 有 ST trigger + FL → 轉 L
    if (state.stTriggers.length > 0 && FL) {
      state.sttTriggers = [];
      cur = 'L';
      signal = 'FL';
      reason = 'ST' + state.stTriggers.length + '次+FL → 轉L';
      changed = true;
      state.transitions.push({ from: 'S', to: 'L', at: nowISO(), reason: 'ST累積+一致上漲' });
    }
  }

  // 跳轉時順便清空另一側的 trigger（防舊數據干擾）
  if (cur === 'S') {
    state.ltTriggers = [];
    state.lttTriggers = [];
  }
  if (cur === 'L') {
    state.stTriggers = [];
    state.sttTriggers = [];
  }

  // 趋势开始时间：状态变化时更新
  if (changed && cur !== state.current) {
    state.trendStartTime = nowISO();
  }

  state.current = cur;
  if (changed && state.transitions.length > 50) {
    state.transitions = state.transitions.slice(-50);
  }

  saveState(state);

  // 摘要
  const summary = changed
    ? `⚡ ${reason}`
    : `${cur} - ${state.ltTriggers.length}LT/${state.lttTriggers.length}LTT/${state.stTriggers.length}ST/${state.sttTriggers.length}STT`;

  const result = {
    current: state.current,
    trendStartTime: state.trendStartTime,
    changed,
    reason,
    signal: signal !== 'NONE' ? signal : state.current,
    triggered: changed,
    summary,
    sources: srcParts.join(' | '),
    ltTriggers: state.ltTriggers.length,
    lttTriggers: state.lttTriggers.length,
    stTriggers: state.stTriggers.length,
    sttTriggers: state.sttTriggers.length,
    transitionsCount: state.transitions.length,
  };

  return result;
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (key) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : null; };
  const parse = (str) => { try { return str ? JSON.parse(str) : {}; } catch { return {}; } };

  run(parse(getArg('--trend')), parse(getArg('--turn')), parse(getArg('--lt')), parse(getArg('--st')))
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => console.error(JSON.stringify({ error: e.message })));
}

module.exports = { run };
