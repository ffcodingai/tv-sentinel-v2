/**
 * 一致趨勢行情（上漲 / 下跌）— 執行引擎（v2）
 *
 * 資料皆從 agent 讀取，不自算門檻值。
 *
 * 條件：
 *   A1. tv-correlation → 折溢價變小（global_spread_agg status=差值小）
 *   A2. tv-turn → 板塊折溢價關係變小（SPREAD_TREND=縮小/穩定）
 *   B.  商品技術共識 — 持續流動商品(金/銀/銅/油/BTC/匯率) 一致放量+技術位突破
 *   C.  當日熱點事件 — 地緣/Fed/經濟數據
 *
 * 跨天追蹤：HKT 05:00 切割，狀態持久化。
 *
 * Usage:
 *   node executor-trend.js                ← 當前時間
 *   node executor-trend.js --at="..."     ← 歷史回測
 *   node executor-trend.js --json         ← JSON 輸出
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const h = require('./tools/helpers');
const a = require('./tools/apis');
// ── 數據源 ──
const TRACKING_DB_PATH = path.join(__dirname, 'tracking-state-v2.json');

// ── 持續流動商品清單 ──
const LIQUID_COMMODITIES = {
  precious_metals: { label:'貴金屬', symbols: ['IG:CFDGOLD','IG:CFDSILVER','IG:COPPER'] },
  crude_oil:       { label:'原油',   symbols: ['IG:CL','IG:LCO','IG:SC0'] },
  crypto:          { label:'Crypto', symbols: ['BTC_SPOT','ETH_SPOT','SOL_SPOT'] },
  forex:           { label:'匯率',   symbols: ['CNH_FX','JPY_FX','AUD_FX','EUR_FX','GBP_FX','CHF_FX','CAD_FX'] },
};

// ── 跨天追蹤 ──
function loadTrackingState() {
  try {
    if (fs.existsSync(TRACKING_DB_PATH)) return JSON.parse(fs.readFileSync(TRACKING_DB_PATH, 'utf-8'));
  } catch {}
  return { dateKey: null, conditions: {}, durationCount: 0 };
}

function saveTrackingState(state) {
  try { fs.writeFileSync(TRACKING_DB_PATH, JSON.stringify(state, null, 2), 'utf-8'); } catch {}
}

// ══════════════════════════════════════════
//  Data Fetching
// ══════════════════════════════════════════

/**
 * A1: tv-correlation — 讀 global_spread_agg 折溢價狀態
 * 取最近幾筆，看是否折溢價變小（差值小 或 從大→小）
 */
async function fetchSpreadTrend() {
  try {
    const now = Date.now();
    const s = encodeURIComponent(h.fmtHkt(now - 7200000));
    const e = encodeURIComponent(h.fmtHkt(now));
    const data = await a.fetchSpreadAgg(5);
    if (!data?.results?.length) return { available: false, message: 'tv-correlation 無數據' };

    const recs = data.results.map(r => {
      const v = JSON.parse(r.ai_data.value);
      const sp = v.rocSpread || {};
      return { time: r.ai_data.closeTime, status: sp.status, value: sp.value, percentile: sp.percentile, strongest: sp.strongest, weakest: sp.weakest };
    }).filter(r => r.status);
    if (recs.length < 2) return { available: true, small: false, message: '不夠比對（<2筆）', records: recs };

    recs.sort((a,b) => a.time - b.time);
    const latest = recs[recs.length - 1];
    const prev = recs[recs.length - 2];

    // 判定折溢價變小: 最新狀態=差值小 或 從大→小
    const isSmall = latest.status === '差值小';
    const transitioning = prev?.status === '差值大' && latest.status !== '差值大';
    const small = isSmall || transitioning;

    return {
      available: true, small, status: latest.status, value: latest.value, percentile: latest.percentile,
      transition: transitioning ? `${prev.status}→${latest.status}` : null,
      records: recs.slice(-3),
      strongest: latest.strongest, weakest: latest.weakest,
      message: small
        ? `✅ tv-correlation: 折溢價變小 (${latest.status})`
        : `⚠️ tv-correlation: 折溢價仍大 (${latest.status})`,
    };
  } catch { return { available: false, message: 'tv-correlation 讀取錯誤' }; }
}

/**
 * A2: tv-turn — 讀 sector SPREAD_TREND 是否收斂
 */
