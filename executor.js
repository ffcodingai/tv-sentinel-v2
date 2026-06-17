/**
 * 一致行情轉折哨兵 — 執行引擎
 *
 * 10 步判定流程：
 *   Step 1:  時區檢測
 *   Step 2:  拉取開盤市場
 *   Step 3:  商品放量檢查 (金銀/油/BTC/ETH/匯率)
 *   Step 4:  一級板塊折溢價 (UP/DOWN/RANK)
 *   Step 5:  一致性判定
 *   Step 6:  折溢價差距監控
 *   Step 7:  全球市場一致 (開盤+收盤/VOL_TREND 10國) 🌍 NEW
 *   Step 8:  四級板塊 (IT 子類) 分歧
 *   Step 9:  composite slope 方向確認 + events
 *   Step 10: 最終觸發判斷
 *
 * Usage:
 *   node executor.js                    ← Current time
 *   node executor.js --at="2026-06-10 09:30"  ← Historical
 *   node executor.js --json             ← JSON output
 */

const http = require('http');
const path = require('path');

// ── Config ──
// ── 物料 (Data Sources) — 轉折哨兵專用 ──
// 轉折哨兵需要兩類放量: ①商品放量 ②所有市場板塊放量
// 且需要所有市場(開盤+收盤)方向一致，收盤市場用 VOL_TREND/指數期貨代理
//
// ① 商品放量 — 金AU0/銀AG0/油IG:LCO,SC0,CL/BTC/ETH/匯率SD_IDX:*
//    來源: /tmp/volume-surge-segments.json
//    門檻: ratio > 1.2 且 status=active
//
// ② 所有市場板塊放量 — VOL_TREND 信號 (含開盤+收盤市場)
//    來源: sector-rotation-ui.json → countries.{market}.VOL_TREND.{sector}.status
//    收盤判斷: 板塊「維持多/有效轉多」= 看多延續；「維持空/有效轉空」= 看空延續
//    驗證產品 (收盤代理): IT→CFDGOLD/CFDSILVER, FIN→USDX_FX/CNH_FX, IND→LCO, CD→BTC/ETH
//
// ③ 所有市場折溢價 — open市場用sector UP/DOWN, closed市場用VOL_TREND valid_trend
//    來源: sector-rotation-ui.json → 全部 10 國 (US,US_SM,UK,FR,DE,JP,KR,TW,CN,HK)
//    一致要求: 無論開盤收盤，所有市場同方向 ≥60%
//
// ④ tv-index → composite slope + H35/H36 turnpoint
//    來源: http://localhost:3334/api/data (composite)
//    用途: slope(最後10點斜率)判方向 + H35/H36轉折確認
//
// ⑤ tv-intel → 事件管理 (待接入)
//    來源: FF-Mac 3000/api/news + tech-events-report
//    用途: 地緣/經濟/技術事件一致性確認
//
// ── 觸發條件 (Trigger Conditions) ──
// 全部成立才觸發轉折信號:
//   1. 🔥 商品放量: 金/銀/原油/BTC/ETH/匯率 中任一 ratio > 1.2
//   2. 🔥 所有市場板塊放量: VOL_TREND 顯示趨勢變化(開盤+收盤)
//   3. 🌍 全球一致: 全部 10 國市場板塊同方向 (≥60%)
//   4. 🔴 折溢價擴大: 溢價群 vs 折價群差距 > 0.30
//   5. ⚠️ 四級分歧: IT 子類出現溢價/折價對立
//   6. 📊 composite slope: 斜率指標確認方向 (最後10點)
//
// ── Config ──
const SECTOR_API = 'http://192.168.25.127:8288';
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';

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
const COUNTRY_LABELS = {
  UK:'英國',FR:'法國',DE:'德國',US:'美國大盤',US_SM:'美國小盤',CN:'A股',
  HK:'香港',JP:'日本',KR:'韓國',TW:'台灣',CH:'瑞士',NL:'荷蘭',ES:'西班牙',IT:'義大利',AU:'澳洲',SG:'新加坡'
};

// ── Volume Surge Targets (it9 指定) ──
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';
const VOLUME_THRESHOLD = 1.2;

