/**
 * 一致行情轉折哨兵 — 執行引擎（v2）
 *
 * 前提：一致趨勢行情已確認（上漲或下跌）
 *
 * 條件由小→大時觸發：
 *   A1. tv-correlation 折溢價 小→大
 *   A2. tv-turn 一級板塊 小→大
 *   A3. tv-turn 四級板塊 小→大
 *
 * 觸發 → 🚨 一致行情轉折
 *
 * Usage:
 *   node executor.js                ← 當前時間
 *   node executor.js --at="..."     ← 歷史回測
 *   node executor.js --json         ← JSON 輸出
 */

const http = require('http');const h = require('./tools/helpers');
const a = require('./tools/apis');
const fs = require('fs');
const path = require('path');

const STATE_MACHINE_PATH = path.join(__dirname, 'state-machine.json');

function checkTrendConfirmed() {
  try {
    if (fs.existsSync(STATE_MACHINE_PATH)) {
      const sm = JSON.parse(fs.readFileSync(STATE_MACHINE_PATH, 'utf-8'));
      const cur = sm.current || '';
      if (cur === 'L' || cur === 'FL' || cur === 'LT' || cur === 'LTT') {
        return { confirmed: true, direction: 'up', dateKey: h.getHktDateKey(Date.now()), duration: sm.duration || 0 };
      } else if (cur === 'S' || cur === 'SL' || cur === 'ST' || cur === 'STT') {
        return { confirmed: true, direction: 'down', dateKey: h.getHktDateKey(Date.now()), duration: sm.duration || 0 };
      }
    }
  } catch {}
  return { confirmed: false, direction: null, dateKey: null, duration: 0 };
}

// ── A1: tv-correlation 折溢價由小變大 ──
async function checkSpreadGrowing() {
  try {
    const now = Date.now();
    const s = encodeURIComponent(h.fmtHkt(now - 7200000));
    const e = encodeURIComponent(h.fmtHkt(now));
    const data = await a.fetchSpreadAgg(5);
    if (!data?.results?.length) return { available: false, message: 'tv-correlation 無數據', growing: false };
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
      message: growing ? `🔥 tv-correlation: 由小變大 (${prev.status}→${latest.status})` : `➖ tv-correlation: 未明顯擴大 (${prev.status}→${latest.status})`,
    };
  } catch { return { available: false, growing: false, message: 'tv-correlation 讀取錯誤' }; }
}

// ── A2: tv-turn 一級板塊由小變大 ──
async function checkSectorSpreadGrowing() {
  try {
    const activeMarkets = h.getActiveMarkets().markets;
    const raw = await a.fetchSectorSpread(activeMarkets.length ? activeMarkets : null, 2);
    if (raw.length < 2) return { available: false, growing: false, message: 'tv-turn 不夠比對' };
    const allSpreads = raw.map(r => ({ time: r.time, spreads: r.spreads }));
    allSpreads.sort((a,b) => a.time - b.time);
    const l = allSpreads[allSpreads.length - 1];
    const p = allSpreads[allSpreads.length - 2];
    let growC = 0, totC = 0;
    const details = [];
    for (const code of Object.keys(l.spreads)) {
      const ls = l.spreads[code], ps = p.spreads[code];
      if (!ls || !ps) continue;
      totC++;
      const g = (ps === '缩小' || ps === '稳定') && ls === '扩大';
      if (g) growC++;
      details.push({ market: code, flag: h.COUNTRY_FLAGS[code]||'', from: ps, to: ls, growing: g });
    }
    const majority = totC > 0 && (growC / totC) >= 0.5;
    return { available: totC > 0, growing: majority, growCount: growC, totalCount: totC, details: details.slice(0,6),
      message: majority ? `🔥 tv-turn: ${growC}/${totC}市場由小變大` : `➖ tv-turn: 僅${growC}/${totC}市場擴大` };
  } catch { return { available: false, growing: false, message: 'tv-turn 讀取錯誤' }; }
}

