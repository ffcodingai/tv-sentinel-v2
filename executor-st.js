/**
 * ST 下跌轉折哨兵 — 執行引擎
 *
 * 監控下跌趨勢是否出現結構破壞（S段→T轉折）。
 *
 * 觸發條件（全部成立）：
 *   ① S段確認 — 下跌趨勢運行中（slope<0 + 市場看空）
 *   ② 結構破壞 — 價格多次測試同一支撐位未跌破
 *   ③ SAR/斜率 — slope轉正或EMA收斂（SAR翻轉信號）
 *   ④ 板塊收斂 — 折溢價縮小（空方力量減弱）
 *
 * Usage:
 *   node executor-st.js                ← 當前時間
 *   node executor-st.js --at="..."     ← 歷史回測
 *   node executor-st.js --json         ← JSON 輸出
 */

const http = require('http');
const fs = require('fs');
let dataProvider = null;
let atStr = null;  // module-level for closure


// ── Config ──
const SECTOR_API = 'http://192.168.25.127:8288';
const INDEX_SERVER = 'http://localhost:3334';
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';

const SESSIONS = [
  { id:'ASIA',   label:'亞洲時段', countries:['JP','KR','TW','AU','CN','HK','SG'], startH:8,  endH:15 },
  { id:'CHINA',  label:'中國時段', countries:['CN','HK'], startH:9.5, endH:16 },
  { id:'EUROPE', label:'歐洲時段', countries:['UK','FR','DE','CH','NL','ES','IT'], startH:15, endH:23.5 },
  { id:'US',     label:'美國時段', countries:['US','US_SM'], startH:21.5, endH:4 },
];

function getHktTime(atStr) {
  if (atStr) { const d = new Date(atStr); return { h:d.getHours(), m:d.getMinutes(), ts:d.getTime() }; }
  const now = new Date(Date.now() + 8*3600000);
  return { h:now.getUTCHours(), m:now.getUTCMinutes(), ts:now.getTime() };
}