const VOLUME_TARGETS = {
  precious_metals: { label:'貴金屬', symbols: ['AU0','AG0','IG:CFDGOLD','IG:CFDSILVER'] },
  crude_oil:       { label:'原油期貨', symbols: ['SC0','IG:LCO','IG:CL'] },
  crypto:          { label:'Crypto', symbols: ['BTC','ETH'] },
  forex:           { label:'匯率', symbols: ['SD_IDX:'] }, // prefix match
};

const INDEX_SERVER = 'http://localhost:3334';

// ── Timezone / Active Markets ──
function getHktTime(atStr) {
  if (atStr) {
    const d = new Date(atStr);
    return { h: d.getHours(), m: d.getMinutes(), ts: d.getTime() };
  }
  const now = new Date(Date.now() + 8 * 3600000); // HKT
  return { h: now.getUTCHours(), m: now.getUTCMinutes(), ts: now.getTime() };
}

function getActiveSessions(hktH, hktM) {
  const h = hktH + hktM / 60;
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

// ── HTTP helper ──
function httpGet(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Fetch Volume Surge Data ──
async function fetchVolumeSurge(btId) {
  if (btId) return dataProvider ? dataProvider.getVolumeSurge(atStr, btId) : null;
  try {
    if (require('fs').existsSync(VOLUME_SURGE_PATH)) {
      const raw = require('fs').readFileSync(VOLUME_SURGE_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}
  return null;
}

// ── Check Volume Surge ──
function checkVolumeSurge(volData) {
  const segments = volData?.segments || [];
  const matched = [];

  for (const entry of segments) {
    // segments is array of [key, data]
    const data = Array.isArray(entry) ? entry[1] : entry;
    if (!data || data.status !== 'active') continue;
    const sym = data.symbol || '';
    const ratio = data.ratio || 0;
    if (ratio < VOLUME_THRESHOLD) continue;

    for (const [catKey, cat] of Object.entries(VOLUME_TARGETS)) {
      if (cat.symbols.some(s => sym === s || sym.startsWith(s))) {
        matched.push({
          symbol: sym,
          category: cat.label,
          ratio,
          hourKey: data.hourKey || '',
          catKey,
        });
        break;
      }
    }
  }

  const hasSurge = matched.length > 0;
  return {
    hasSurge,
    matched,
    message: hasSurge
      ? `🔥 放量確認: ${matched.map(m => `${m.symbol}(${m.ratio}x,${m.category})`).join(', ')}`
      : '✅ 無相關放量（金/銀/油/BTC/ETH/匯率均無放量）',
    surgeByCategory: {
      precious_metals: matched.filter(m => m.catKey === 'precious_metals'),
      crude_oil: matched.filter(m => m.catKey === 'crude_oil'),
      crypto: matched.filter(m => m.catKey === 'crypto'),
      forex: matched.filter(m => m.catKey === 'forex'),
    }
  };
}

// ── Fetch tv-index Direction ──
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
          return {
            available: true,
            direction: dir,
            lastValue: last,
            prevValue: prev,
            message: `📊 tv-index 方向: ${dir === 'up' ? '📈上漲' : '📉下跌'} (${prev}→${last})`
          };
        }
      }
      return { available: true, direction: null, message: 'tv-index 數據不足判斷方向' };
    } catch {
      return { available: false, direction: null, message: '回測 index 錯誤' };
    }
  }
  try {
    const data = await httpGet(`${INDEX_SERVER}/api/data`, 3000);
    if (!data) return { available: false, direction: null, message: 'tv-index 無回應' };
    
    // composite index direction
    const composite = data.composite;
    if (Array.isArray(composite) && composite.length >= 3) {
      const len = composite.length;
      const last = composite[len-1]?.value;
      const prev = composite[len-3]?.value;
      if (last != null && prev != null) {
        const dir = last >= prev ? 'up' : 'down';
        return {
          available: true,
          direction: dir,
          lastValue: last,
          prevValue: prev,
          message: `📊 tv-index 方向: ${dir === 'up' ? '📈上漲' : '📉下跌'} (${prev}→${last})`
        };
      }
    }
    return { available: true, direction: null, message: 'tv-index 數據不足判斷方向' };
  } catch {
    return { available: false, direction: null, message: 'tv-index 連線失敗' };
  }
}

