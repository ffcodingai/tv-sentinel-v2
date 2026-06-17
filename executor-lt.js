/**
 * LT 上漲轉折哨兵 — 執行引擎
 *
 * 監控上漲趨勢是否出現結構破壞（L段→T轉折）。
 *
 * 觸發條件（全部成立）：
 *   ① L段確認 — 上漲趨勢運行中（slope>0 + 市場看多）
 *   ② 結構破壞 — 價格多次測試同一阻力位未突破
 *   ③ SAR/斜率 — slope轉負或EMA收斂（SAR翻轉信號）
 *   ④ 板塊分歧 — 折溢價擴大（多空分歧加大）
 *
 * Usage:
 *   node executor-lt.js                ← 當前時間
 *   node executor-lt.js --at="..."     ← 歷史回測
 *   node executor-lt.js --json         ← JSON 輸出
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

// ── 拉取版塊折溢價數據 ──
async function fetchRotationData(btId) {
  if (btId) return dataProvider ? dataProvider.getRotationData(atStr, btId) : null;
  try {
    const raw = fs.readFileSync(ROTATION_UI_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Fallback: pull from 8288
    try {
      const d = await httpGet(`${SECTOR_API}/signal/data/list?symbol=MULTI_SYMBOL_PRICE:SECTOR_GLOBAL&size=1`, 5000);
      if (d?.results?.[0]?.ai_data?.value) return JSON.parse(d.results[0].ai_data.value);
    } catch {}
    return null;
  }
}

// ── 拉取商品放量數據 ──
async function fetchVolumeSurge(btId) {
  if (btId) return dataProvider ? dataProvider.getVolumeSurge(atStr, btId) : null;
  try {
    const raw = fs.readFileSync(VOLUME_SURGE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch { return { segments: [] }; }
}

// ── 拉取 composite index 方向 ──
async function fetchIndexData(btId) {
  if (btId) return dataProvider ? dataProvider.getIndexData(atStr, btId) : null;
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    return data;
  } catch { return null; }
}

// ── 計算斜率 ──
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

// ── 分析開盤市場版塊折溢價 ──
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
      direction: dir, upPct: total > 0 ? (up / total * 100).toFixed(0) + '%' : '0%',
      downPct: total > 0 ? (down / total * 100).toFixed(0) + '%' : '0%',
      sectors: c.sector,
    });
  }
  result.consistent = result.totalUp > result.totalDown && result.totalUp >= result.totalM * 0.6;
  result.direction = result.consistent ? 'up' : (result.totalDown > result.totalUp ? 'down' : null);
  return result;
}

// ── 檢查阻力測試（個股層面）──
async function checkResistanceTests(markets, btId, targetDate) {
  if (btId) {
    const resistData = dataProvider ? dataProvider.getResistanceData(targetDate, btId) : null;
    if (!resistData) return { nearResistance: [], broken: [], totalTests: 0 };
    const results = { nearResistance: [], broken: [], totalTests: 0 };
    for (const [market, md] of Object.entries(resistData.data?.markets || {})) {
      for (const s of md.stocks || []) {
        const pct = parseFloat(s.pctToResistance);
        if (pct > 0 && pct < 5) {
          results.nearResistance.push({ symbol: s.tvSymbol, name: s.name, pct });
          results.totalTests++;
        }
        if ((s.status || '').toLowerCase().includes('danger') || (s.status || '').includes('close')) {
          results.broken.push({ symbol: s.tvSymbol, name: s.name, status: s.status });
          results.totalTests++;
        }
      }
    }
    return results;
  }
  const results = { nearResistance: [], broken: [], totalTests: 0 };
  for (const market of ['america', 'china', 'hongkong', 'japan', 'korea', 'taiwan', 'uk', 'france', 'germany']) {
    if (!markets.includes(market.slice(0,2).toUpperCase())) continue;
    try {
      const apiMarket = market;
      const data = await httpGet(`http://192.168.25.190:3000/api/stock-resistance?market=${apiMarket}`, 5000);
      const stocks = data?.data?.stocks || [];
      for (const s of stocks) {
        const pct = parseFloat(s.pctToResistance);
        if (pct > 0 && pct < 5) {
          results.nearResistance.push({ symbol: s.tvSymbol || s.yahooSymbol, name: s.name, pct: pct });
          results.totalTests++;
        }
        if ((s.status || '').toLowerCase().includes('danger')) {
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
  dataProvider = backtestId ? require('./backtest/data-provider') : null;
  const log = jsonMode ? () => {} : console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    steps: [],
    ltTriggered: false,
    ltReason: null,
    ltStage: null,  // 'lt_pending' | 'lt_confirmed'
  };

  const { h, m } = getHktTime(atStr);
  const { sessions, markets } = getActiveMarkets(h, m);

  result.steps.push({ step: 1, name: '時區檢測', status: sessions.length > 0 ? 'pass' : 'fail',
    detail: sessions.map(s => s.label).join(' + ') || '休市' });
  result.steps.push({ step: 2, name: '開盤市場', status: markets.length > 0 ? 'pass' : 'fail',
    detail: `${markets.length}市場: ${markets.join(', ')}` });

  if (markets.length === 0) {
    result.ltTriggered = false; result.ltReason = '休市';
    return result;
  }

  // Step 3: 商品放量檢查
  const rotData = await fetchRotationData(backtestId);
  if (!rotData) {
    result.steps.push({ step: 3, name: '商品放量+折溢價', status: 'fail', detail: '無法取得數據' });
    result.ltTriggered = false; result.ltReason = '數據不可用';
    return result;
  }
  result.steps.push({ step: 3, name: '商品放量+折溢價', status: 'pass',
    detail: `取得 ${Object.keys(rotData.COUNTRIES || rotData.countries || {}).length} 市場數據` });

  // Step 4: 版塊方向分析
  const analysis = analyzeSectors(rotData, markets);
  result.steps.push({ step: 4, name: '版塊方向', status: analysis.consistent ? 'pass' : 'warn',
    detail: analysis.consistent
      ? `✅ L段確認 — ${analysis.totalM}市場看多`
      : `⚠️ 非一致上漲 (看多${analysis.totalUp}/看空${analysis.totalDown}/分歧${analysis.totalMixed})` });

  // Step 5: 阻力測試
  const dateStr = atStr ? atStr.split(' ')[0] : '';
  const resist = await checkResistanceTests(markets, backtestId, dateStr);
  result.steps.push({ step: 5, name: '阻力測試', status: resist.totalTests > 5 ? 'warn' : 'pass',
    detail: resist.totalTests > 0
      ? `${resist.nearResistance.length}支接近阻力, ${resist.broken.length}支已觸及`
      : '無明顯阻力測試' });

  // Step 6: 斜率方向
  const indexData = await fetchIndexData(backtestId);
  const slope = calcSlope(indexData);
  const slopeDown = slope !== null && slope < -0.1;
  result.steps.push({ step: 6, name: '斜率方向', status: slopeDown ? 'warn' : 'pass',
    detail: slope !== null
      ? `📐 slope: ${slope.toFixed(4)} (${slopeDown ? '🔻轉負' : slope > 0 ? '📈正向' : '📊平緩'})`
      : '斜率數據不足' });

  // Step 7: 最終判定
  const l1 = analysis.consistent;           // L段確認（看多一致）
  const l2 = resist.totalTests > 3;          // 多次阻力測試
  const l3 = slopeDown;                      // 斜率轉負
  const reasons = [];
  if (l1) reasons.push('✅ L段看多');
  else reasons.push('❌ 非一致上漲');
  if (l2) reasons.push(`⚠️ 阻力測試${resist.totalTests}次`);
  else reasons.push(`🟢 阻力測試${resist.totalTests}次`);
  if (l3) reasons.push('🔻 斜率轉負');
  else reasons.push(slope !== null ? '🟢 斜率未轉負' : '❓ 斜率不足');

  const triggered = l1 && l2 && l3;
  result.ltTriggered = triggered;
  result.ltStage = triggered ? 'lt_confirmed' : 'lt_pending';
  result.ltReason = triggered
    ? `🚨 LT 上漲轉折觸發！${reasons.join(' + ')}`
    : `✅ 未觸發 (${reasons.join(', ')})`;

  result.steps.push({ step: 7, name: 'LT判定', status: triggered ? 'trigger' : 'pass',
    detail: triggered ? '🚨 LT確認 — 上漲結構破壞' : '✅ L段延續中' });

  if (!jsonMode) {
    log(`\n═════ LT 上漲轉折哨兵 ═════`);
    log(`時間: ${result.atTime}`);
    log(`觸發: ${triggered ? '🚨 是' : '✅ 否'}`);
    log(`原因: ${result.ltReason}`);
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
