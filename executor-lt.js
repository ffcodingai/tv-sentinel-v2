/**
 * LT 上漲轉折哨兵 — 執行引擎（v2）
 *
 * 前提：一致趨勢行情已確認（上漲趨勢中）
 *
 * 觸發流程：
 *   ① 前提檢查：一致趨勢行情（上漲）是否已確認
 *   ② A1: tv-correlation 折溢價由小變大
 *   ③ 查 ai-turn：一級板塊溢價大 + 全部市場一致
 *   ④ 記錄當前【多頭名單】
 *   ⑤ 追蹤：多頭名單變化（板塊方向更新）
 *   ⑥ 檢查「上批多頭產品」形成阻力型態（V頂/M頭/平台）
 *   ⑦ 阻力成立 → 🚨 LT 觸發
 *
 * Usage:
 *   node executor-lt.js                ← 當前時間
 *   node executor-lt.js --at="..."     ← 歷史回測
 *   node executor-lt.js --json         ← JSON 輸出
 */

const http = require('http');const h = require('./tools/helpers');
const a = require('./tools/apis');
const fs = require('fs');
const path = require('path');

// ── Config ──
const STATE_MACHINE_PATH = path.join(__dirname, 'state-machine.json');

function checkTrendConfirmed() {
  try {
    if (fs.existsSync(STATE_MACHINE_PATH)) {
      const sm = JSON.parse(fs.readFileSync(STATE_MACHINE_PATH, 'utf-8'));
      const cur = sm.current || '';
      if (cur === 'L') {
        return { confirmed: true, direction: 'up', dateKey: h.getHktDateKey(Date.now()), duration: sm.duration || 0 };
      } else if (cur === 'S') {
        return { confirmed: true, direction: 'down', dateKey: h.getHktDateKey(Date.now()), duration: sm.duration || 0 };
      }
    }
  } catch {}
  return { confirmed: false, direction: null, dateKey: null, duration: 0 };
}

/**
 * A1: tv-correlation 折溢價由小變大
 * 讀 global_spread_agg，比較前後狀態變化
 */
async function checkSpreadGrowing() {
  try {
    const now = Date.now();
    const s = encodeURIComponent(h.fmtHkt(now - 7200000));
    const e = encodeURIComponent(h.fmtHkt(now));
    const data = await a.fetchSpreadAgg(5);
    if (!data?.results?.length) return { available: false, growing: false, message: 'tv-correlation 無數據' };

    const recs = data.results.map(r => {
      const v = JSON.parse(r.ai_data.value);
      const sp = v.rocSpread || {};
      return { time: r.ai_data.closeTime, status: sp.status, value: sp.value, percentile: sp.percentile };
    }).filter(r => r.status);
    if (recs.length < 2) return { available: true, growing: false, message: '不夠比對（<2筆）', records: recs };

    recs.sort((a,b) => a.time - b.time);
    const latest = recs[recs.length - 1];
    const prev = recs[recs.length - 2];

    // 判定由小變大: 前一個是差值小/均等，最新是差值大
    const wasSmall = prev.status === '差值小' || prev.status === '均等';
    const nowLarge = latest.status === '差值大';
    const growing = wasSmall && nowLarge;

    // 或看 percentile 上升趨勢
    const pctGrowing = latest.percentile > prev.percentile && latest.percentile > 0.6;

    return {
      available: true,
      growing: growing || pctGrowing,
      was: prev.status,
      now: latest.status,
      prevPct: prev.percentile,
      currPct: latest.percentile,
      records: recs.slice(-3),
      message: growing
        ? `🔥 tv-correlation: 折溢價由小變大 (${prev.status}→${latest.status})`
        : `➖ tv-correlation: 折溢價未明顯擴大 (${prev.status}→${latest.status})`,
    };
  } catch { return { available: false, growing: false, message: 'tv-correlation 讀取錯誤' }; }
}

/**
 * A2: tv-turn 一級板塊折溢價由小變大
 * 讀 sector API 的 SPREAD_TREND，比對前後變化
 */
