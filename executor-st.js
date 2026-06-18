/**
 * ST 下跌轉折哨兵 — 執行引擎（v2）
 *
 * 前提：一致趨勢行情已確認（下跌趨勢中）
 *
 * 觸發流程（與 LT 鏡像，處下跌時觸發）：
 *   ① 前提檢查：一致趨勢行情（下跌）已確認
 *   ② A1: tv-correlation 折溢價由小變大
 *   ③ 查 ai-turn：一級板塊折溢價由小變大
 *   ④ 記錄當前【空頭名單】
 *   ⑤ 追蹤：空頭名單變化（板塊方向更新）
 *   ⑥ 檢查「上批空頭產品」形成支撐型態（V底/A底/W底/平台）
 *   ⑦ 支撐成立 → 🚨 ST 觸發
 *
 * Usage:
 *   node executor-st.js                ← 當前時間
 *   node executor-st.js --at="..."     ← 歷史回測
 *   node executor-st.js --json         ← JSON 輸出
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
    if (recs.length < 2) return { available: true, growing: false, message: '不夠比對（<2筆）' };
    recs.sort((a,b) => a.time - b.time);
    const latest = recs[recs.length - 1];
    const prev = recs[recs.length - 2];
    const wasSmall = prev.status === '差值小' || prev.status === '均等';
    const nowLarge = latest.status === '差值大';
    const growing = wasSmall && nowLarge;
    const pctGrowing = latest.percentile > prev.percentile && latest.percentile > 0.6;
    return {
      available: true, growing: growing || pctGrowing, was: prev.status, now: latest.status,
      prevPct: prev.percentile, currPct: latest.percentile,
      records: recs,
      message: growing ? `🔥 tv-correlation: 折溢價由小變大 (${prev.status}→${latest.status})` : `➖ tv-correlation: 折溢價未明顯擴大 (${prev.status}→${latest.status})`,
    };
  } catch { return { available: false, growing: false, message: 'tv-correlation 讀取錯誤' }; }
}

async function checkSectorSpreadGrowing() {
  try {
    const activeMarkets = h.getActiveMarkets().markets;
    const raw = await a.fetchSectorSpread(activeMarkets.length ? activeMarkets : null, 3);
    if (raw.length < 2) return { available: true, growing: false, message: '不夠比對' };
    const recs = raw.map(r => ({ time: r.time, spreads: r.spreads })).sort((a,b) => a.time - b.time);
    const latest = recs[recs.length - 1];
    const prev = recs[recs.length - 2];
    let growingCount = 0, totalCount = 0;
    const details = [];
    for (const code of Object.keys(latest.spreads)) {
      const ls = latest.spreads[code], ps = prev.spreads[code];
      if (!ls || !ps) continue;
      totalCount++;
      const isGrowing = (ps === '缩小' || ps === '稳定') && ls === '扩大';
      if (isGrowing) growingCount++;
      details.push({ market: code, flag: h.COUNTRY_FLAGS[code]||'', from: ps, to: ls, growing: isGrowing });
    }
    const majorityGrowing = totalCount > 0 && (growingCount / totalCount) >= 0.5;
    return { available: totalCount > 0, growing: majorityGrowing, growingCount, totalCount, details: details.slice(0,6),
      message: majorityGrowing ? `🔥 tv-turn: ${growingCount}/${totalCount}市場折溢價擴大` : `➖ tv-turn: 僅${growingCount}/${totalCount}市場擴大` };
  } catch { return { available: false, growing: false, message: 'tv-turn 讀取錯誤' }; }
}

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
        dirs[sn] = hasUp ? 'UP' : (hasDown ? 'DOWN' : (hasMulti ? 'MULTI' : 'NEUTRAL'));
      }
      details.push({ market: m, flag: h.COUNTRY_FLAGS[m]||'', label: countries[m]?.label||m, divergent: marketDivergent, groups: dirs });
    }
    return { available: details.length > 0, growing: hasDivergence, details,
      message: hasDivergence ? `⚠️ 四級板塊分歧 — IT 子類方向不一` : `✅ 四級板塊一致 — IT 子類同方向` };
  } catch { return { available: false, growing: false, message: '四級板塊無數據' }; }
}

/**
 * 空頭名單分析：從 ai-turn 讀一級板塊空方方向（DOWN=空頭）
 */