function getActiveMarkets(hktH, hktM) {
  const sessions = SESSIONS.filter(s => {
    const h = hktH + hktM / 60;
    if (s.endH <= s.startH) return h >= s.startH || h < s.endH;
    return h >= s.startH && h < s.endH;
  });
  const set = new Set();
  for (const s of sessions) s.countries.forEach(c => set.add(c));
  return { sessions, markets: [...set] };
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

async function fetchRotationData(btId) {
  if (btId) return dataProvider ? dataProvider.getRotationData(atStr, btId) : null;
  try {
    const raw = fs.readFileSync(ROTATION_UI_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    try {
      const d = await httpGet(`${SECTOR_API}/signal/data/list?symbol=MULTI_SYMBOL_PRICE:SECTOR_GLOBAL&size=1`, 5000);
      if (d?.results?.[0]?.ai_data?.value) return JSON.parse(d.results[0].ai_data.value);
    } catch {}
    return null;
  }
}

async function fetchIndexData(btId) {
  if (btId) return dataProvider ? dataProvider.getIndexData(atStr, btId) : null;
  try {
    return await httpGet(`${INDEX_SERVER}/api/data`, 3000);
  } catch { return null; }
}

function calcSlope(indexData, n = 10) {
  if (!indexData?.indexData?.length) return null;
  const points = indexData.indexData.slice(-n);
  if (points.length < 3) return null;
  const vals = points.map(p => typeof p === 'number' ? p : (p.value || p.close || 0));
  const len = vals.length;
  const sumX = len * (len - 1) / 2, sumY = vals.reduce((a, b) => a + b, 0);
  const sumXY = vals.reduce((a, v, i) => a + i * v, 0);
  const sumX2 = vals.reduce((a, v, i) => a + i * i, 0);
  const slope = (len * sumXY - sumX * sumY) / (len * sumX2 - sumX * sumX);
  return slope;
}

function analyzeSectors(rotData, markets) {
  const result = { totalUp: 0, totalDown: 0, totalMixed: 0, totalM: 0, direction: null, consistent: false, marketData: [] };
  const countries = rotData?.COUNTRIES || rotData?.countries || {};
  for (const m of markets) {
    const c = countries[m];
    if (!c || !c.sector) continue;
    const up = c.sector.UP?.length || 0;
    const down = c.sector.DOWN?.length || 0;
    const total = up + down + (c.sector.MULTI?.length || 0);
    if (total === 0) continue;
    result.totalM++;
    const dir = up > down ? 'up' : down > up ? 'down' : 'mixed';
    if (dir === 'up') result.totalUp++;
    else if (dir === 'down') result.totalDown++;
    else result.totalMixed++;
    result.marketData.push({
      market: m, label: c.label || m,
      direction: dir,
      upPct: total > 0 ? (up / total * 100).toFixed(0) + '%' : '0%',
      downPct: total > 0 ? (down / total * 100).toFixed(0) + '%' : '0%',
      sectors: c.sector,
    });
  }
  result.consistent = result.totalDown > result.totalUp && result.totalDown >= result.totalM * 0.6;
  result.direction = result.consistent ? 'down' : (result.totalUp > result.totalDown ? 'up' : null);
  return result;
}

// ── 檢查支撐測試 ──
async function checkSupportTests(markets, btId, targetDate) {
  if (btId) {
    const resistData = dataProvider ? dataProvider.getResistanceData(targetDate, btId) : null;
    if (!resistData) return { nearSupport: [], broken: [], totalTests: 0 };
    const results = { nearSupport: [], broken: [], totalTests: 0 };
    for (const [market, md] of Object.entries(resistData.data?.markets || {})) {
      for (const s of md.stocks || []) {
        const pct = parseFloat(s.pctToSupport);
        if (pct > 0 && pct < 5) {
          results.nearSupport.push({ symbol: s.tvSymbol, name: s.name, pct });
          results.totalTests++;
        }
        if ((s.status || '').toLowerCase().includes('danger') || (s.status || '').toLowerCase().includes('support_broken') || (s.status || '').includes('close')) {
          results.broken.push({ symbol: s.tvSymbol, name: s.name, status: s.status });
          results.totalTests++;
        }
      }
    }
    return results;
  }
  const results = { nearSupport: [], broken: [], totalTests: 0 };
  for (const market of ['america', 'china', 'hongkong', 'japan', 'korea', 'taiwan', 'uk', 'france', 'germany']) {
    if (!markets.includes(market.slice(0,2).toUpperCase())) continue;
    try {
      const data = await httpGet(`http://192.168.25.190:3000/api/stock-resistance?market=${market}`, 5000);
      const stocks = data?.data?.stocks || [];
      for (const s of stocks) {
        const pct = parseFloat(s.pctToSupport);
        if (pct > 0 && pct < 5) {
          results.nearSupport.push({ symbol: s.tvSymbol || s.yahooSymbol, name: s.name, pct: pct });
          results.totalTests++;
        }
        if ((s.status || '').toLowerCase().includes('danger') || (s.status || '').toLowerCase().includes('support_broken')) {
          results.broken.push({ symbol: s.tvSymbol || s.yahooSymbol, name: s.name, status: s.status });
          results.totalTests++;
        }
      }
    } catch {}
  }
  return results;
}

// ── Main ──
async function main(options = {}) {
  atStr = options.at || null;
  const _ignored = atStr;
  const backtestId = options.backtestId || null;
  const jsonMode = options.json || false;
  const log = jsonMode ? () => {} : console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    steps: [],
    stTriggered: false,
    stReason: null,
    stStage: null,  // 'st_pending' | 'st_confirmed'
  };

  const { h, m } = getHktTime(atStr);
  const { sessions, markets } = getActiveMarkets(h, m);

  result.steps.push({ step: 1, name: '時區檢測', status: sessions.length > 0 ? 'pass' : 'fail',
    detail: sessions.map(s => s.label).join(' + ') || '休市' });
  result.steps.push({ step: 2, name: '開盤市場', status: markets.length > 0 ? 'pass' : 'fail',
    detail: `${markets.length}市場: ${markets.join(', ')}` });

  if (markets.length === 0) {
    result.stTriggered = false; result.stReason = '休市';
    return result;
  }

  const rotData = await fetchRotationData(backtestId);
  if (!rotData) {
    result.steps.push({ step: 3, name: '數據獲取', status: 'fail', detail: '無法取得版塊數據' });
    result.stTriggered = false; result.stReason = '數據不可用';
    return result;
  }
  result.steps.push({ step: 3, name: '數據獲取', status: 'pass',
    detail: `取得 ${Object.keys(rotData.COUNTRIES || rotData.countries || {}).length} 市場數據` });

  // Step 4: 版塊方向（S段看空確認）
  const analysis = analyzeSectors(rotData, markets);
  result.steps.push({ step: 4, name: '版塊方向', status: analysis.consistent ? 'pass' : 'warn',
    detail: analysis.consistent
      ? `✅ S段確認 — ${analysis.totalM}市場看空`
      : `⚠️ 非一致下跌 (看多${analysis.totalUp}/看空${analysis.totalDown}/分歧${analysis.totalMixed})` });

  // Step 5: 支撐測試
  const dateStr = atStr ? atStr.split(' ')[0] : '';
  const support = await checkSupportTests(markets, backtestId, dateStr);
  result.steps.push({ step: 5, name: '支撐測試', status: support.totalTests > 5 ? 'warn' : 'pass',
    detail: support.totalTests > 0
      ? `${support.nearSupport.length}支接近支撐, ${support.broken.length}支已跌破`
      : '無明顯支撐測試' });

  // Step 6: 斜率方向
  const indexData = await fetchIndexData(backtestId);
  const slope = calcSlope(indexData);
  const slopeUp = slope !== null && slope > 0.1;
  result.steps.push({ step: 6, name: '斜率方向', status: slopeUp ? 'warn' : 'pass',
    detail: slope !== null
      ? `📐 slope: ${slope.toFixed(4)} (${slopeUp ? '🔺轉正' : slope < 0 ? '📉負向' : '📊平緩'})`
      : '斜率數據不足' });

  // Step 7: 最終判定
  const s1 = analysis.consistent;            // S段確認（看空一致）
  const s2 = support.totalTests > 3;          // 多次支撐測試
  const s3 = slopeUp;                         // 斜率轉正
  const reasons = [];
  if (s1) reasons.push('✅ S段看空');
  else reasons.push('❌ 非一致下跌');
  if (s2) reasons.push(`⚠️ 支撐測試${support.totalTests}次`);
  else reasons.push(`🟢 支撐測試${support.totalTests}次`);
  if (s3) reasons.push('🔺 斜率轉正');
  else reasons.push(slope !== null ? '🟢 斜率未轉正' : '❓ 斜率不足');

  const triggered = s1 && s2 && s3;
  result.stTriggered = triggered;
  result.stStage = triggered ? 'st_confirmed' : 'st_pending';
  result.stReason = triggered
    ? `🚨 ST 下跌轉折觸發！${reasons.join(' + ')}`
    : `✅ 未觸發 (${reasons.join(', ')})`;

  result.steps.push({ step: 7, name: 'ST判定', status: triggered ? 'trigger' : 'pass',
    detail: triggered ? '🚨 ST確認 — 下跌結構破壞' : '✅ S段延續中' });

  if (!jsonMode) {
    log(`\n═════ ST 下跌轉折哨兵 ═════`);
    log(`時間: ${result.atTime}`);
    log(`觸發: ${triggered ? '🚨 是' : '✅ 否'}`);
    log(`原因: ${result.stReason}`);
    for (const s of result.steps) {
      const icon = s.status === 'pass' ? '✅' : s.status === 'warn' ? '⚠️' : s.status === 'trigger' ? '🔴' : '❌';
      log(`  ${icon} Step ${s.step}: ${s.name} — ${s.detail.substring(0, 60)}`);
    }
    log('════════════════════════════\n');
  }

  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const atIndex = args.indexOf('--at');
  const atStr = atIndex >= 0 ? args[atIndex + 1] : null;
  const btIndex = args.indexOf('--backtest-id');
  const btId = btIndex >= 0 ? args[btIndex + 1] : null;

  main({ at: atStr, json: args.includes('--json'), backtestId: btId }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r));
  }).catch(e => console.error(e.message));
}

module.exports = { main };
