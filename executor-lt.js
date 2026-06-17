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

const http = require('http');
const fs = require('fs');
const path = require('path');

// ── Config ──
const SIGNAL_DB = 'http://192.168.25.127:8285';
const INDEX_SERVER = 'http://localhost:3334';
const KLINE_SERVER = 'http://localhost:4002';
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';
const TRACKING_DB_PATH = path.join(__dirname, 'tracking-state.json');

const SESSIONS = [
  { id:'ASIA',   label:'亞洲時段', countries:['JP','KR','TW','AU','CN','HK','SG'], startH:8,  endH:15 },
  { id:'CHINA',  label:'中國時段', countries:['CN','HK'], startH:9.5, endH:16 },
  { id:'EUROPE', label:'歐洲時段', countries:['UK','FR','DE','CH','NL','ES','IT'], startH:15, endH:23.5 },
  { id:'US',     label:'美國時段', countries:['US','US_SM'], startH:21.5, endH:4 },
];
const ALL_COUNTRIES = ['US','US_SM','UK','FR','DE','JP','KR','TW','CN','HK'];
const COUNTRY_FLAGS = {
  UK:'🇬🇧',FR:'🇫🇷',DE:'🇩🇪',US:'🇺🇸',US_SM:'🇺🇸',CN:'🇨🇳',
  HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',CH:'🇨🇭',NL:'🇳🇱',ES:'🇪🇸',IT:'🇮🇹',AU:'🇦🇺',SG:'🇸🇬'
};
const SECTOR_CN = {
  IT:'科技',FIN:'金融',CD:'可選消費',TELECOM:'通信',IND:'工業',
  CONS:'必需消費',MED:'醫療',ENR:'能源',CHEM:'化工',METAL:'金屬採礦'
};

// ══════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════

function getHktTime(atStr) {
  if (atStr) { const d = new Date(atStr); return { h:d.getHours(), m:d.getMinutes(), ts:d.getTime() }; }
  const now = new Date(Date.now() + 8*3600000);
  return { h:now.getUTCHours(), m:now.getUTCMinutes(), ts:now.getTime() };
}

function getHktDateKey(ts) {
  const d = new Date(ts + 8*3600000);
  const p = n => String(n).padStart(2, '0');
  const hr = d.getUTCHours();
  if (hr < 5) {
    const prev = new Date(d.getTime() - 86400000);
    return `${prev.getUTCFullYear()}${p(prev.getUTCMonth()+1)}${p(prev.getUTCDate())}`;
  }
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}

function fmtHkt(ts) {
  const d = new Date(ts + 8*3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function getActiveSessions(hktH, hktM) {
  const h = hktH + hktM/60;
  return SESSIONS.filter(s => {
    if (s.endH <= s.startH) return h >= s.startH || h < s.endH;
    return h >= s.startH && h < s.endH;
  });
}

function getActiveMarkets(hktH, hktM) {
  const sessions = getActiveSessions(hktH, hktM);
  const set = new Set();
  for (const s of sessions) s.countries.forEach(c => set.add(c));
  return { sessions, markets: [...set] };
}

function httpGet(url, timeout=5000) {
  return new Promise((resolve) => {
    const req = http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

// ══════════════════════════════════════════
//  Data Fetching
// ══════════════════════════════════════════

/**
 * 檢查一致趨勢行情是否已確認
 * 從 tracking-state.json 讀取
 */
function checkTrendConfirmed() {
  try {
    if (fs.existsSync(TRACKING_DB_PATH)) {
      const state = JSON.parse(fs.readFileSync(TRACKING_DB_PATH, 'utf-8'));
      if (state.conditions?.consensusTrendConfirmed && state.dateKey === getHktDateKey(Date.now())) {
        return { confirmed: true, direction: state.conditions.direction, dateKey: state.dateKey, duration: state.durationCount || 0 };
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
    const s = encodeURIComponent(fmtHkt(now - 7200000));
    const e = encodeURIComponent(fmtHkt(now));
    const data = await httpGet(`${SIGNAL_DB}/signal/data/list?startTime=${s}&endTime=${e}&symbol=global_spread_agg&pageSize=5`, 4000);
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
    const now = Date.now();
    const s = encodeURIComponent(fmtHkt(now - 3600000));
    const e = encodeURIComponent(fmtHkt(now));
    const data = await httpGet(`${SIGNAL_DB}/signal/data/list?symbol=asia_sector&pageSize=3&startTime=${s}&endTime=${e}`, 4000);
    if (!data?.results?.length) return { available: false, growing: false, message: 'tv-turn 無數據' };

    // Get prev and latest
    const recs = data.results.map(r => {
      const ms = JSON.parse(r.ai_data.value)?.MARKETS_SECTOR || {};
      const spreads = {};
      for (const code of Object.keys(ms)) { spreads[code] = ms[code]?.SPREAD_TREND; }
      return { time: r.ai_data.closeTime, spreads };
    }).filter(r => Object.values(r.spreads).some(s => s));
    if (recs.length < 2) return { available: true, growing: false, message: '不夠比對', results: recs.map(r => r.spreads) };

    recs.sort((a,b) => a.time - b.time);
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
      details.push({ market: code, flag: COUNTRY_FLAGS[code]||'', from: ps, to: ls, growing: isGrowing });
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
    const data = JSON.parse(fs.readFileSync(ROTATION_UI_PATH, 'utf-8'));
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
        market: m, flag: COUNTRY_FLAGS[m]||'', label: countries[m]?.label||m,
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
      longs.push({ market: m, flag: COUNTRY_FLAGS[m]||'', sectors: up });
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
    const volData = JSON.parse(fs.readFileSync(VOLUME_SURGE_PATH, 'utf-8'));
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
      const priceData = await httpGet(`${INDEX_SERVER}/api/data`, 2000);
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
    dateKey: getHktDateKey(atStr ? new Date(atStr).getTime() : Date.now()),
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

  const { h, m } = getHktTime(atStr);
  const { sessions, markets } = getActiveMarkets(h, m);

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
    result.ltTriggered = false;
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
  try {
    if (fs.existsSync(ROTATION_UI_PATH)) rotData = JSON.parse(fs.readFileSync(ROTATION_UI_PATH, 'utf-8'));
  } catch {}
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
    log(`\n═════ LT 上漲轉折哨兵 ═════`);
    log(`時間: ${result.atTime}`);
    log(`前提趨勢: ${trend.confirmed ? '🟢 確認' : '🔴 未確認'} (${trend.direction||'?'})`);
    log(`觸發: ${triggered ? '🚨 是' : '✅ 否'}`);
    log(`原因: ${result.ltReason}`);
    for (const s of result.steps) {
      const ic = { pass:'✅', warn:'⚠️', fail:'❌', trigger:'🔴', info:'💬' }[s.status] || '❓';
      log(`  ${ic} Step ${s.step}: ${s.name} — ${(s.detail||'').substring(0,60)}`);
    }
    if (longPositions.length) log(`📋 ${longPositions.length}個多頭市場`);
    log('════════════════════════════\n');
  }

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