async function fetchSectorSpread() {
  try {
    const activeMarkets = h.getActiveMarkets().markets;
    const raw = await a.fetchSectorSpread(activeMarkets.length ? activeMarkets : null, 1);
    const allResults = [];
    for (const entry of raw) {
      for (const [code, st] of Object.entries(entry.spreads)) {
        allResults.push({ market: code, flag: h.COUNTRY_FLAGS[code]||'', spreadTrend: st });
      }
    }

    if (!allResults.length) return { available: false, message: 'tv-turn 暫無板塊折溢價數據' };

    const smallCount = allResults.filter(r => r.spreadTrend === '缩小' || r.spreadTrend === '稳定').length;
    const allSmall = smallCount === allResults.length;
    const majoritySmall = (smallCount / allResults.length) >= 0.6;

    return {
      available: true, small: majoritySmall, allSmall, smallCount, totalCount: allResults.length,
      results: allResults,
      message: allSmall
        ? `✅ tv-turn: 全部板塊折溢價收斂 (${allResults.length}市場)`
        : majoritySmall
          ? `✅ tv-turn: ${smallCount}/${allResults.length}市場收斂`
          : `⚠️ tv-turn: 僅${smallCount}/${allResults.length}市場收斂`,
    };
  } catch { return { available: false, message: 'tv-turn 讀取錯誤' }; }
}

/**
 * B: 商品技術共識 — 放量 + MA 突破
 */
async function fetchCommodityConsensus() {
  const result = { available: false, volumeSurge: [], technicalBreakouts: [], consensusReached: false, message: '' };

  try {
    const volData = a.fetchVolumeSurge();
    for (const entry of (volData.segments || [])) {
        const d = Array.isArray(entry) ? entry[1] : entry;
        if (!d || d.status !== 'active') continue;
        const sym = d.symbol || '';
        const ratio = d.ratio || 0;
        if (ratio < 1.2) continue;
        for (const cat of Object.values(LIQUID_COMMODITIES)) {
          if (cat.symbols.some(s => sym.includes(s) || s.includes(sym))) {
            result.volumeSurge.push({ symbol: sym, category: cat.label, ratio, hourKey: d.hourKey || '' });
            break;
          }
        }
      }
  } catch {}

  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 86400 * 250;
    const allSyms = Object.values(LIQUID_COMMODITIES).flatMap(c => c.symbols);
    const queries = allSyms.map(sym =>
      a.fetchKlineHistory(sym, "D", from, now)
        .then(data => ({ sym, data })).catch(() => ({ sym, data: null }))
    );
    const responses = await Promise.all(queries);
    for (const { sym, data } of responses) {
      if (!data?.c?.length || data.c.length < 30) continue;
      const closes = data.c.filter(v => v != null);
      if (closes.length < 20) continue;
      const last = closes[closes.length - 1];
      if (!last) continue;
      const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0) / 20;
      const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((a,b)=>a+b,0) / 50 : null;
      const ma200 = closes.length >= 200 ? closes.slice(-200).reduce((a,b)=>a+b,0) / 200 : null;
      const breaks = [];
      if (last > ma20 * 1.02) breaks.push(`MA20(${ma20.toFixed(1)})`);
      if (ma50 && last > ma50 * 1.02) breaks.push(`MA50(${ma50.toFixed(1)})`);
      if (ma200 && last > ma200 * 1.02) breaks.push(`MA200(${ma200.toFixed(1)})`);
      if (breaks.length) result.technicalBreakouts.push({ symbol: sym, lastPrice: parseFloat(last.toFixed(2)), breakLevels: breaks });
    }
  } catch {}

  result.consensusReached = result.volumeSurge.length >= 2 && result.technicalBreakouts.length >= 1;
  result.available = result.volumeSurge.length > 0 || result.technicalBreakouts.length > 0;
  const v = result.volumeSurge.map(x => `${x.symbol}(${x.ratio}x)`).join(', ');
  const t = result.technicalBreakouts.map(x => `${x.symbol}突破${x.breakLevels.join(',')}`).join(', ');
  result.message = result.consensusReached ? `🔥 商品技術共識 — 放量:${v} | 突破:${t}` : result.volumeSurge.length ? `⚠️ 僅放量無突破: ${v}` : '➖ 無明顯共識';
  return result;
}

/**
 * C: 當日熱點事件
 */