// ── A3: 四級板塊由小變大 ──
function checkSubSectorGrowing() {
  try {
    const data = a.fetchRotationUI();
    const countries = data.countries || {};
    let hasDiv = false;
    const details = [];
    for (const m of ['CN','US','US_SM']) {
      const c = countries[m];
      if (!c?.subSectors?.IT) continue;
      let mDiv = false;
      const dirs = {};
      for (const [gk, g] of Object.entries(c.subSectors.IT)) {
        const sn = gk.replace(m+'_IT_','').toUpperCase();
        const hasU = (g.UP||[]).length > 0;
        const hasD = (g.DOWN||[]).length > 0;
        const hasM = (g.MULTI||[]).length > 0;
        if (hasU && (hasD || hasM)) { mDiv = true; hasDiv = true; }
        dirs[sn] = hasU ? 'UP' : hasD ? 'DOWN' : hasM ? 'MULTI' : 'NEUTRAL';
      }
      details.push({ market: m, flag: h.COUNTRY_FLAGS[m]||'', divergent: mDiv, groups: dirs });
    }
    return { available: details.length > 0, growing: hasDiv, details,
      message: hasDiv ? '⚠️ 四級板塊分歧 — IT子類方向不一' : '✅ 四級板塊一致' };
  } catch { return { available: false, growing: false, message: '四級板塊無數據' }; }
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
    triggered: false, triggerType: null, triggerReason: '',
    prerequisiteMet: false, conditionA1: null, conditionA2: null, conditionA3: null,
  };

  const {h:hktH, m:hktM} = h.getHktTime(atStr);
  const {sessions, markets} = h.getActiveMarkets();

  result.steps.push({ step:1, name:'時區檢測', status:sessions.length?'pass':'fail', detail:sessions.map(s=>s.label).join(' + ')||'休市' });
  result.steps.push({ step:2, name:'開盤市場', status:markets.length?'pass':'fail', detail:`${markets.length}市場: ${markets.join(', ')}` });
  if (!markets.length) { result.signal = 'NONE';result.triggerReason = '休市';return result; }

  // Step 3: 前提 — 一致趨勢行情已確認
  const trend = checkTrendConfirmed();
  result.prerequisiteMet = trend.confirmed && trend.direction;
  result.steps.push({
    step:3, name:'前提: 一致趨勢行情', status: trend.confirmed?'pass':'fail',
    detail: trend.confirmed ? `✅ ${trend.direction==='up'?'📈上漲':'📉下跌'}趨勢確認 (Day${trend.dateKey})` : '❌ 無趨勢狀態 (需先執行一致趨勢哨兵)',
  });
  if (!trend.confirmed) {
    result.signal = 'NONE';result.triggered = false;result.triggerReason = '前提不滿足 — 一致趨勢行情未確認';
    return result;
  }

  // A1: tv-correlation 由小變大
  const a1 = await checkSpreadGrowing();
  result.conditionA1 = a1;
  result.steps.push({ step:4, name:'A1: tv-correlation 小→大', status:a1.growing?'warn':'pass', detail:a1.message });

  // A2: tv-turn 一級板塊 由小變大
  const a2 = await checkSectorSpreadGrowing();
  result.conditionA2 = a2;
  result.steps.push({ step:5, name:'A2: tv-turn 一級板塊 小→大', status:a2.growing?'warn':'pass', detail:a2.message });

  // A3: 四級板塊 由小變大
  const a3 = checkSubSectorGrowing();
  result.conditionA3 = a3;
  result.steps.push({ step:6, name:'A3: 四級板塊 小→大', status:a3.growing?'warn':'pass', detail:a3.message });

  // 最終判定
  const triggered = a1.growing && a2.growing && a3.growing;
  result.triggered = triggered;
  result.triggerType = triggered ? `${trend.direction==='up'?'📉下跌':'📈上漲'}轉折` : null;

  const reasons = [];
  if (a1.growing) reasons.push('A1擴大');
  if (a2.growing) reasons.push('A2分歧');
  if (a3.growing) reasons.push('A3四級分歧');
  result.signal = triggered ? (result.triggerType && result.triggerType.includes('下跌') ? 'STT' : 'LTT') : 'NONE';
  result.sources = 'A1:' + (a1?.records?.length||0) + '筆 | A2:' + (a2?.totalCount||0) + '市場 | ' + (trend?.confirmed?'前提:趨勢確認':'⚠️ 前提:趨勢未確認');
  result.triggerReason = triggered ? `🚨 一致行情轉折！${reasons.join(' + ')}` : `✅ 未觸發 (${['A1','A2','A3'].map((k,i)=>[a1,a2,a3][i].growing?`${k}✅`:`${k}➖`).join(', ')})`;

  result.steps.push({ step:7, name:'轉折判定', status:triggered?'trigger':'pass',
    detail: triggered ? `🚨 折溢價擴大+板塊分歧+四級分歧 → ${result.triggerType}` : '✅ 條件未滿足' });

  if (!jsonMode) {
    log(`
═════ 一致行情轉折哨兵 ═════`);
    log(`前提趨勢: ${trend.direction||'?'} ${trend.confirmed?'🟢':'🔴'}`);
    log(`觸發: ${triggered?'🚨 是':'✅ 否'}`);
    log(`原因: ${result.triggerReason}`);
    log('══════════════════════════════');
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
