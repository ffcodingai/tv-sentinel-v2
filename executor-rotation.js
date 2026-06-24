/**
 * rotation-turn — 确认轮动转折检测（RT）
 *
 * 当 trend 输出 FR 信号时，对监控名单中的板块做短期反转确认。
 *
 * 依赖：
 *   tracking-state-v2.json     — 持久化监控名单
 *   localhost:4003/history      — 1m K 线数据
 *
 * 输出信号：
 *   RT  — 所有监控板块均确认反转
 *   NONE — 条件不满足
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const a = require('./tools/apis');
const h = require('./tools/helpers');

const TRACKING_PATH = path.join(__dirname, 'tracking-state-v2.json');
const KLINE_SERVER = 'http://localhost:4003';

// Sector abbreviation → K-line symbol mapping
const SECTOR_SYMBOL_MAP = {
  IT: 'IT_INDEX',
  FIN: 'FIN_INDEX',
  IND: 'IND_INDEX',
  CD: 'CD_INDEX',
  AGRI: 'SMALL_INDEX',
};

// All 5 sectors (used to compute pending sectors)
const ALL_SECTORS = ['IT', 'FIN', 'IND', 'CD', 'AGRI'];

// ── Helpers ──

function loadTrackingState() {
  try {
    return JSON.parse(fs.readFileSync(TRACKING_PATH, 'utf-8'));
  } catch {
    return { conditions: {} };
  }
}

function saveTrackingState(state) {
  fs.writeFileSync(TRACKING_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch 20 1m bars for a sector symbol via 4003.
 */
async function fetchSectorBars(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 1200; // 20 minutes
  const url = `${KLINE_SERVER}/history?symbol=${symbol}&resolution=1&from=${from}&to=${now}`;
  const data = await httpGet(url, 5000);
  if (!data || data.s !== 'ok' || !data.t || data.t.length === 0) return { bars: 0, close: null };
  return { bars: data.t.length, close: data.c };
}

/**
 * Check if a single sector confirms reversal direction within 20 1m bars.
 * @param {number[]} closes - Array of close prices (last 20)
 * @param {string} direction - 'up' or 'down'
 * @returns {{ confirmed: boolean, reason: string }}
 */
function checkSectorReversal(closes, direction) {
  if (!closes || closes.length < 3) {
    return { confirmed: false, reason: '数据不足' };
  }

  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const amplitude = (high - low) / low;
  const currentPrice = closes[closes.length - 1];
  const position = (currentPrice - low) / (high - low); // 0~1, 0=最低, 1=最高

  if (amplitude < 0.003) {
    return { confirmed: false, reason: `振幅${(amplitude * 100).toFixed(2)}%<0.3%` };
  }

  if (direction === 'down') {
    // 确认下跌：价格在区间下半
    if (position < 0.5) {
      return { confirmed: true, reason: `确认下跌(振幅${(amplitude * 100).toFixed(2)}%,位置${(position * 100).toFixed(0)}%)` };
    }
    return { confirmed: false, reason: `价格偏高(位置${(position * 100).toFixed(0)}%>50%)` };
  }

  if (direction === 'up') {
    // 确认上涨：价格在区间上半
    if (position >= 0.5) {
      return { confirmed: true, reason: `确认上涨(振幅${(amplitude * 100).toFixed(2)}%,位置${(position * 100).toFixed(0)}%)` };
    }
    return { confirmed: false, reason: `价格偏低(位置${(position * 100).toFixed(0)}%<50%)` };
  }

  return { confirmed: false, reason: '未知方向' };
}

// ── Main ──