// ── Fetch Rotation Data ──
async function fetchRotationData(btId) {
  if (btId) return dataProvider ? dataProvider.getRotationData(atStr, btId) : null;
  // Try local file first
  const fs = require('fs');
  try {
    if (fs.existsSync(ROTATION_UI_PATH)) {
      const raw = fs.readFileSync(ROTATION_UI_PATH, 'utf-8');
      return JSON.parse(raw);
    }
  } catch {}

  // Try API
  const markets = ['asia_sector', 'china_sector', 'europe_sector', 'us_sector'];
  for (const m of markets) {
    try {
      const data = await httpGet(`${SECTOR_API}/signal/data/list?symbol=${m}&size=1`);
      if (data?.results?.[0]?.ai_data?.value) {
        return JSON.parse(data.results[0].ai_data.value);
      }
    } catch {}
  }
  return null;
}

// ── Step 3+4: Extract sector data & check consistency ──
function analyzeSectors(rotData, markets) {
  const marketData = [];
  let totalUp = 0, totalDown = 0, totalMixed = 0;

  for (const m of markets) {
    const c = rotData.countries?.[m];
    if (!c?.sector) continue;

    const s = c.sector;
    const up = s.UP || [], down = s.DOWN || [], multi = s.MULTI || [], neut = s.NEUTRAL || [];
    const total = up.length + down.length + multi.length + neut.length;
    if (total === 0) continue;

    const upPct = up.length / total;
    const downPct = down.length / total;
    const multiPct = multi.length / total;

    let direction, label;
    if (upPct >= 0.6) { direction = 'up'; label = '🟢一致看多'; totalUp++; }
    else if (downPct >= 0.6) { direction = 'down'; label = '🔴一致看空'; totalDown++; }
    else { direction = 'mixed'; label = '🟡多空分歧'; totalMixed++; }

    marketData.push({
      market: m,
      label: c.label || m,
      flag: COUNTRY_FLAGS[m] || '',
      direction,
      displayLabel: label,
      sectors: { up: up.map(x => SECTOR_CN[x] || x), down: down.map(x => SECTOR_CN[x] || x), multi: multi.map(x => SECTOR_CN[x] || x), neut },
      upPct: (upPct * 100).toFixed(0),
      downPct: (downPct * 100).toFixed(0),
    });
  }

  const totalM = marketData.length;
  const consistent = totalM > 0 && (totalUp === totalM || totalDown === totalM);
  const direction = totalUp > totalDown ? 'up' : 'down';

  return { marketData, consistent, direction, totalUp, totalDown, totalMixed, totalM };
}

// ── Step 5: Premium/Discount Spread ──
function calcSpread(rotData, markets) {
  let pSum = 0, pC = 0, dSum = 0, dC = 0;
  for (const m of markets) {
    const c = rotData.countries?.[m];
    if (!c?.RANK || c.RANK.length < 2) continue;
    const t = c.RANK.length;
    pSum += ((c.sector?.UP || []).length) / t; pC++;
    dSum += ((c.sector?.DOWN || []).length) / t; dC++;
  }
  const avgP = pC > 0 ? pSum / pC : 0;
  const avgD = dC > 0 ? dSum / dC : 0;
  const diff = Math.abs(avgP - avgD);
  const wide = diff > 0.3;
  return {
    avgP: (avgP * 100).toFixed(1) + '%',
    avgD: (avgD * 100).toFixed(1) + '%',
    diff: parseFloat(diff.toFixed(3)),
    wide,
    message: wide
      ? `⚠️ 折溢價差距擴大 (${diff.toFixed(2)}) — 溢價群均${(avgP*100).toFixed(0)}% / 折價群均${(avgD*100).toFixed(0)}%`
      : `✅ 折溢價正常 (${diff.toFixed(2)}) — 溢價群均${(avgP*100).toFixed(0)}% / 折價群均${(avgD*100).toFixed(0)}%`
  };
}