function analyzeShortPositions(rotData, markets) {
  const shorts = [];
  for (const m of markets) {
    const c = rotData?.countries?.[m];
    if (!c?.sector) continue;
    const down = c.sector.DOWN || [];
    if (down.length > 0) {
      shorts.push({ market: m, flag: h.COUNTRY_FLAGS[m]||'', sectors: down });
    }
  }
  return shorts;
}

/**
 * 支撐檢查（ST 專用）：比 LT 的阻力鏡像，找 V底/A底/W底
 * 用價格數據檢查是否形成支撐型態
 */
async function checkSupport(previousShorts) {
  const results = { supportFound: false, patterns: [] };
  if (!previousShorts?.length) return results;

  try {
    const volData = a.fetchVolumeSurge();
    const segments = volData.segments || [];
    for (const entry of segments) {
      const data = Array.isArray(entry) ? entry[1] : entry;
      if (!data || data.status !== 'active') continue;
      const sym = data.symbol || '';
      const ratio = data.ratio || 0;
      if (ratio < 1.0) continue;

      const priceData = await a.fetchCompositeIndex();
      if (!priceData?.indexData?.length) continue;
      const bars = priceData.indexData.slice(-60);
      const lows = bars.map(b => b.value).filter(v => v != null);
      if (lows.length < 10) continue;

      // 簡單支撐檢測：最近低點附近測試次數
      const recentLow = Math.min(...lows);
      const touchCount = lows.filter(v => Math.abs(v - recentLow) / recentLow < 0.01).length;
      if (touchCount >= 2) {
        results.patterns.push({ symbol: sym, ratio, support: parseFloat(recentLow.toFixed(2)), touches: touchCount, pattern: touchCount >= 3 ? 'W底' : 'V底' });
        results.supportFound = true;
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
    stTriggered: false,
    stStage: 'st_pending',
    stReason: '',
    prerequisiteMet: false,
    conditionA1: null,
    conditionA2: null,
    conditionA3: null,
    shortPositions: [],
    supportCheck: null,
    snapshot: null,
  };

  const {h:hktH, m:hktM} = h.getHktTime(atStr);
  const { sessions, markets } = h.getActiveMarkets();

  result.steps.push({ step: 1, name: '時區檢測', status: sessions.length > 0 ? 'pass' : 'fail',
    detail: sessions.map(s => s.label).join(' + ') || '休市' });
  result.steps.push({ step: 2, name: '開盤市場', status: markets.length > 0 ? 'pass' : 'fail',
    detail: `${markets.length}市場: ${markets.join(', ')}` });
  if (markets.length === 0) { result.stReason = '休市'; return result; }

  // Step 3: 前提 — 一致趨勢行情（必須是下跌）
  const trend = checkTrendConfirmed();
  result.prerequisiteMet = trend.confirmed;
  result.steps.push({
    step: 3, name: '前提: 一致趨勢行情',
    status: trend.confirmed && trend.direction === 'down' ? 'pass' : 'fail',
    detail: trend.confirmed && trend.direction === 'down'
      ? `✅ 一致下跌趨勢確認 (Day ${trend.dateKey}, ${trend.duration}次追蹤)`
      : trend.confirmed ? `⚠️ 趨勢為上漲，ST 只監控下跌` : '❌ 無趨勢狀態 (需先執行一致趨勢哨兵)',
  });
  if (!trend.confirmed || trend.direction !== 'down') {
    result.signal = 'NONE';result.stTriggered = false;result.stStage = 'st_pending';result.stReason = '前提不滿足 — 需要一致下跌趨勢';
    return result;
  }

  // Step 4: A1 — tv-correlation 折溢價由小變大
  const spread = await checkSpreadGrowing();
  result.conditionA1 = spread;
  result.steps.push({ step: 4, name: 'A1: tv-correlation 折溢價小→大', status: spread.growing ? 'warn' : 'pass', detail: spread.message });

  // Step 5: A2 — tv-turn 一級板塊折溢價由小變大
  const sectorSpread = await checkSectorSpreadGrowing();
  result.conditionA2 = sectorSpread;
  result.steps.push({ step: 5, name: 'A2: tv-turn 板塊折溢價小→大', status: sectorSpread.growing ? 'warn' : 'pass', detail: sectorSpread.message });

  // Step 6: A3 — 四級板塊由小變大
  const subSector = checkSubSectorGrowing();
  result.conditionA3 = subSector;
  result.steps.push({ step: 6, name: 'A3: 四級板塊小→大', status: subSector.growing ? 'warn' : 'pass', detail: subSector.message });

  // Step 7: 記錄空頭名單
  let rotData = null;
  rotData = a.fetchRotationUI();
  const shortPositions = rotData ? analyzeShortPositions(rotData, markets) : [];
  result.shortPositions = shortPositions;
  result.snapshot = { time: new Date().toISOString(), dateKey: result.dateKey, markets: [...markets], shorts: shortPositions };
  result.steps.push({
    step: 7, name: '空頭名單記錄', status: shortPositions.length > 0 ? 'pass' : 'info',
    detail: shortPositions.length > 0
      ? `📋 ${shortPositions.length}個市場有空頭: ${shortPositions.map(s => `${s.flag}${s.sectors.join(',')}`).join(' | ')}`
      : '➖ 無明顯空頭板塊',
    positions: shortPositions,
  });

  // Step 8: 支撐型態檢查（ST = V底/A底/W底）
  const support = await checkSupport(shortPositions);
  result.supportCheck = support;
  result.steps.push({
    step: 8, name: '支撐型態檢查', status: support.supportFound ? 'warn' : 'pass',
    detail: support.supportFound
      ? `🟢 發現支撐: ${support.patterns.map(p => `${p.symbol}(${p.support},${p.pattern},${p.touches}次)`).join(', ')}`
      : '✅ 未發現明顯支撐型態',
    patterns: support.patterns,
  });

  // Step 9: 最終判定（與 LT 同邏輯）
  const a1Ok = spread.growing;
  const a2Ok = sectorSpread.growing;
  const a3Ok = subSector.growing;
  const hasSupport = support.supportFound;
  const triggered = a1Ok && a2Ok && (a3Ok || hasSupport);
  const reasons = [];
  if (a1Ok) reasons.push('A1折溢價擴大'); else reasons.push('A1未擴大');
  if (a2Ok) reasons.push('A2板塊分歧'); else reasons.push('A2未分歧');
  if (a3Ok) reasons.push('A3四級分歧'); else reasons.push('A3未分歧');
  if (hasSupport) reasons.push('支撐成立');

  result.stTriggered = triggered;
  result.stStage = triggered ? 'st_confirmed' : 'st_pending';
  result.stReason = triggered
    ? `🚨 ST 下跌轉折觸發！${reasons.join(' + ')}`
    : `✅ 未觸發 (${reasons.join(', ')})`;

  result.steps.push({
    step: 9, name: 'ST判定', status: triggered ? 'trigger' : 'pass',
    detail: triggered ? `🚨 下跌結構破壞` : '✅ 下跌結構未破壞',
  });

  if (!jsonMode) {
    log(`
═════ ST 下跌轉折哨兵 ═════`);
    log(`時間: ${result.atTime}`);
    log(`前提趨勢: ${trend.confirmed && trend.direction === 'down' ? '🟢 確認' : '🔴 未確認'} (${trend.direction||'?'})`);
    log(`觸發: ${triggered ? '🚨 是' : '✅ 否'}`);
    log(`原因: ${result.stReason}`);
    for (const s of result.steps) {
      const ic = { pass:'✅', warn:'⚠️', fail:'❌', trigger:'🔴', info:'💬' }[s.status] || '❓';
      log(`  ${ic} Step ${s.step}: ${s.name} — ${(s.detail||'').substring(0,60)}`);
    }
    log('════════════════════════════');
  }

  result.signal = result.stTriggered ? 'ST' : 'NONE';

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
