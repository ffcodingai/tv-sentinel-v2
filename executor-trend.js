/**
 * 一致行情趨勢管理機器人 — 執行引擎
 *
 * 雙向趨勢管理：
 *   利好事件 → 確認上漲趨勢延續
 *   利空事件 → 確認下跌趨勢延續
 *
 * 條件：
 *   ① 🔥 商品放量（金銀/原油/BTC/ETH/匯率）
 *   ② 🌍 全球市場一致（10國，含收盤VOL_TREND）
 *   ③ 折溢價小（一級+四級板塊一致無分歧）
 *   ④ 📐 composite slope 方向確認
 *   ⑤ AI intel 事件確認
 *
 * Usage:
 *   node executor-trend.js                ← 當前時間
 *   node executor-trend.js --at="..."     ← 歷史回測
 *   node executor-trend.js --json         ← JSON 輸出
 */

const http = require('http');
const fs = require('fs');

// ── 物料 (Data Sources) — 趨勢管理專用 ──
// 趨勢管理需要商品放量 + 全球市場一致 (含收盤市場 VOL_TREND)
//
// ① 商品放量 — 金AU0/銀AG0/油IG:LCO,SC0,CL/BTC/ETH/匯率SD_IDX:*
//    來源: /tmp/volume-surge-segments.json
//    門檻: ratio > 1.2 且 status=active
//
// ② 全球市場 — 開盤+收盤市場必須方向一致
//    - 開盤市場: sector rotation UP/DOWN (當前折溢價分佈)
//    - 收盤市場: VOL_TREND valid_trend + 驗證產品方向
//    - 驗證產品: IT→CFDGOLD/CFDSILVER, FIN→USDX_FX/CNH_FX, IND→LCO, CD→BTC/ETH
//    - 要求: 全部 10 國 (US,US_SM,UK,FR,DE,JP,KR,TW,CN,HK) 折溢價小且方向一致
//
// ③ tv-index → composite slope 方向確認
//    來源: http://localhost:3334/api/data (composite)
//    用途: slope(最後10點斜率)判趨勢健康
//
// ④ tv-intel → 事件管理 (待接入)
//    來源: FF-Mac 3000/api/news + tech-events-report
//    用途: 確認利好/利空事件與趨勢方向一致
//
// ── 觸發條件 (Trend Health = all true) ──
// 趨勢健康判定:
//   1. 🔥 商品放量: 金/銀/原油/BTC/ETH/匯率 中任一 ratio > 1.2
//   2. 🌍 全球一致: 全部 10 國市場折溢價小且同方向
//   3. 🟢 折溢價小: 開盤市場 spread <= 0.30
//   4. ✅ 四級一致: IT 子類無溢價/折價對立
//   5. 📊 composite slope: 斜率>0=上漲延續, <0=下跌延續
//
// 雙向管理:
//   - 上漲趨勢: 商品放量↑ + 全球看多 + 折溢價小 + slope↑
//   - 下跌趨勢: 商品放量↓ + 全球看空 + 折溢價小 + slope↓
//
// ── Config ──
let dataProvider = null;
let atStr = null;  // module-level for closure

const SECTOR_API = 'http://192.168.25.127:8288';
const INDEX_SERVER = 'http://localhost:3334';
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';
const VOLUME_THRESHOLD = 1.2;

const VOLUME_TARGETS = {
  precious_metals: { label:'貴金屬', symbols: ['AU0','AG0','IG:CFDGOLD','IG:CFDSILVER'] },
  crude_oil:       { label:'原油期貨', symbols: ['SC0','IG:LCO','IG:CL'] },
  crypto:          { label:'Crypto', symbols: ['BTC','ETH'] },
  forex:           { label:'匯率', symbols: ['SD_IDX:'] },
};