// ── Step 6: Sub-sector check ──
function checkSubSectors(rotData, markets) {
  const details = [];
  let divergent = false;

  for (const m of ['CN', 'US', 'US_SM']) {
    const c = rotData.countries?.[m];
    if (!c?.subSectors?.IT) continue;

    const groups = {};
    for (const [gk, g] of Object.entries(c.subSectors.IT)) {
      const sn = gk.replace(m + '_IT_', '').toUpperCase();
      const dirs = {};
      for (const d of ['UP', 'DOWN', 'MULTI', 'NEUTRAL']) {
        const items = g[d] || [];
        if (items.length > 0) {
          dirs[d] = items.map(i => i.split('_').pop());
        }
      }
      const keys = Object.keys(dirs);
      if (keys.length > 1) divergent = true;
      groups[sn] = dirs;
    }
    details.push({ market: m, label: c.label || m, flag: COUNTRY_FLAGS[m] || '', groups });
  }

  return {
    divergent,
    details,
    message: divergent
      ? '⚠️ 四級板塊出現分歧 — IT 子類溢價/折價不一致'
      : '✅ 四級板塊一致 — IT 子類無明顯分歧'
  };
}

// ── Slope calculation (composite index direction metric) ──
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

// ── Anal yze ALL markets (open + closed) for direction consistency ──
// 全部 10 國: US, US_SM, UK, FR, DE, JP, KR, TW, CN, HK
// 開盤市場用 sector UP/DOWN, 收盤市場用 VOL_TREND valid_trend
const ALL_COUNTRIES = ['US','US_SM','UK','FR','DE','JP','KR','TW','CN','HK'];

function analyzeAllMarkets(rotData) {
  const results = [];
  let totalUp = 0, totalDown = 0, mixed = 0;

  for (const m of ALL_COUNTRIES) {
    const c = rotData.countries?.[m];
    if (!c) continue;

    let direction, label;

    // Open market: use sector UP/DOWN distribution
    if (c.status === 'open' && c.sector) {
      const s = c.sector;
      const up = s.UP || [], down = s.DOWN || [], multi = s.MULTI || [], neut = s.NEUTRAL || [];
      const total = up.length + down.length + multi.length + neut.length;
      if (total === 0) { direction = 'neutral'; }
      else {
        const upPct = up.length / total;
        const downPct = down.length / total;
        if (upPct >= 0.6) { direction = 'up'; totalUp++; }
        else if (downPct >= 0.6) { direction = 'down'; totalDown++; }
        else { direction = 'mixed'; mixed++; }
      }
    }
    // Closed market: use VOL_TREND valid_trend as proxy
    else if (c.VOL_TREND) {
      let upCount = 0, downCount = 0, totalCount = 0;
      for (const [sec, vt] of Object.entries(c.VOL_TREND)) {
        if (vt.valid_trend === 'VALID_UP') { upCount++; totalCount++; }
        else if (vt.valid_trend === 'VALID_DOWN') { downCount++; totalCount++; }
      }
      if (totalCount === 0) { direction = 'neutral'; }
      else {
        const upPct = upCount / totalCount;
        const downPct = downCount / totalCount;
        if (upPct >= 0.6) { direction = 'up'; totalUp++; }
        else if (downPct >= 0.6) { direction = 'down'; totalDown++; }
        else { direction = 'mixed'; mixed++; }
      }
    } else {
      direction = 'neutral';
    }

    results.push({
      market: m,
      label: COUNTRY_LABELS[m] || m,
      flag: COUNTRY_FLAGS[m] || '',
      status: c.status || 'unknown',
      direction,
    });
  }

  const totalM = results.length;
  const consistent = totalM > 0 && (totalUp === totalM || totalDown === totalM);
  const globalDir = totalUp > totalDown ? 'up' : 'down';

  return {
    results,
    consistent,
    globalDir,
    totalUp, totalDown, mixed, totalM,
    message: consistent
      ? `🌍 全球一致 ${globalDir === 'up' ? '📈看多' : '📉看空'} (${totalUp}看多/${totalDown}看空/${mixed}分歧, ${totalM}國)`
      : `⚠️ 全球分歧 (${totalUp}看多/${totalDown}看空/${mixed}分歧, ${totalM}國)`
  };
}

