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

const http = require('http');
const fs = require('fs');
const path = require('path');

const SIGNAL_DB = 'http://192.168.25.127:8285';
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';
const TRACKING_DB_PATH = path.join(__dirname, 'tracking-state.json');

const SESSIONS = [
  { id:'ASIA',   label:'亞洲時段', countries:['JP','KR','TW','AU','CN','HK','SG'], startH:8,  endH:15 },
  { id:'CHINA',  label:'中國時段', countries:['CN','HK'], startH:9.5, endH:16 },
  { id:'EUROPE', label:'歐洲時段', countries:['UK','FR','DE','CH','NL','ES','IT'], startH:15, endH:23.5 },
  { id:'US',     label:'美國時段', countries:['US','US_SM'], startH:21.5, endH:4 },
];
const COUNTRY_FLAGS = { UK:'🇬🇧',FR:'🇫🇷',DE:'🇩🇪',US:'🇺🇸',US_SM:'🇺🇸',CN:'🇨🇳',HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',AU:'🇦🇺',SG:'🇸🇬' };
const SECTOR_CN = { IT:'科技',FIN:'金融',CD:'可選消費',TELECOM:'通信',IND:'工業',CONS:'必需消費',MED:'醫療',ENR:'能源',CHEM:'化工',METAL:'金屬採礦' };

function getHktTime(atStr) {
  if (atStr) { const d = new Date(atStr); return { h:d.getHours(), m:d.getMinutes(), ts:d.getTime() }; }
  const now = new Date(Date.now() + 8*3600000);
  return { h:now.getUTCHours(), m:now.getUTCMinutes(), ts:now.getTime() };
}

function getHktDateKey(ts) {
  const d = new Date(ts + 8*3600000);
  const p = n => String(n).padStart(2, '0');
  if (d.getUTCHours() < 5) { const prev = new Date(d.getTime() - 86400000); return `${prev.getUTCFullYear()}${p(prev.getUTCMonth()+1)}${p(prev.getUTCDate())}`; }
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`;
}

function fmtHkt(ts) {
  const d = new Date(ts + 8*3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function getActiveSessions(hktH, hktM) {
  const h = hktH + hktM/60;
  return SESSIONS.filter(s => { if (s.endH <= s.startH) return h >= s.startH || h < s.endH; return h >= s.startH && h < s.endH; });
}

function getActiveMarkets(hktH, hktM) {
  const sessions = getActiveSessions(hktH, hktM);
  return { sessions, markets: [...new Set(sessions.flatMap(s => s.countries))] };
}

function httpGet(url, timeout = 5000) {
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

// ── 前提檢查：趨勢已確認 ──
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

// ── A1: tv-correlation 折溢價由小變大 ──
async function checkSpreadGrowing() {
  try {
    const now = Date.now();
    const s = encodeURIComponent(fmtHkt(now - 7200000));
    const e = encodeURIComponent(fmtHkt(now));
    const data = await httpGet(`${SIGNAL_DB}/signal/data/list?startTime=${s}&endTime=${e}&symbol=global_spread_agg&pageSize=5`, 5000);
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
    const now = Date.now();
    const s = encodeURIComponent(fmtHkt(now - 3600000));
    const e = encodeURIComponent(fmtHkt(now));
    const symbols = ['asia_sector','china_sector','europe_sector','us_sector'];
    const allSpreads = [];
    for (const sym of symbols) {
      const data = await httpGet(`${SIGNAL_DB}/signal/data/list?symbol=${sym}&pageSize=2&startTime=${s}&endTime=${e}`, 4000);
      if (!data?.results?.length) continue;
      const recs = data.results.map(r => {
        const ms = JSON.parse(r.ai_data.value)?.MARKETS_SECTOR || {};
        const out = {};
        for (const code of Object.keys(ms)) out[code] = ms[code]?.SPREAD_TREND;
        return { time: r.ai_data.closeTime, spreads: out };
      }).filter(r => Object.values(r.spreads).some(x => x));
      allSpreads.push(...recs);
    }
    if (allSpreads.length < 2) return { available: false, growing: false, message: 'tv-turn 不夠比對' };
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
      details.push({ market: code, flag: COUNTRY_FLAGS[code]||'', from: ps, to: ls, growing: g });
    }
    const majority = totC > 0 && (growC / totC) >= 0.5;
    return { available: totC > 0, growing: majority, growCount: growC, totalCount: totC, details: details.slice(0,6),
      message: majority ? `🔥 tv-turn: ${growC}/${totC}市場由小變大` : `➖ tv-turn: 僅${growC}/${totC}市場擴大` };
  } catch { return { available: false, growing: false, message: 'tv-turn 讀取錯誤' }; }
}

// ── A3: 四級板塊由小變大 ──
function checkSubSectorGrowing() {
  try {
    const data = JSON.parse(fs.readFileSync(ROTATION_UI_PATH, 'utf-8'));
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
      details.push({ market: m, flag: COUNTRY_FLAGS[m]||'', divergent: mDiv, groups: dirs });
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
    dateKey: getHktDateKey(atStr ? new Date(atStr).getTime() : Date.now()),
    steps: [],
    triggered: false, triggerType: null, triggerReason: '',
    prerequisiteMet: false, conditionA1: null, conditionA2: null, conditionA3: null,
  };

  const {h,m} = getHktTime(atStr);
  const {sessions, markets} = getActiveMarkets(h,m);

  result.steps.push({ step:1, name:'時區檢測', status:sessions.length?'pass':'fail', detail:sessions.map(s=>s.label).join(' + ')||'休市' });
  result.steps.push({ step:2, name:'開盤市場', status:markets.length?'pass':'fail', detail:`${markets.length}市場: ${markets.join(', ')}` });
  if (!markets.length) { result.triggerReason = '休市'; return result; }

  // Step 3: 前提 — 一致趨勢行情已確認
  const trend = checkTrendConfirmed();
  result.prerequisiteMet = trend.confirmed && trend.direction;
  result.steps.push({
    step:3, name:'前提: 一致趨勢行情', status: trend.confirmed?'pass':'fail',
    detail: trend.confirmed ? `✅ ${trend.direction==='up'?'📈上漲':'📉下跌'}趨勢確認 (Day${trend.dateKey})` : '❌ 無趨勢狀態 (需先執行一致趨勢哨兵)',
  });
  if (!trend.confirmed) {
    result.triggered = false; result.triggerReason = '前提不滿足 — 一致趨勢行情未確認';
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
  result.triggerReason = triggered ? `🚨 一致行情轉折！${reasons.join(' + ')}` : `✅ 未觸發 (${['A1','A2','A3'].map((k,i)=>[a1,a2,a3][i].growing?`${k}✅`:`${k}➖`).join(', ')})`;

  result.steps.push({ step:7, name:'轉折判定', status:triggered?'trigger':'pass',
    detail: triggered ? `🚨 折溢價擴大+板塊分歧+四級分歧 → ${result.triggerType}` : '✅ 條件未滿足' });

  if (!jsonMode) {
    log(`\n═════ 一致行情轉折哨兵 ═════`);
    log(`前提趨勢: ${trend.direction||'?'} ${trend.confirmed?'🟢':'🔴'}`);
    log(`觸發: ${triggered?'🚨 是':'✅ 否'}`);
    log(`原因: ${result.triggerReason}`);
    log('══════════════════════════════\n');
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