async function fetchHotEvents() {
  const r = { available: false, events: [], hasCritical: false, message: '' };
  try {
    // 取 HKT 今天的 00:00~23:59
    const now = new Date();
    const hktNow = new Date(now.getTime() + 8 * 3600000);
    const todayStr = `${hktNow.getUTCFullYear()}-${String(hktNow.getUTCMonth()+1).padStart(2,'0')}-${String(hktNow.getUTCDate()).padStart(2,'0')}`;
    const todayStart = new Date(todayStr + 'T00:00:00+08:00').getTime() / 1000;
    const todayEnd   = new Date(todayStr + 'T23:59:59+08:00').getTime() / 1000;

    const raw = await a.fetchNewsEvents(50);
    const items = (raw?.data || []).filter(e => {
      const ts = e.timestamp || 0;
      return ts >= todayStart && ts <= todayEnd;
    });

    if (items.length) {
      r.events = items;
      r.available = true;
    }

    const criticalRe = /\bfed\b|\brate\b.?\bhike\b|\brate\b.?\bcut\b|\binterest\b.?\brate\b|央行|利率|加息|降息|\bcpi\b|通脹|通胀|非农|非農|\bnfp\b|employment|失业|失業|戰爭|\bwar\b|制裁|sanction|地缘|地緣|geopolitical|\bpmi\b|\bgdp\b|贸易战|贸易戰|tariff|衰退|recession|黑天鵝|black.?\bswan\b|\bcrisis\b|选举|選舉|election/i;
    r.hasCritical = r.events.some(e => criticalRe.test(e.title) || criticalRe.test(e.source));
    r.message = r.hasCritical
      ? `🔥 關鍵事件: ${r.events.filter(e => criticalRe.test(e.title)).map(e => e.title.substring(0, 50)).join(' | ')}`
      : r.available
        ? `📋 ${r.events.length}條事件`
        : '➖ 暫無事件數據';
  } catch { r.message = '➖ 事件 API 不可用'; }
  return r;
}

/**
 * 全球指數一致（5類）
 */
function checkFuturesConsistency(futData) {
  const results = [];
  let up=0, down=0, flat=0;
  for (const k of ["FIN","TECH","IND","CD","SMALL"]) {
    const d = futData?.[k];
    if (!d) continue;
    results.push({ market: k, direction: d.direction, slope: d.slope, change: d.change });
    if (d.direction === "up") up++;
    else if (d.direction === "down") down++;
    else flat++;
  }
  const tot = results.length;
  const consistent = tot > 0 && (up === tot || down === tot);
  return { results, consistent, globalDir: up>down?"up":"down", totalUp: up, totalDown: down, mixed: flat, totalM: tot,
    message: consistent
      ? `📊 全球指數一致 ${up===tot?"📈看多":"📉看空"} (${up}↑/${down}↓/${flat}—, ${tot}類)`
      : `⚠️ 全球指數分歧 (${up}↑/${down}↓/${flat}—, ${tot}類)` };
}

