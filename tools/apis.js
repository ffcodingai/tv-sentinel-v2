// ── API 調用：所有外部數據查詢統一入口 ──
const http = require('http');
const fs = require('fs');
const { fmtHkt } = require('./helpers');

// ── 服務地址常量 ──
const SIGNAL_DB = 'http://192.168.25.127:8285';
const SECTOR_SYMBOLS = ['asia_sector','china_sector','europe_sector','us_sector'];
const KLINE_SERVER = 'http://localhost:4002';
const INDEX_SERVER = 'http://localhost:3334';
const NEWS_API = 'http://192.168.25.190:3000';

// ── 文件型數據源（當前用本地文件，未來可替換為 API）──
const ROTATION_UI_PATH = '/tmp/sector-rotation-ui.json';
const VOLUME_SURGE_PATH = '/tmp/volume-surge-segments.json';

// ── 底層 HTTP ──

function httpGet(url, timeout = 5000, maxRetries = 3) {
  return new Promise((resolve) => {
    function attempt(n) {
      const req = http.get(url, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => {
          try { resolve(JSON.parse(b)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => {
        if (n < maxRetries) setTimeout(() => attempt(n + 1), 3000);
        else resolve(null);
      });
      req.setTimeout(timeout, () => {
        req.destroy();
        if (n < maxRetries) setTimeout(() => attempt(n + 1), 3000);
        else resolve(null);
      });
    }
    attempt(1);
  });
}

// ──────────────────────────────────────────
//  HTTP API 類數據源
// ──────────────────────────────────────────

async function fetchSpreadAgg(pageSize = 5) {
  const now = Date.now();
  const s = encodeURIComponent(fmtHkt(now - 3600000));
  const e = encodeURIComponent(fmtHkt(now));
  return httpGet(
    `${SIGNAL_DB}/signal/data/list?startTime=${s}&endTime=${e}&symbol=global_spread_agg&pageSize=${pageSize}`,
    5000
  );
}

/**
 * A2: sector SPREAD_TREND 板塊折溢價
 * @param {string[]} [activeCodes] - 僅返回這些市場的數據
 * @param {number} maxRecords - 每 symbol 取最新幾條（0=全部, 1=最新1條, 2=最新2條...）
 */
async function fetchSectorSpread(activeCodes = null, maxRecords = 0) {
  const now = Date.now();
  const s = encodeURIComponent(fmtHkt(now - 3600000));
  const e = encodeURIComponent(fmtHkt(now));
  const allResults = [];

  for (const sym of SECTOR_SYMBOLS) {
    const data = await httpGet(
      SIGNAL_DB + '/signal/data/list?symbol=' + sym + '&startTime=' + s + '&endTime=' + e,
      4000
    );
    if (!data?.results?.length) continue;

    const sorted = (data.results || [])
      .map(r => ({ time: r.ai_data.closeTime, value: r.ai_data.value }))
      .sort((a, b) => b.time - a.time);

    const limit = maxRecords > 0 ? Math.min(maxRecords, sorted.length) : sorted.length;
    for (let i = 0; i < limit; i++) {
      const r = sorted[i];
      const ms = JSON.parse(r.value)?.MARKETS_SECTOR || {};
      const spreads = {};
      for (const code of Object.keys(ms)) {
        if (activeCodes && !activeCodes.includes(code)) continue;
        const st = ms[code]?.SPREAD_TREND;
        if (st) spreads[code] = st;
      }
      if (Object.keys(spreads).length > 0) {
        allResults.push({ time: r.time, symbol: sym, spreads });
      }
    }
  }
  return allResults;
}

async function fetchKlineHistory(symbol, resolution = 'D', from, to) {
  return httpGet(
    `${KLINE_SERVER}/history?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}`,
    4000
  );
}

async function fetchCompositeIndex() {
  return httpGet(`${INDEX_SERVER}/api/data`, 2000);
}

async function fetchNewsEvents(limit = 5) {
  return httpGet(`${NEWS_API}/api/news?limit=${limit}`, 4000);
}

// ──────────────────────────────────────────
//  文件型數據源（預留 API 替換位）
// ──────────────────────────────────────────

function fetchRotationUI() {
  try {
    if (fs.existsSync(ROTATION_UI_PATH)) {
      return JSON.parse(fs.readFileSync(ROTATION_UI_PATH, 'utf-8'));
    }
  } catch {}
  return null;
}

function fetchVolumeSurge() {
  try {
    if (fs.existsSync(VOLUME_SURGE_PATH)) {
      return JSON.parse(fs.readFileSync(VOLUME_SURGE_PATH, 'utf-8'));
    }
  } catch {}
  return { segments: [] };
}


async function fetchFuturesIndexes() {
  const data = await httpGet('http://localhost:3336/api/data', 3000);
  if (!data) return null;
  const result = {};
  for (const k of ['FIN','TECH','IND','CD','SMALL']) {
    const v = data[k];
    if (v && v.slope !== undefined) {
      const slope = v.slope;
      result[k] = { change: v.change, slope, direction: slope > 0.1 ? 'up' : slope < -0.1 ? 'down' : 'flat' };
    }
  }
  return result;
}

module.exports = {
  SIGNAL_DB,
  SECTOR_SYMBOLS,
  KLINE_SERVER,
  INDEX_SERVER,
  httpGet,
  fetchSpreadAgg,
  fetchSectorSpread,
  fetchKlineHistory,
  fetchCompositeIndex,
  fetchNewsEvents,
  fetchRotationUI,
  fetchVolumeSurge,
  fetchFuturesIndexes,
};