async function main(options = {}) {
  const jsonMode = options.json || false;
  const log = jsonMode ? () => {} : console.log;
  const atStr = options.at || null;

  const result = {
    timestamp: new Date().toISOString(),
    steps: [],
    signal: 'NONE',
    rtTriggered: false,
    monitorList: null,
    sources: '',
    reason: '',
  };

  // ── Step 1: 读取 trend 结果中的 FR 信号 ──
  // 如果从 --trend JSON 传入，直接解析；否则从 tracking-state 读
  let frActive = false;
  let frDirection = null;
  let frSectors = [];

  if (atStr) {
    // 历史回测模式：只从 tracking-state 读取（暂不支持）
    result.reason = '历史回测暂不支持';
    return result;
  }

  // 读取 TREND_JSON 环境变量或从 tracking-state 获取
  const trendJson = options.trendJson || null;
  if (trendJson) {
    try {
      const trend = typeof trendJson === 'string' ? JSON.parse(trendJson) : trendJson;
      if (trend.signal === 'FR' && trend.rotationDetail) {
        frActive = true;
        frDirection = trend.rotationDetail.direction;
        frSectors = trend.rotationDetail.sectors || [];
      }
    } catch (e) {
      // ignore
    }
  }

  // ── Step 2: 管理监控名单（读写 tracking-state） ──
  const state = loadTrackingState();
  const cachedMonitor = state.rotationMonitor || null;

  if (frActive && frSectors.length > 0) {
    // FR 触发 → 替换/更新监控名单
    state.rotationMonitor = {
      direction: frDirection,
      sectors: frSectors,
      timestamp: new Date().toISOString(),
    };
    saveTrackingState(state);
    result.steps.push({ step: 1, name: 'FR触发-更新监控名单', status: 'info', detail: `${frDirection} ${frSectors.join(',')}` });
  } else {
    // FR 未触发 → 保留现有监控名单（核心原则：名单在RT确认前一直保留）
    result.steps.push({ step: 1, name: 'FR未触发-保留监控名单', status: 'info', detail: cachedMonitor ? `${cachedMonitor.direction} ${cachedMonitor.sectors.join(',')}` : '无监控名单' });
  }

  // ── Step 3: 获取当前监控名单（若缓存有值则用缓存，文件已被清除时用缓存的备份）──
  const monitor = loadTrackingState().rotationMonitor || cachedMonitor;
  if (!monitor || !monitor.sectors || monitor.sectors.length === 0) {
    result.reason = '⏸️ 无监控名单';
    if (!jsonMode) log(`\n═════ RT 转折检测 ═════`);
    if (!jsonMode) log(`⏸️ 无监控名单`);
    return result;
  }

  result.monitorList = {
    direction: monitor.direction,
    sectors: [...monitor.sectors],
    pendingSectors: ALL_SECTORS.filter(s => !monitor.sectors.includes(s)),
  };

  if (!jsonMode) {
    log(`\n═════ RT 转折检测 ═════`);
    log(`监控名单: ${monitor.sectors.join(', ')} (${monitor.direction === 'down'?'📉':'📈'}方向)`);
  }

  // ── Step 4: 检查 global 板块折溢价是否缩小（条件1）──
  let spreadNarrowed = false;
  try {
    const now = Date.now();
    const s = encodeURIComponent(h.fmtHkt(now - 3600000));
    const e = encodeURIComponent(h.fmtHkt(now));
    const data = await a.httpGet(a.SIGNAL_DB + '/signal/data/list?symbol=global_sector&pageSize=1&startTime=' + s + '&endTime=' + e, 4000);
    if (data?.results?.length > 0) {
      const latest = JSON.parse(data.results[0].ai_data.value)?.MARKETS_SECTOR?.GL || {};
      spreadNarrowed = latest.SPREAD_TREND === '缩小';
    }
  } catch {}

  result.steps.push({ step: 4, name: 'global折溢價縮小', status: spreadNarrowed ? 'pass' : 'fail', detail: spreadNarrowed ? '✅ 缩小' : '⏸️ 未缩小' });

  if (!spreadNarrowed) {
    result.sources = 'global_sector:1笔';
    result.reason = '⏸️ global折溢價未缩小';
    if (!jsonMode) log(`⏸️ global折溢價未缩小`);
    return result;
  }

  // ── Step 5: 对每个板块做反转确认（条件2）──
  const barSources = [];
  const checkResults = [];
  let allConfirmed = true;

  for (const sector of monitor.sectors) {
    const symbol = SECTOR_SYMBOL_MAP[sector];
    if (!symbol) {
      checkResults.push({ sector, confirmed: false, reason: '无映射Symbol' });
      allConfirmed = false;
      continue;
    }

    const { bars, close } = await fetchSectorBars(symbol);
    barSources.push(`${sector}:${bars}笔`);
    if (!close || close.length < 3) {
      checkResults.push({ sector, confirmed: false, reason: `数据不足(${bars}笔)` });
      allConfirmed = false;
      continue;
    }

    const check = checkSectorReversal(close, monitor.direction);
    checkResults.push({ sector, confirmed: check.confirmed, reason: check.reason });
    if (!check.confirmed) allConfirmed = false;
  }

  // ── Step 6: 判定 ──
  result.rtTriggered = allConfirmed;
  result.signal = allConfirmed ? 'RT' : 'NONE';

  // 日志
  if (!jsonMode) {
    for (const cr of checkResults) {
      log(`  检查 ${cr.sector}: ${cr.confirmed ? '✅' : '⏸️'} ${cr.reason}`);
    }
  }

  if (result.rtTriggered && monitor.sectors.length > 0) {
    // 清除监控名单：转折确认了
    state.rotationMonitor = undefined;
    saveTrackingState(state);

    result.reason = `🚨 RT 触发！监控:${monitor.sectors.join(',')} | 即将转折:${result.monitorList.pendingSectors.join(',')}`;
    if (!jsonMode) log(`🚨 RT 触发！ | 监控:${monitor.sectors.join(',')} | 即将转折:${result.monitorList.pendingSectors.join(',')}`);
  } else {
    const reasons = checkResults.filter(r => !r.confirmed).map(r => `${r.sector}(${r.reason})`).join(',');
    result.reason = `⏸️ 未满足: ${reasons}`;
    if (!jsonMode) log(`⏸️ 未满足: ${reasons}`);
  }

  // ── Sources ──
  result.sources = 'global_sector:1笔' + (barSources.length > 0 ? ' | ' + barSources.join(' | ') : '');

  result.steps.push({ step: 6, name: '判定', status: result.rtTriggered ? 'trigger' : 'pass', detail: result.reason });

  if (!jsonMode) log('═══════════════════════');

  return result;
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const trendIdx = args.indexOf('--trend');
  const trendJson = trendIdx >= 0 ? args[trendIdx + 1] : null;
  main({ trendJson, json: args.includes('--json') }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r));
  }).catch(e => console.error(e.message));
}

module.exports = { main };