// ══════════════════════════════════════════
//  Main// ══════════════════════════════════════════
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
    conditionA: null, conditionB: null, conditionC: null, conditionD: null,
    consensusTrendConfirmed: false, trendDirection: null, reason: '', tracking: null,
  };

  const {h:hktH, m:hktM} = h.getHktTime(atStr);
  const {sessions, markets} = h.getActiveMarkets();

  result.steps.push({ step:1, name:'時區檢測', status:sessions.length?'pass':'fail', detail:sessions.map(s=>s.id).join(' + ')||'休市' });
  result.steps.push({ step:2, name:'開盤市場', status:markets.length?'pass':'fail', detail:`${markets.length}市場: ${markets.join(', ')}` });
  if (!markets.length) { result.reason = '休市'; return result; }

  // A1: tv-correlation 折溢價變小
  const a1 = await fetchSpreadTrend();
  result.conditionA = a1;
  result.steps.push({ step:3, name:'A1: tv-correlation 折溢價變小', status: a1.small?'pass':(a1.available?'warn':'fail'), detail: a1.message });

  // A2: tv-turn 板塊折溢價收斂
  const a2 = await fetchSectorSpread();
  result.conditionB = a2;
  result.steps.push({ step:4, name:'A2: tv-turn 板塊折溢價收斂', status: a2.small?'pass':(a2.available?'warn':'fail'), detail: a2.message });

  // B: 商品技術共識
  const b = await fetchCommodityConsensus();
  result.conditionC = b;
  result.steps.push({ step:5, name:'B: 商品技術共識', status: b.consensusReached?'pass':(b.available?'warn':'info'), detail: b.message });

  // C: 熱點事件
  const c = await fetchHotEvents();
  result.conditionD = c;
  result.steps.push({ step:6, name:'C: 當日熱點事件', status: c.hasCritical?'warn':(c.available?'info':'info'), detail: c.message });

  // 全球指數一致
  const futData = await a.fetchFuturesIndexes();
  const globalM = futData ? checkFuturesConsistency(futData) : { consistent: false, globalDir: null, message: '無法獲取指數數據', results: [], totalUp:0, totalDown:0, mixed:0, totalM:0 };
  result.steps.push({ step:7, name:'全球指數一致(5類)', status: globalM.consistent?'pass':'warn', detail: globalM.message, allMarkets: globalM.results });

  // 最終判定
  const aOk = a1.small && a2.small;
  const dOk = globalM.consistent;
  const confirmed = aOk && dOk;
  const dir = globalM.consistent ? globalM.globalDir : (globalM.totalUp > globalM.totalDown ? 'up' : 'down');

  result.consensusTrendConfirmed = confirmed;
  result.trendDirection = dir;

  const good = [];
  const bad = [];
  
  // A1: 折溢價
  const a1Status = a1.small ? '✅' : '⏸️';
  const a1Msg = a1.available ? `${a1Status} A1${a1.small?'收斂':'未收斂'}(${a1.status||'?'})` : '❌ A1無數據';
  if (a1.small) good.push(a1Msg); else bad.push(a1Msg);
  
  // A2: 板塊收斂
  const a2Status = a2.small ? '✅' : '⏸️';
  const a2Msg = a2.available ? `${a2Status} A2${a2.small?'收斂':'未收斂'}(${a2.smallCount||0}/${a2.totalCount||0})` : '❌ A2無數據';
  if (a2.small) good.push(a2Msg); else bad.push(a2Msg);
  
  // B: 商品共識
  if (b.consensusReached) good.push('✅ B商品共識');
  else if (b.available) bad.push(`⏸️ B僅放量(${(b.volumeSurge||[]).length}品)`);
  
  // C: 事件
  if (c.hasCritical) good.push('✅ C關鍵事件');
  else if (c.available) bad.push(`⏸️ C${c.events.length}條事件(無關鍵)`);
  else bad.push(`⏸️ C無事件`);
  
  // 全球指數一致
  const gMsg = dOk ? `✅ 全球指數一致${globalM.globalDir==='up'?'📈':'📉'}` : `⏸️ 全球指數分歧(${globalM.totalUp||0}↑/${globalM.totalDown||0}↓/${globalM.mixed||0}—)`;
  if (dOk) good.push(gMsg); else bad.push(gMsg);

  result.steps.push({
    step:8, name:'一致趨勢判定', status: confirmed?'pass':'warn',
    detail: confirmed
      ? `🟢 一致趨勢確認 — ${dir==='up'?'📈上漲':'📉下跌'} ${good.join(' | ')}`
      : `⏸️ 條件不足 ${bad.join(' | ')}`,
  });

  // 跨天追蹤
  const state = loadTrackingState();
  if (state.dateKey !== result.dateKey) { state.dateKey = result.dateKey; state.conditions = {}; state.durationCount = 0; }
  state.conditions = { ...state.conditions, consensusTrendConfirmed: confirmed, direction: dir, a1: a1.small, a2: a2.small, signal: result.signal };
  state.durationCount++;
  saveTrackingState(state);
  result.tracking = state;
  result.steps.push({ step:9, name:'跨天追蹤', status:'info', detail: `📅 ${result.dateKey} 第${state.durationCount}次檢查` });

  result.reason = confirmed
    ? `🟢 趨勢確認 ${good.join(' | ')}`
    : `${good.length ? good.join(' | ') + ' | ' : ''}${bad.join(' | ')}`;

  result.signal = result.consensusTrendConfirmed ? (result.trendDirection === 'up' ? 'FL' : 'FS') : 'NONE';

  // 資料源質量
  const activeMkts = h.getActiveMarkets().markets;
  const a1Recs = a1?.records?.length || 0;
  const a2Mkts = a2?.totalCount || 0;
  const newsTotal = c?.events?.length || 0;
  const surgeCount = b?.volumeSurge?.length || 0;
  const srcParts = [];
  srcParts.push('A1:' + a1Recs + '筆');
  if (!a1?.available) srcParts[srcParts.length-1] = '⚠️ ' + srcParts[srcParts.length-1] + '(無數據)';
  srcParts.push('A2:' + a2Mkts + '市場');
  if (!a2?.available) srcParts[srcParts.length-1] = '⚠️ ' + srcParts[srcParts.length-1] + '(無數據)';
  srcParts.push('B:放量' + surgeCount + '品');
  srcParts.push('C:' + newsTotal + '條');
  if (!c?.available) srcParts[srcParts.length-1] = '⚠️ ' + srcParts[srcParts.length-1] + '(無數據)';
  srcParts.push('全球:' + (globalM?.results?.length||0) + '/5類');
  if (!futData) srcParts[srcParts.length-1] = '⚠️ ' + srcParts[srcParts.length-1] + '(無數據)';
  result.sources = srcParts.join(' | ');

  if (!jsonMode) {
    log(`
═════ 一致趨勢行情 ═════`);
    log(`確認: ${confirmed?'🟢是':'⚠️否'} | 方向: ${dir==='up'?'📈上漲':'📉下跌'}`);
    log(`跨天: ${state.durationCount}次`); log('═══════════════════════');
  }
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const atI = args.indexOf('--at');
  const atStr = atI>=0 ? args[atI+1] : null;
  main({ at:atStr, json:args.includes('--json') }).then(r => { if (args.includes('--json')) console.log(JSON.stringify(r,null,2)); }).catch(e => console.error(e.message));
}

module.exports = { main };
