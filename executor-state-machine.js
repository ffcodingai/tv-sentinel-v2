#!/usr/bin/env node
/**
 * executor-state-machine.js — 8 狀態轉移機
 *
 * 吃 4 個 executor 的 --json stdout + 直接拉 data source，
 * 結合當前狀態 (state-machine.json)，決定下一狀態。
 *
 * 狀態: L / FL / LT / LTT / S / SL / ST / STT
 *
 * Usage (via run-sentinel-v2.sh):
 *   node executor-state-machine.js \
 *     --trend '{"consensusTrendConfirmed":true,"trendDirection":"up",...}' \
 *     --turn  '{"triggered":false,...}' \
 *     --lt    '{"ltTriggered":false,...}' \
 *     --st    '{"stTriggered":false,...}'
 *
 * Output: JSON { current, previous, changed, reason, signal }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// ── 檔案路徑 ──
const STATE_FILE = path.join(__dirname, 'state-machine.json');
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';
const INDEX_SERVER = 'http://localhost:3334';

// ── 預設狀態 ──
const DEFAULT_STATE = {
  current: '?',
  previous: null,
  changedAt: null,
  duration: 0,
  conditions: {
    a1: false, a2: false, a3: false,
    volumeSurge: false, eventConfirmed: false,
    ma30Broken: false, ma30Breakout: false,
    resistancePattern: false, supportPattern: false,
  },
  transitions: [],
};

// ── 工具函式 ──
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

// ── 載入/儲存狀態 ──
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { ...DEFAULT_STATE, transitions: [] };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[SM] Save error:', e.message);
  }
}

function transition(state, next, reason) {
  if (state.current === next) {
    state.duration++;
    return false;
  }
  state.transitions.push({
    from: state.current,
    to: next,
    at: new Date().toISOString(),
    reason,
  });
  if (state.transitions.length > 50) {
    state.transitions = state.transitions.slice(-50);
  }
  state.previous = state.current;
  state.current = next;
  state.changedAt = new Date().toISOString();
  state.duration = 1;
  return true;
}

// ── 拉 volume 放量狀態 ──
function checkVolumeSurge() {
  try {
    const raw = fs.readFileSync(VOLUME_SURGE_PATH, 'utf-8');
    const d = JSON.parse(raw);
    const segs = Object.values(d.segments || {});
    const active = segs.filter((s) => s.status === 'active' && (s.ratio || 0) >= 1.2);
    return active.length >= 2; // 至少 2 個活躍放量
  } catch {
    return false;
  }
}

// ── 拉 tv-index MA30 狀態 ──
async function checkMA30() {
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    if (!data?.indexData?.length) return { broken: false, breakout: false };
    const idx = data.indexData;
    const last = idx[idx.length - 1];
    const curSeg = last.segmentType || last.segmentId || '';
    // 如果最後一段是 L (上漲)，但最近有轉折 → MA30 可能被跌破
    // 如果最後一段是 S (下跌)，但最近有轉折 → MA30 可能被突破
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

  // 1. 從 4 個 executor 結果提取條件
  const ct = {
    a1: trend?.conditionA?.small === false,       // trend 的 A1 是折溢價變小
    a2: trend?.conditionB?.small === false,       // trend 的 A2 是板塊收斂
    a3: turn?.conditionA3?.growing || false,
    volumeSurge: checkVolumeSurge(),
    eventConfirmed: false,   // 暫不依賴 tv-intel
    ma30Broken: false,
    ma30Breakout: false,
    resistancePattern: lt?.resistanceCheck?.resistanceFound || false,
    supportPattern: st?.supportCheck?.supportFound || false,
  };

  // 從 turn 的 A1/A2 補上（如 growing）
  if (turn?.conditionA1?.growing) ct.a1 = true;
  if (turn?.conditionA2?.growing) ct.a2 = true;
  if (lt?.conditionA1?.growing) ct.a1 = true;
  if (lt?.conditionA2?.growing) ct.a2 = true;
  if (st?.conditionA1?.growing) ct.a1 = true;
  if (st?.conditionA2?.growing) ct.a2 = true;

  // 2. 拉 MA30 狀態
  const ma30 = await checkMA30();
  ct.ma30Broken = ma30.broken;
  ct.ma30Breakout = ma30.breakout;

  // 3. 提取趨勢共識
  const consensus = !!trend?.consensusTrendConfirmed;
  const direction = trend?.trendDirection || null;

  // 4. 狀態轉移
  const cur = state.current;
  let next = cur;
  let reason = '';
  let signal = 'NONE';

  if (cur === '?') {
    if (direction === 'up') next = 'L';
    else if (direction === 'down') next = 'S';
    else next = '?';
    reason = '初始狀態';

  // ═══════════ L 段（上漲） ═══════════
  } else if (cur === 'L' && consensus && direction === 'up') {
    next = 'FL'; reason = '一致上漲趨勢確認'; signal = 'FL';
  } else if (cur === 'L' && consensus && direction === 'down') {
    next = 'S'; reason = '趨勢反轉為下跌'; signal = 'FS';

  // ═══════════ FL（一致上漲） ═══════════
  } else if (cur === 'FL' && ct.a1 && ct.a2 && ct.resistancePattern) {
    next = 'LT'; reason = 'A1小→大, A2分歧, 阻力型態'; signal = 'LT';
  } else if (cur === 'FL' && !consensus) {
    next = 'L'; reason = '一致趨勢消失';
  } else if (cur === 'FL' && consensus && direction === 'down') {
    next = 'SL'; reason = '趨勢反轉為下跌'; signal = 'FS';

  // ═══════════ LT（上漲轉折哨兵） ═══════════
  } else if (cur === 'LT' && ct.a1 && ct.a2 && ct.a3 && ct.ma30Broken) {
    next = 'LTT'; reason = 'A1+A2+A3全過, MA30跌破'; signal = 'LTT';
  } else if (cur === 'LT' && !ct.a1 && !ct.a2) {
    next = 'FL'; reason = '分歧消失，回歸上漲 (假信號)';

  // ═══════════ LTT（一致上漲轉折） ═══════════
  } else if (cur === 'LTT' && state.duration >= 1) {
    next = 'S'; reason = '進入下跌段';

  // ═══════════ S 段（下跌） ═══════════
  } else if (cur === 'S' && consensus && direction === 'down') {
    next = 'SL'; reason = '一致下跌趨勢確認'; signal = 'FS';
  } else if (cur === 'S' && consensus && direction === 'up') {
    next = 'L'; reason = '趨勢反轉為上漲'; signal = 'FL';

  // ═══════════ SL（一致下跌） ═══════════
  } else if (cur === 'SL' && ct.a1 && ct.a2 && ct.supportPattern) {
    next = 'ST'; reason = 'A1小→大, A2分歧, 支撐型態'; signal = 'ST';
  } else if (cur === 'SL' && !consensus) {
    next = 'S'; reason = '一致趨勢消失';
  } else if (cur === 'SL' && consensus && direction === 'up') {
    next = 'FL'; reason = '趨勢反轉為上漲'; signal = 'FL';

  // ═══════════ ST（下跌轉折哨兵） ═══════════
  } else if (cur === 'ST' && ct.a1 && ct.a2 && ct.a3 && ct.ma30Breakout) {
    next = 'STT'; reason = 'A1+A2+A3全過, MA30突破'; signal = 'STT';
  } else if (cur === 'ST' && !ct.a1 && !ct.a2) {
    next = 'SL'; reason = '空頭恢復，回歸下跌 (假信號)';

  // ═══════════ STT（一致下跌轉折） ═══════════
  } else if (cur === 'STT' && state.duration >= 1) {
    next = 'L'; reason = '進入上漲段';
  }

  // 5. 執行轉移
  const changed = transition(state, next, reason);
  state.conditions = ct;

  // 轉移時才更新 signal，否則保留上一次的
  if (signal !== 'NONE') {
    state.lastSignal = signal;
  }

  saveState(state);

  // 摘要
  const summary = changed
    ? `${state.previous||'?'} → ${state.current}: ${reason}`
    : `${state.current} (x${state.duration}): ${reason || '無變化'}`;

  // 數據源
  const srcParts = [];
  srcParts.push(consensus ? '共識✅' : '共識❌');
  srcParts.push('A1:' + (ct.a1 ? '小→大' : '正常'));
  srcParts.push('A2:' + (ct.a2 ? '分歧' : '正常'));
  srcParts.push('A3:' + (ct.a3 ? '四級分歧' : '—'));
  srcParts.push('放量:' + (ct.volumeSurge ? '異常' : '正常'));
  srcParts.push('MA30:' + (ct.ma30Broken ? '跌破' : ct.ma30Breakout ? '突破' : '正常'));
  srcParts.push('阻力:' + (ct.resistancePattern ? '有' : '無'));
  srcParts.push('支撐:' + (ct.supportPattern ? '有' : '無'));
  srcParts.push('事件:' + (ct.eventConfirmed ? '有' : '無'));

  const result = {
    current: state.current,
    previous: state.previous,
    changed,
    changedAt: state.changedAt,
    duration: state.duration,
    reason,
    signal: state.lastSignal || 'NONE',
    triggered: changed,
    summary,
    sources: srcParts.join(' | '),
    conditions: ct,
    transitionsCount: state.transitions.length,
  };

  return result;
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (key) => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : null;
  };
  const parse = (str) => {
    try {
      return str ? JSON.parse(str) : {};
    } catch {
      return {};
    }
  };

  const trend = parse(getArg('--trend'));
  const turn = parse(getArg('--turn'));
  const lt = parse(getArg('--lt'));
  const st = parse(getArg('--st'));

  run(trend, turn, lt, st)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((e) => console.error(JSON.stringify({ error: e.message })));
}

module.exports = { run };