async function checkSectorSpreadGrowing() {
  try {
    const activeMarkets = h.getActiveMarkets().markets;
    const raw = await a.fetchSectorSpread(activeMarkets.length ? activeMarkets : null, 3);
    if (raw.length < 2) return { available: true, growing: false, message: '不夠比對' };
    const recs = raw.map(r => ({ time: r.time, spreads: r.spreads })).sort((a,b) => a.time - b.time);
    const latest = recs[recs.length - 1];
    const prev = recs[recs.length - 2];

    // 計算由小變大的市場數
    let growingCount = 0, totalCount = 0;
    const details = [];
    for (const code of Object.keys(latest.spreads)) {
      const ls = latest.spreads[code];
      const ps = prev.spreads[code];
      if (!ls || !ps) continue;
      totalCount++;
      const wasSmall = ps === '缩小' || ps === '稳定';
      const nowLarge = ls === '扩大';
      const isGrowing = wasSmall && nowLarge;
      if (isGrowing) growingCount++;
      details.push({ market: code, flag: h.COUNTRY_FLAGS[code]||'', from: ps, to: ls, growing: isGrowing });
    }

    const majorityGrowing = totalCount > 0 && (growingCount / totalCount) >= 0.5;
    return {
      available: totalCount > 0,
      growing: majorityGrowing,
      growingCount, totalCount,
      details: details.slice(0,6),
      message: majorityGrowing
        ? `🔥 tv-turn: ${growingCount}/${totalCount}市場折溢價擴大`
        : `➖ tv-turn: 僅${growingCount}/${totalCount}市場擴大`,
    };
  } catch { return { available: false, growing: false, message: 'tv-turn 讀取錯誤' }; }
}

/**
 * A3: 開盤四級板塊由小變大
 * 從 rotation UI 讀四級板塊 IT 子類
 */
function checkSubSectorGrowing() {
  try {
    const data = a.fetchRotationUI();
    const countries = data.countries || {};
    let hasDivergence = false;
    const details = [];

    for (const m of ['CN','US','US_SM']) {
      const c = countries[m];
      if (!c?.subSectors?.IT) continue;
      const groups = c.subSectors.IT;
      let marketDivergent = false;
      const dirs = {};

      for (const [gk, g] of Object.entries(groups)) {
        const sn = gk.replace(m+'_IT_','').toUpperCase();
        const hasUp = (g.UP||[]).length > 0;
        const hasDown = (g.DOWN||[]).length > 0;
        const hasMulti = (g.MULTI||[]).length > 0;
        if (hasUp && (hasDown || hasMulti)) { marketDivergent = true; hasDivergence = true; }
        const d = hasUp ? 'UP' : (hasDown ? 'DOWN' : (hasMulti ? 'MULTI' : 'NEUTRAL'));
        dirs[sn] = d;
      }

      details.push({
        market: m, flag: h.COUNTRY_FLAGS[m]||'', label: countries[m]?.label||m,
        divergent: marketDivergent, groups: dirs,
      });
    }

    return {
      available: details.length > 0,
      growing: hasDivergence,
      details,
      message: hasDivergence
        ? `⚠️ 四級板塊分歧 — IT 子類方向不一`
        : `✅ 四級板塊一致 — IT 子類同方向`,
    };
  } catch { return { available: false, growing: false, message: '四級板塊無數據' }; }
}

/**
 * 多頭名單分析：從 ai-turn 讀一級板塊方向
 */
function analyzeLongPositions(rotData, markets) {
  const longs = [];
  for (const m of markets) {
    const c = rotData?.countries?.[m];
    if (!c?.sector) continue;
    const up = c.sector.UP || [];
    if (up.length > 0) {
      longs.push({ market: m, flag: h.COUNTRY_FLAGS[m]||'', sectors: up });
    }
  }
  return longs;
}

/**
 * 阻力檢查：用價格數據檢查上一批多頭產品是否形成阻力型態
 */
async function checkResistance(previousLongs) {
  const results = { resistanceFound: false, patterns: [] };
  if (!previousLongs?.length) return results;

  // 從 volume surge 找多頭產品的價格位置
  try {
    const volData = a.fetchVolumeSurge();
    const segments = volData.segments || [];
    for (const entry of segments) {
      const data = Array.isArray(entry) ? entry[1] : entry;
      if (!data || data.status !== 'active') continue;
      const sym = data.symbol || '';
      const ratio = data.ratio || 0;
      if (ratio < 1.0) continue;

      // 查價格數據檢查阻力型態
      const now = Math.floor(Date.now() / 1000);
      const from = now - 86400; // 1d
      const priceData = await a.fetchCompositeIndex();
      if (!priceData?.indexData?.length) continue;

      const bars = priceData.indexData.slice(-60); // last 60 bars
      const highs = bars.map(b => b.value).filter(v => v != null);
      if (highs.length < 10) continue;

      // 簡單阻力檢測：最近高點附近測試次數
      const recentHigh = Math.max(...highs);
      const touchCount = highs.filter(v => Math.abs(v - recentHigh) / recentHigh < 0.01).length;
      if (touchCount >= 2) {
        results.patterns.push({ symbol: sym, ratio, resistance: parseFloat(recentHigh.toFixed(2)), touches: touchCount });
        results.resistanceFound = true;
      }
    }
  } catch {}

  return results;
}