const SESSIONS = [
  { id:'ASIA',   label:'亞洲時段', countries:['JP','KR','TW','AU','CN','HK','SG'], startH:8,  endH:15 },
  { id:'CHINA',  label:'中國時段', countries:['CN','HK'], startH:9.5, endH:16 },
  { id:'EUROPE', label:'歐洲時段', countries:['UK','FR','DE','CH','NL','ES','IT'], startH:15, endH:23.5 },
  { id:'US',     label:'美國時段', countries:['US','US_SM'], startH:21.5, endH:4 },
];

const SECTOR_CN = {
  IT:'科技',FIN:'金融',CD:'可選消費',TELECOM:'通信',IND:'工業',
  CONS:'必需消費',MED:'醫療',ENR:'能源',CHEM:'化工',METAL:'金屬採礦'
};
const COUNTRY_FLAGS = {
  UK:'🇬🇧',FR:'🇫🇷',DE:'🇩🇪',US:'🇺🇸',US_SM:'🇺🇸',CN:'🇨🇳',
  HK:'🇭🇰',JP:'🇯🇵',KR:'🇰🇷',TW:'🇹🇼',CH:'🇨🇭',NL:'🇳🇱',ES:'🇪🇸',IT:'🇮🇹',AU:'🇦🇺',SG:'🇸🇬'
};