// ── Main entry ──
async function main(options = {}) {
  const atStr = options.at || null;
  const backtestId = options.backtestId || null;
  const jsonMode = options.json || false;
  const dataProvider = backtestId ? require('./backtest/data-provider') : null;
  const log = jsonMode ? () => {} : console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    steps: [],
    triggered: false,
    triggerType: null,
    triggerReason: null,
  };

  // ── Step 1-2: Timezone ──
  const { h, m, ts } = getHktTime(atStr);
  const { sessions, markets } = getActiveMarkets(h, m);

  result.steps.push({ step: 1, name: '時區檢測', status: sessions.length > 0 ? 'pass' : 'fail',
    detail: sessions.map(s => s.label).join(' + ') || '休市', hktTime: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` });
  result.steps.push({ step: 2, name: '開盤市場', status: markets.length > 0 ? 'pass' : 'fail',
    detail: `${markets.length} 個市場: ${markets.join(', ')}`, markets: [...markets] });

  if (markets.length === 0) {
    result.triggered = false;
    result.triggerReason = '休市時段，無開盤市場';
    return result;
  }

  log(`🕐 ${result.steps[0].detail} | 開盤: ${markets.join(', ')}`);

  // ── Fetch data ──
  // Step 3: 商品放量檢查
  const volData = await fetchVolumeSurge(backtestId);
  const volResult = checkVolumeSurge(volData);
  result.steps.push({ step: 3, name: '商品放量(金銀/油/BTC/ETH/匯率)', status: volResult.hasSurge ? 'pass' : 'fail',
    detail: volResult.message, volumeSurge: volResult });

  if (!volResult.hasSurge) {
    result.triggered = false;
    result.triggerReason = volResult.message;
    return result;
  }

  log(volResult.message);

  const rotData = await fetchRotationData(backtestId);
  if (!rotData?.countries) {
    result.steps[2].status = 'fail';
    result.steps[2].detail = '無法取得折溢價數據 (8288)';
    result.triggered = false;
    result.triggerReason = '數據源不可用';
    return result;
  }

  log(`📡 取得 ${Object.keys(rotData.countries).length} 個市場數據`);

  // ── Step 4-5: Sector premium / consistency ──
  const analysis = analyzeSectors(rotData, markets);
  result.steps.push({ step: 4, name: '一級板塊折溢價', status: 'pass',
    detail: `🟢${analysis.totalUp}市場一致多 🔴${analysis.totalDown}市場一致空 🟡${analysis.totalMixed}分歧`,
    marketData: analysis.marketData });
  result.steps.push({ step: 5, name: '一致性判定', status: analysis.consistent ? 'pass' : 'fail',
    detail: analysis.consistent
      ? `✅ 一致行情 — ${analysis.direction === 'up' ? '📈全部看多' : '📉全部看空'} (${analysis.totalM}市場)`
      : `❌ 非一致行情 (看多${analysis.totalUp}/看空${analysis.totalDown}/分歧${analysis.totalMixed})`,
    consistent: analysis.consistent, direction: analysis.direction });

  if (!analysis.consistent) {
    result.triggered = false;
    result.triggerReason = '市場非一致性行情';
    return result;
  }

  log(`✅ 一致${analysis.direction === 'up' ? '📈' : '📉'} ${analysis.totalM}市場`);

  // ── Step 6: Spread ──
  const spread = calcSpread(rotData, markets);
  result.steps.push({ step: 6, name: '折溢價差距', status: spread.wide ? 'warn' : 'pass',
    detail: spread.message, spread });

  if (!spread.wide) {
    result.triggered = false;
    result.triggerReason = '折溢價差距正常，無明顯分歧';
    return result;
  }

  log(spread.message);

  // ── Step 7: 全球市場一致 (開盤+收盤) ──
  const allMarkets = analyzeAllMarkets(rotData);
  result.steps.push({ step: 7, name: '全球市場一致(10國)', status: allMarkets.consistent ? 'pass' : 'warn',
    detail: allMarkets.message, allMarkets: allMarkets.results });

  if (!allMarkets.consistent) {
    result.triggered = false;
    result.triggerReason = `全球市場不一致: ${allMarkets.message}`;
    return result;
  }

  // ── Step 8: Sub-sector ──
  const subSector = checkSubSectors(rotData, markets);
  result.steps.push({ step: 8, name: '四級板塊分歧', status: subSector.divergent ? 'warn' : 'pass',
    detail: subSector.message, subSectors: subSector.details });

  // ── Step 9: composite slope 方向確認 ──
  const slopeData = await fetchIndexDirection(backtestId);
  // Also compute slope from index data if available
  let slopeVal = null;
  try {
    let idxResp;
    if (backtestId) {
      idxResp = dataProvider ? dataProvider.getIndexData(atStr, backtestId) : null;
    } else {
      idxResp = await httpGet('http://localhost:3334/api/data', 3000);
    }
    if (idxResp?.indexData) slopeVal = calcSlope(idxResp.indexData, 10);
  } catch {}
  
  const events = [];
  if (slopeData.available) {
    events.push({ type: 'index_direction', detail: slopeData.message, slope: slopeVal });
  }
  const slopeMsg = slopeVal !== null
    ? `📐 composite slope: ${slopeVal.toFixed(4)} (${slopeVal > 0 ? '📈向上' : '📉向下'})`
    : '📐 composite slope: 不足10點';
  result.steps.push({ step: 9, name: 'composite slope+方向', status: slopeData.available ? 'pass' : 'info',
    detail: slopeMsg, slope: slopeVal, index: slopeData, events });

  // ── Step 10: Final ──
  const triggered = analysis.consistent && spread.wide && allMarkets.consistent;
  const turnDir = analysis.direction === 'up' ? '📈 上漲轉折' : '📉 下跌轉折';
  const reasons = [];
  reasons.push(`🔥放量(${volResult.matched.map(m=>m.symbol).join(',')})`);
  if (analysis.consistent) reasons.push(`一致${analysis.direction === 'up' ? '看多' : '看空'}`);
  if (spread.wide) reasons.push(`折溢價擴大${spread.diff}`);
  if (allMarkets.consistent) reasons.push(`🌍全球${allMarkets.globalDir === 'up' ? '看多' : '看空'}`);
  if (subSector.divergent) reasons.push('子版塊分歧');
  if (slopeVal !== null) reasons.push(slopeVal > 0 ? '📈slope向上' : '📉slope向下');

  result.steps.push({ step: 10, name: '觸發判斷', status: triggered ? 'trigger' : 'pass',
    detail: triggered
      ? `🚨 ${turnDir} 觸發！原因: ${reasons.join(' + ')}`
      : `✅ 哨兵未觸發 (${reasons.join(', ') || '無異常'})` });
  result.triggered = triggered;
  result.triggerType = triggered ? turnDir : null;
  result.triggerReason = triggered ? reasons.join(' + ') : '條件未滿足';

  if (triggered) {
    log(`🚨 ${turnDir} 觸發！${reasons.join(' + ')}`);
  } else {
    log(`✅ 哨兵未觸發`);
  }

  return result;
}

// ── CLI entry ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const atIndex = args.indexOf('--at');
  const atStr = atIndex >= 0 ? args[atIndex + 1] : null;
  const jsonMode = args.includes('--json');

  const btIndex = args.indexOf('--backtest-id');
  const btId = btIndex >= 0 ? args[btIndex + 1] : null;

  main({ at: atStr, json: jsonMode, backtestId: btId }).then(result => {
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n═════ 一致行情轉折哨兵 — 執行結果 ═════');
      console.log(`時間: ${result.atTime}`);
      console.log(`觸發: ${result.triggered ? '🚨 是' : '✅ 否'}`);
      if (result.triggered) console.log(`類型: ${result.triggerType}`);
      console.log(`原因: ${result.triggerReason}`);
      console.log('\n── 步驟明細 ──');
      for (const s of result.steps) {
        const icon = s.status === 'pass' ? '✅' : s.status === 'warn' ? '⚠️' : s.status === 'trigger' ? '🔴' : '❌';
        console.log(`  ${icon} Step ${s.step}: ${s.name} — ${s.detail}`);
      }
      console.log('═══════════════════════════════════\n');
    }
  }).catch(err => {
    console.error('執行錯誤:', err.message);
    process.exit(1);
  });
}

module.exports = { main, analyzeSectors, calcSpread, checkSubSectors, getActiveMarkets, getHktTime };