// ══════════════════════════════════════════
//  Main
// ══════════════════════════════════════════

async function main(options = {}) {
  const atStr = options.at || null;
  const jsonMode = options.json || false;
  const log = jsonMode ? ()=>{} : console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    dateKey: h.getHktDateKey(atStr ? new Date(atStr).getTime() : Date.now()),
    steps: [],
    ltTriggered: false,
    ltStage: 'lt_pending',
    ltReason: '',
    // 條件
    prerequisiteMet: false,
    conditionA1: null,
    conditionA2: null,
    conditionA3: null,
    longPositions: [],
    resistanceCheck: null,
    // 名單快照（持續追蹤用）
    snapshot: null,
  };

  const {h:hktH, m:hktM} = h.getHktTime(atStr);
  const { sessions, markets } = h.getActiveMarkets();

  // Step 1-2: 時區
  result.steps.push({ step: 1, name: '時區檢測', status: sessions.length > 0 ? 'pass' : 'fail',
    detail: sessions.map(s => s.label).join(' + ') || '休市' });
  result.steps.push({ step: 2, name: '開盤市場', status: markets.length > 0 ? 'pass' : 'fail',
    detail: `${markets.length}市場: ${markets.join(', ')}` });
  if (markets.length === 0) { result.ltReason = '休市'; return result; }

  // Step 3: 前提檢查 — 一致趨勢行情已確認
  const trend = checkTrendConfirmed();
  result.prerequisiteMet = trend.confirmed;
  result.steps.push({
    step: 3, name: '前提: 一致趨勢行情',
    status: trend.confirmed ? 'pass' : (trend.dateKey ? 'warn' : 'fail'),
    detail: trend.confirmed
      ? `✅ 一致趨勢行情確認 — ${trend.direction === 'up' ? '📈上漲' : '📉下跌'} (Day ${trend.dateKey}, ${trend.duration}次追蹤)`
      : trend.dateKey ? `⚠️ 趨勢未確認 (日期鍵=${trend.dateKey})` : '❌ 無趨勢狀態 (需先執行一致趨勢哨兵)',
  });
  if (!trend.confirmed) {
    result.signal = 'NONE'; result.ltTriggered = false;
    result.ltStage = 'lt_pending';
    result.ltReason = '前提不滿足 — 一致趨勢行情未確認';
    return result;
  }
  // 方向必須是上漲
  if (trend.direction !== 'up') {
    result.ltTriggered = false;
    result.ltStage = 'lt_pending';
    result.ltReason = '當前趨勢為下跌，LT 只監控上漲轉折';
    return result;
  }

  // Step 4: A1 — tv-correlation 折溢價由小變大
  const spread = await checkSpreadGrowing();
  result.conditionA1 = spread;
  result.steps.push({
    step: 4, name: 'A1: tv-correlation 折溢價小→大',
    status: spread.growing ? 'warn' : (spread.available ? 'pass' : 'fail'),
    detail: spread.message,
  });

  // Step 5: A2 — tv-turn 一級板塊折溢價由小變大
  const sectorSpread = await checkSectorSpreadGrowing();
  result.conditionA2 = sectorSpread;
  result.steps.push({
    step: 5, name: 'A2: tv-turn 板塊折溢價小→大',
    status: sectorSpread.growing ? 'warn' : (sectorSpread.available ? 'pass' : 'fail'),
    detail: sectorSpread.message,
    data: sectorSpread.details,
  });

  // Step 6: A3 — 四級板塊由小變大
  const subSector = checkSubSectorGrowing();
  result.conditionA3 = subSector;
  result.steps.push({
    step: 6, name: 'A3: 四級板塊小→大',
    status: subSector.growing ? 'warn' : (subSector.available ? 'pass' : 'info'),
    detail: subSector.message,
    subSectors: subSector.details,
  });

  // Step 7: 記錄多頭名單
  let rotData = null;
  rotData = a.fetchRotationUI();
  const longPositions = rotData ? analyzeLongPositions(rotData, markets) : [];
  result.longPositions = longPositions;
  result.snapshot = {
    time: new Date().toISOString(),
    dateKey: result.dateKey,
    markets: [...markets],
    longs: longPositions,
    spreadA1: spread.message,
    sectorA2: sectorSpread.message,
  };
  result.steps.push({
    step: 7, name: '多頭名單記錄',
    status: longPositions.length > 0 ? 'pass' : 'info',
    detail: longPositions.length > 0
      ? `📋 ${longPositions.length}個市場有多頭: ${longPositions.map(l => `${l.flag}${l.sectors.join(',')}`).join(' | ')}`
      : '➖ 無明顯多頭板塊',
    positions: longPositions,
  });

  // Step 8: 阻力型態檢查
  const resistance = await checkResistance(longPositions);
  result.resistanceCheck = resistance;
  result.steps.push({
    step: 8, name: '阻力型態檢查',
    status: resistance.resistanceFound ? 'warn' : 'pass',
    detail: resistance.resistanceFound
      ? `🔴 發現阻力: ${resistance.patterns.map(p => `${p.symbol}(${p.resistance},${p.touches}次)`).join(', ')}`
      : '✅ 未發現明顯阻力型態',
    patterns: resistance.patterns,
  });

  // Step 9: 最終判定
  const a1Ok = spread.growing;
  const a2Ok = sectorSpread.growing;
  const a3Ok = subSector.growing;
  const hasResistance = resistance.resistanceFound;

  // 觸發條件：A1+A2 必要 + (A3 或 阻力成立)
  const triggered = a1Ok && a2Ok && (a3Ok || hasResistance);
  const reasons = [];
  if (a1Ok) reasons.push('A1折溢價擴大'); else reasons.push('A1未擴大');
  if (a2Ok) reasons.push('A2板塊分歧'); else reasons.push('A2未分歧');
  if (a3Ok) reasons.push('A3四級分歧'); else reasons.push('A3未分歧');
  if (hasResistance) reasons.push('阻力成立');

  result.ltTriggered = triggered;
  result.ltStage = triggered ? 'lt_confirmed' : 'lt_pending';
  result.ltReason = triggered
    ? `🚨 LT 上漲轉折觸發！${reasons.join(' + ')}`
    : `✅ 未觸發 (${reasons.join(', ')})`;

  result.steps.push({
    step: 9, name: 'LT判定',
    status: triggered ? 'trigger' : 'pass',
    detail: triggered
      ? `🚨 上漲結構破壞 — 折溢價擴大+板塊分歧+${hasResistance?'阻力成立':'四級分歧'}`
      : '✅ 上漲結構未破壞',
  });

  if (!jsonMode) {
    log(`
═════ LT 上漲轉折哨兵 ═════`);
    log(`時間: ${result.atTime}`);
    log(`前提趨勢: ${trend.confirmed ? '🟢 確認' : '🔴 未確認'} (${trend.direction||'?'})`);
    log(`觸發: ${triggered ? '🚨 是' : '✅ 否'}`);
    log(`原因: ${result.ltReason}`);
    for (const s of result.steps) {
      const ic = { pass:'✅', warn:'⚠️', fail:'❌', trigger:'🔴', info:'💬' }[s.status] || '❓';
      log(`  ${ic} Step ${s.step}: ${s.name} — ${(s.detail||'').substring(0,60)}`);
    }
    if (longPositions.length) log(`📋 ${longPositions.length}個多頭市場`);
    log('════════════════════════════');
  }

  result.signal = result.ltTriggered ? 'LT' : 'NONE';

  const srcA1 = spread?.available ? 'A1:' + (spread?.records?.length||0) + '筆' : '⚠️ A1:無數據';
  const srcA2 = sectorSpread?.available ? 'A2:' + (sectorSpread?.totalCount||0) + '市場' : '⚠️ A2:無數據';
  const srcPre = trend?.confirmed ? '前提:趨勢確認' : '⚠️ 前提:趨勢未確認';
  result.sources = [srcA1, srcA2, srcPre].join(' | ');
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const atI = args.indexOf('--at');
  const atStr = atI >= 0 ? args[atI + 1] : null;
  main({ at: atStr, json: args.includes('--json') }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r));
  }).catch(e => console.error(e.message));
}

module.exports = { main };