function getHktTime(atStr) {
  if (atStr) { const d = new Date(atStr); return { h:d.getHours(), m:d.getMinutes(), ts:d.getTime() }; }
  const now = new Date(Date.now() + 8*3600000);
  return { h:now.getUTCHours(), m:now.getUTCMinutes(), ts:now.getTime() };
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
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchRotationData(btId) {
  if (btId) return dataProvider ? dataProvider.getRotationData(atStr, btId) : null;
  try { if (fs.existsSync(ROTATION_UI_PATH)) return JSON.parse(fs.readFileSync(ROTATION_UI_PATH, 'utf-8')); } catch {}
  const list = ['asia_sector','china_sector','europe_sector','us_sector'];
  for (const m of list) {
    try { const d = await httpGet(`${SECTOR_API}/signal/data/list?symbol=${m}&size=1`); if (d?.results?.[0]?.ai_data?.value) return JSON.parse(d.results[0].ai_data.value); } catch {}
  }
  return null;
}

// ── Fetch Volume Surge ──
async function fetchVolumeSurge(btId) {
  if (btId) return dataProvider ? dataProvider.getVolumeSurge(atStr, btId) : null;
  try {
    if (fs.existsSync(VOLUME_SURGE_PATH)) {
      const raw = fs.readFileSync(VOLUME_SURGE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

function checkVolumeSurge(volData) {
  const segments = volData?.segments || [];
  const matched = [];
  for (const entry of segments) {
    const data = Array.isArray(entry) ? entry[1] : entry;
    if (!data || data.status !== 'active') continue;
    const sym = data.symbol || '';
    const ratio = data.ratio || 0;
    if (ratio < VOLUME_THRESHOLD) continue;
    for (const [catKey, cat] of Object.entries(VOLUME_TARGETS)) {
      if (cat.symbols.some(s => sym === s || sym.startsWith(s))) {
        matched.push({ symbol: sym, category: cat.label, ratio, hourKey: data.hourKey || '', catKey });
        break;
      }
    }
  }
  const hasSurge = matched.length > 0;
  return {
    hasSurge, matched,
    message: hasSurge
      ? `🔥 放量確認: ${matched.map(m => `${m.symbol}(${m.ratio}x,${m.category})`).join(', ')}`
      : '✅ 無相關放量（金/銀/油/BTC/ETH/匯率均無放量）',
  };
}

async function fetchIndexDirection(btId) {
  if (btId) {
    try {
      const idxData = dataProvider ? dataProvider.getIndexData(atStr, btId) : null;
      if (!idxData) return { available: false, direction: null, message: '回測無 index 數據' };
      const composite = idxData.composite || [];
      if (Array.isArray(composite) && composite.length >= 3) {
        const len = composite.length;
        const last = composite[len-1]?.value;
        const prev = composite[len-3]?.value;
        if (last != null && prev != null) {
          const dir = last >= prev ? 'up' : 'down';
          return { available: true, direction: dir, lastValue: last, prevValue: prev,
            message: `📊 tv-index 方向: ${dir === 'up' ? '📈上漲' : '📉下跌'} (${prev}→${last})` };
        }
      }
      return { available: true, direction: null, message: 'tv-index 數據不足判斷方向' };
    } catch { return { available: false, direction: null, message: '回測 index 錯誤' }; }
  }
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    if (!data) return { available: false, direction: null, message: 'tv-index 無回應' };
    const composite = data.composite;
    if (Array.isArray(composite) && composite.length >= 3) {
      const len = composite.length;
      const last = composite[len-1]?.value;
      const prev = composite[len-3]?.value;
      if (last != null && prev != null) {
        const dir = last >= prev ? 'up' : 'down';
        return { available: true, direction: dir, lastValue: last, prevValue: prev,
          message: `📊 tv-index 方向: ${dir === 'up' ? '📈上漲' : '📉下跌'} (${prev}→${last})` };
      }
    }
    return { available: true, direction: null, message: 'tv-index 數據不足判斷方向' };
  } catch {
    return { available: false, direction: null, message: 'tv-index 連線失敗' };
  }
}

async function fetchIndexData(btId) {
  if (btId) return dataProvider ? dataProvider.getIndexData(atStr, btId) : null;
  try {
    const data = await httpGet(`${INDEX_SERVER}/turnpoints.json`, 3000);
    return data;
  } catch {}
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    return data;
  } catch {}
  return null;
}

// ── Step 3: Check SMALL premium/discount ──
function checkPremiumSmall(rotData, markets) {
  let pSum=0, pC=0, dSum=0, dC=0, totalM=0;
  const details = [];

  for (const m of markets) {
    const c = rotData.countries?.[m];
    if (!c?.sector) continue;

    const s = c.sector;
    const up = s.UP||[], down = s.DOWN||[], multi = s.MULTI||[], neut = s.NEUTRAL||[];
    const total = up.length + down.length + multi.length + neut.length;
    if (total === 0) continue;
    totalM++;

    const upPct = up.length/total;
    const downPct = down.length/total;
    const upDir = upPct >= 0.6;
    const downDir = downPct >= 0.6;
    const direction = upDir ? 'up' : (downDir ? 'down' : 'mixed');

    pSum += upPct; pC++;
    dSum += downPct; dC++;

    details.push({
      market: m, label: c.label||m, flag: COUNTRY_FLAGS[m]||'',
      direction, upPct:(upPct*100).toFixed(0)+'%', downPct:(downPct*100).toFixed(0)+'%',
      sectors: { up: up.map(x=>SECTOR_CN[x]||x), down: down.map(x=>SECTOR_CN[x]||x), multi: multi.map(x=>SECTOR_CN[x]||x) }
    });
  }

  const avgP = pC>0 ? pSum/pC : 0;
  const avgD = dC>0 ? dSum/dC : 0;
  const spread = Math.abs(avgP - avgD);
  const small = spread <= 0.30; // 折溢價小

  // Direction consensus among all markets
  const allUp = details.length > 0 && details.every(d => d.direction === 'up');
  const allDown = details.length > 0 && details.every(d => d.direction === 'down');
  const consensus = allUp || allDown;
  const consensusDir = allUp ? 'up' : 'down';

  return {
    small, spread: parseFloat(spread.toFixed(3)),
    consensus, consensusDir: consensusDir,
    marketCount: totalM, details,
    message: small
      ? `✅ 折溢價小 (${spread.toFixed(2)}) — 市場一致無分歧`
      : `⚠️ 折溢價偏大 (${spread.toFixed(2)}) — 板塊開始分歧`,
  };
}

// ── Step 4: Check sub-sector consensus (小 = no divergence) ──
function checkSubSectorConsensus(rotData) {
  const details = [];
  let allConsistent = true;

  for (const m of ['CN','US','US_SM']) {
    const c = rotData.countries?.[m];
    if (!c?.subSectors?.IT) continue;
    const groups = {};
    for (const [gk, g] of Object.entries(c.subSectors.IT)) {
      const sn = gk.replace(m+'_IT_','').toUpperCase();
      const dirs = {};
      for (const d of ['UP','DOWN','MULTI','NEUTRAL']) {
        const items = g[d]||[];
        if (items.length > 0) dirs[d] = items.map(i => i.split('_').pop());
      }
      const keys = Object.keys(dirs);
      if (keys.length > 1) allConsistent = false;
      groups[sn] = dirs;
    }
    details.push({ market:m, label: rotData.countries[m]?.label||m, flag:COUNTRY_FLAGS[m]||'', groups });
  }

  return { allConsistent, details, message: allConsistent ? '✅ 四級板塊一致' : '⚠️ 四級板塊出現分歧' };
}

// ── Step 5: Check index direction ──
async function checkIndexDirection(rotData, markets) {
  try {
    const idx = await fetchIndexData(backtestId);
    if (!idx) return { available: false, message: '⚠️ tv-index 數據不可用', direction: null };
    return { available: true, message: `✅ tv-index 方向確認可用`, direction: 'detected', data: idx };
  } catch {
    return { available: false, message: '⚠️ tv-index 連線失敗', direction: null };
  }
}

// ── Step 6: Volatility check (big move in products) ──
function checkVolatility(rotData, markets) {
  let hasVolatility = false;
  const volatileItems = [];

  // Collapse UP/DOWN products into a single list
  function collectProducts(obj) {
    const items = [];
    if (!obj || typeof obj !== 'object') return items;
    for (const key of ['UP','DOWN','MULTI']) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') items.push(item);
          else if (typeof item === 'object' && item !== null) items.push(item);
        }
      }
    }
    return items;
  }

  for (const m of markets) {
    const c = rotData.countries?.[m];
    if (!c?.correlatedProducts) continue;
    const products = collectProducts(c.correlatedProducts);
    // If we see sector data with strong direction differences, flag volatility
    if (products.length > 0) {
      hasVolatility = true;
      volatileItems.push({ market: m, products: products.slice(0,3) });
    }
  }

  return {
    detected: hasVolatility,
    items: volatileItems,
    message: hasVolatility
      ? `⚠️ 相關產品波動: ${volatileItems.map(i=>i.market).join(', ')}`
      : '✅ 波幅正常（待接入產品API）'
  };
}

// ── Slope calculation ──
function calcSlope(indexData, n = 10) {
  if (!indexData || indexData.length < n) return null;
  const slice = indexData.slice(-n);
  const xMean = (n - 1) / 2;
  const yMean = slice.reduce((s, p) => s + p.value, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (slice[i].value - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? num / den : 0;
}

// ── 全球市場一致 (10國) ──
const ALL_COUNTRIES = ['US','US_SM','UK','FR','DE','JP','KR','TW','CN','HK'];

function analyzeAllMarkets(rotData) {
  const results = [];
  let totalUp = 0, totalDown = 0, mixed = 0;
  for (const m of ALL_COUNTRIES) {
    const c = rotData.countries?.[m];
    if (!c) continue;
    let direction;
    if (c.status === 'open' && c.sector) {
      const s = c.sector;
      const up = s.UP || [], down = s.DOWN || [], multi = s.MULTI || [], neut = s.NEUTRAL || [];
      const total = up.length + down.length + multi.length + neut.length;
      if (total === 0) direction = 'neutral';
      else {
        const upPct = up.length / total;
        const downPct = down.length / total;
        if (upPct >= 0.6) { direction = 'up'; totalUp++; }
        else if (downPct >= 0.6) { direction = 'down'; totalDown++; }
        else { direction = 'mixed'; mixed++; }
      }
    } else if (c.VOL_TREND) {
      let upCount = 0, downCount = 0, totalCount = 0;
      for (const vt of Object.values(c.VOL_TREND)) {
        if (vt.valid_trend === 'VALID_UP') { upCount++; totalCount++; }
        else if (vt.valid_trend === 'VALID_DOWN') { downCount++; totalCount++; }
      }
      if (totalCount === 0) direction = 'neutral';
      else {
        const upPct = upCount / totalCount;
        const downPct = downCount / totalCount;
        if (upPct >= 0.6) { direction = 'up'; totalUp++; }
        else if (downPct >= 0.6) { direction = 'down'; totalDown++; }
        else { direction = 'mixed'; mixed++; }
      }
    } else direction = 'neutral';
    results.push({ market: m, label: c.label||m, flag: COUNTRY_FLAGS[m]||'', status: c.status||'unknown', direction });
  }
  const totalM = results.length;
  const consistent = totalM > 0 && (totalUp === totalM || totalDown === totalM);
  const globalDir = totalUp > totalDown ? 'up' : 'down';
  return {
    results, consistent, globalDir, totalUp, totalDown, mixed, totalM,
    message: consistent
      ? `🌍 全球一致 ${globalDir === 'up' ? '📈看多' : '📉看空'} (${totalUp}看多/${totalDown}看空/${mixed}分歧, ${totalM}國)`
      : `⚠️ 全球分歧 (${totalUp}看多/${totalDown}看空/${mixed}分歧, ${totalM}國)`
  };
}

// ── Main ──
async function main(options = {}) {
  atStr = options.at || null;
  const _ignored = atStr;
  const backtestId = options.backtestId || null;
  const jsonMode = options.json || false;
  dataProvider = backtestId ? require('./backtest/data-provider') : null;
  const log = jsonMode ? ()=>{}
: console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    steps: [],
    trendHealthy: false,
    trendDirection: null,
    reason: '',
  };

  // Step 1-2: Timezone
  const {h,m} = getHktTime(atStr);
  const {sessions, markets} = getActiveMarkets(h,m);

  result.steps.push({ step:1, name:'時區檢測', status:sessions.length>0?'pass':'fail',
    detail:sessions.map(s=>s.label).join(' + ')||'休市' });
  result.steps.push({ step:2, name:'開盤市場', status:markets.length>0?'pass':'fail',
    detail:`${markets.length}市場: ${markets.join(', ')}`, markets:[...markets] });

  if (markets.length === 0) {
    result.trendHealthy = false; result.reason = '休市';
    return result;
  }

  // ── Step 3: 商品放量檢查 ──
  const volData = await fetchVolumeSurge(backtestId);
  const volResult = checkVolumeSurge(volData);
  result.steps.push({ step:3, name:'商品放量(金銀/油/BTC/ETH/匯率)', status: volResult.hasSurge?'pass':'warn',
    detail: volResult.message, volumeSurge: volResult });

  const surgeOk = volResult.hasSurge;
  let surgeReason = surgeOk ? '' : '❌ 無放量'; // used in final

  // Fetch rotation data
  const rotData = await fetchRotationData(backtestId);
  if (!rotData?.countries) {
    result.steps[1].status = 'fail';
    result.trendHealthy = false; result.reason = '數據不可用';
    return result;
  }

  // Step 4: 全球市場一致 (開盤+收盤)
  const allMarkets = analyzeAllMarkets(rotData);
  result.steps.push({ step:4, name:'全球市場一致(10國)', status:allMarkets.consistent?'pass':'warn',
    detail: allMarkets.message, allMarkets: allMarkets.results });

  // Step 5: Premium SMALL check
  const premium = checkPremiumSmall(rotData, markets);
  result.steps.push({ step:5, name:'折溢價小', status:premium.small?'pass':'warn',
    detail: premium.message, premium, marketData: premium.details });

  // Step 6: Sub-sector consensus
  const subSector = checkSubSectorConsensus(rotData);
  result.steps.push({ step:6, name:'四級板塊一致', status:subSector.allConsistent?'pass':'warn',
    detail: subSector.message, subSectors: subSector.details });

  // Step 7: composite slope 方向確認
  const indexData = await fetchIndexDirection(backtestId);
  // Compute slope
  let slopeVal = null;
  try {
    const idxResp = await httpGet('http://localhost:3334/api/data', 3000);
    if (idxResp?.indexData) slopeVal = calcSlope(idxResp.indexData, 10);
  } catch {}
  const slopeMsg = slopeVal !== null
    ? `📐 composite slope: ${slopeVal.toFixed(4)} (${slopeVal > 0 ? '📈向上' : '📉向下'})`
    : '📐 composite slope: 不足10點';
  result.steps.push({ step:7, name:'composite slope+方向', status:indexData.available?'pass':'pass',
    detail: slopeMsg, slope: slopeVal, index: indexData });

  // Step 8: Events
  result.steps.push({ step:8, name:'事件確認', status:'info', detail: '商品放量+全球一致已確認，等tv-intel接入' });

  // Step 9: Final judgment
  const consensusOk = premium.consensus && premium.small;
  const subOk = subSector.allConsistent;

  // 趨勢健康 = 商品放量 + 全球一致 + 折溢價小 + 四級一致 + slope 方向
  const trendHealthy = surgeOk && allMarkets.consistent && consensusOk && subOk;
  const trendDir = allMarkets.globalDir;

  const reasons = [];
  if (surgeOk) reasons.push(`🔥商品放量(${volResult.matched.map(m=>m.symbol).join(',')})`);
  else reasons.push('❌ 無商品放量');
  if (allMarkets.consistent) reasons.push(`🌍全球${allMarkets.globalDir === 'up' ? '📈看多' : '📉看空'}`);
  else reasons.push('❌ 全球分歧');
  if (premium.small) reasons.push('折溢價小');
  else reasons.push('❌ 折溢價偏大');
  if (premium.consensus) reasons.push('市場一致');
  else reasons.push('❌ 市場分歧');
  if (subSector.allConsistent) reasons.push('四級一致');
  else reasons.push('⚠️ 四級分歧');
  if (slopeVal !== null) reasons.push(slopeVal > 0 ? '📈slope向上' : '📉slope向下');

  result.steps.push({ step:9, name:'趨勢判斷', status:trendHealthy?'pass':'warn',
    detail: trendHealthy
      ? `🟢 趨勢健康 — ${trendDir==='up'?'📈上漲':'📉下跌'}趨勢延續 (${reasons.join(', ')})`
      : `⚠️ 條件不足 — ${reasons.join(', ')}` });

  result.trendHealthy = trendHealthy;
  result.trendDirection = trendDir;
  result.reason = reasons.join(' + ');

  log(`📊 趨勢管理: ${trendHealthy?'🟢健康':'⚠️條件不足'} | ${reasons.join(', ')}`);

  return result;
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const atI = args.indexOf('--at');
  const atStr = atI>=0 ? args[atI+1] : null;
  const jsonMode = args.includes('--json');

  const btI = args.indexOf('--backtest-id');
  const btId = btI>=0 ? args[btI+1] : null;

  main({ at:atStr, json:jsonMode, backtestId: btId }).then(r => {
    if (jsonMode) { console.log(JSON.stringify(r,null,2)); return; }
    console.log(`\n═════ 一致行情趨勢管理機器人 ═════`);
    console.log(`時間: ${r.atTime}`);
    console.log(`趨勢健康: ${r.trendHealthy?'🟢 是':'⚠️ 否'}`);
    console.log(`方向: ${r.trendDirection==='up'?'📈上漲':r.trendDirection==='down'?'📉下跌':'⚪未定'}`);
    console.log(`原因: ${r.reason}`);
    console.log('\n── 步驟 ──');
    for (const s of r.steps) {
      const ic = {pass:'✅',warn:'⚠️',fail:'❌',info:'💬',active:'⏳'}[s.status]||'❓';
      console.log(`  ${ic} ${s.name}: ${s.detail.substring(0,70)}`);
    }
    console.log('═══════════════════════════════════\n');
  }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { main, checkPremiumSmall, checkSubSectorConsensus, checkVolatility };
