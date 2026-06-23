#!/usr/bin/env node
/**
 * executor-slow-turn.js — 慢转折检测（v2 重构版，开发中）
 *
 * ⚠️ 当前为未完成版本，仅搭建框架结构。
 * 后续补充完整后将替换 executor-lt.js / executor-st.js。
 *
 * 设计概要：
 *   对 3 组产品（股票/指数/商品）做 A/B/C/D 条件检测，
 *   每个产品维护从趋势开始至今的转折记录，
 *   按 5 个板块（IT/FIN/IND/CD/SMALL）聚合出 ST/LT 信号。
 *
 * 使用（独立运行，不关联其他 executor）：
 *   node executor-slow-turn.js                 ← 当前时间
 *   node executor-slow-turn.js --at="..."      ← 历史时间
 *   node executor-slow-turn.js --json          ← JSON 输出
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const h = require('./tools/helpers');
const a = require('./tools/apis');

// ── K线服务器 ──
// 1G 指数组（IT_INDEX 等）→ 4003（tv-index dev）
// 2G 商品组（IG:CFDGOLD 等）→ 4002（K线主服务器）
// 1G 股票组（各市场板块）→ ⏳ 待确认映射
const KLINE_4002 = 'http://localhost:4002';
const KLINE_4003 = 'http://localhost:4003';

// ══════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════

function httpGet(url, timeout = 5000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
  });
}

// ══════════════════════════════════════════
//  1. 产品定义 — 3 组
// ══════════════════════════════════════════

/**
 * 1G 股票组：开盘市场的 5 个板块
 * 动态从 helpers.getActiveMarkets() 获取活跃市场
 * K线 symbol 映射：每个 (市场, 板块) 对应 4002 上的实际 symbol
 */
const STOCK_KLINE_MAP = {
  // UK
  'UK_IT': 'uk_it', 'UK_FIN': 'uk_f', 'UK_IND': 'uk_industry', 'UK_CD': 'uk_cd', 'UK_SMALL': null,
  // KR
  'KR_IT': 'kr_it', 'KR_FIN': 'kr_f', 'KR_IND': 'kr_industry', 'KR_CD': 'kr_cd', 'KR_SMALL': null,
  // JP
  'JP_IT': 'jp_it', 'JP_FIN': 'jp_bank', 'JP_IND': 'jp_machinery', 'JP_CD': null, 'JP_SMALL': null,
  // FR
  'FR_IT': 'fr_it', 'FR_FIN': 'fr_f', 'FR_IND': 'fr_industry', 'FR_CD': 'fr_cd', 'FR_SMALL': null,
  // DE
  'DE_IT': 'de_it', 'DE_FIN': 'de_f', 'DE_IND': 'de_industry', 'DE_CD': 'de_cd', 'DE_SMALL': null,
  // US
  'US_IT': 'us_it', 'US_FIN': 'us_f', 'US_IND': 'us_industry', 'US_CD': 'us_cd', 'US_SMALL': null,
  // SG
  'SG_IT': null, 'SG_FIN': null, 'SG_IND': null, 'SG_CD': null, 'SG_SMALL': null,
};

function getStockProducts() {
  const { markets } = h.getActiveMarkets();
  const SECTORS = ['IT', 'FIN', 'IND', 'CD', 'SMALL'];
  const products = [];
  for (const mkt of markets) {
    for (const sec of SECTORS) {
      const key = `${mkt}_${sec}`;
      const klineSym = STOCK_KLINE_MAP[key] || null;
      products.push({ group: 'stock', market: mkt, sector: sec, symbol: key, klineSymbol: klineSym });
    }
  }
  return products;
}

/**
 * 1G 指数组：收盘市场的板块指数
 * K线数据可从 4003 获取（symbol = IT_INDEX 等）
 */
function getIndexProducts() {
  const SECTORS = ['IT', 'FIN', 'IND', 'CD', 'SMALL'];
  return SECTORS.map(sec => ({ group: 'index', sector: sec, symbol: `${sec}_INDEX`, klineSymbol: `${sec}_INDEX` }));
}

/**
 * 2G 商品组：4 + 1 个品类
 *
 * 【待补充】农业商品品种列表
 * 【待补充】商品正负相关匹配名单
 */
const COMMODITY_CATEGORIES = {
  FX:      { label: '汇率',   symbols: ['SD_IDX:CNH','SD_IDX:JPY','SD_IDX:AUD','SD_IDX:EUR','SD_IDX:GBP','SD_IDX:CHF','SD_IDX:CAD'] },
  METAL:   { label: '贵金属', symbols: ['IG:CFDGOLD','IG:CFDSILVER','IG:COPPER'] },
  ENERGY:  { label: '石油',   symbols: ['IG:CL','IG:LCO','IG:SC0'] },
  CRYPTO:  { label: 'Crypto', symbols: ['BTC_SPOT','ETH_SPOT','SOL_SPOT'] },
  AGRI:    { label: '农业',   symbols: [] },  // ⏳ 待补充品种
};

// 放量 API (vol_rate_agg) 与产品 symbol 不一致时的映射
// 产品 symbol → vol_rate_agg symbol
const VOL_SURGE_ALIAS = {
  'BTC_SPOT': 'BTC',
  'ETH_SPOT': 'ETH',
  'SOL_SPOT': 'SOL',
  'IG:SC0': 'SC0',
  // 股票组映射
  'UK_IT': 'uk_it', 'UK_FIN': 'uk_f', 'UK_IND': 'uk_industry', 'UK_CD': 'uk_cd',
  'KR_IT': 'kr_it', 'KR_FIN': 'kr_f', 'KR_IND': 'kr_industry', 'KR_CD': 'kr_cd',
  'JP_IT': 'jp_it', 'JP_FIN': 'jp_bank', 'JP_IND': 'jp_machinery',
  'FR_IT': 'fr_it', 'FR_FIN': 'fr_f', 'FR_IND': 'fr_industry', 'FR_CD': 'fr_cd',
  'DE_IT': 'de_it', 'DE_FIN': 'de_f', 'DE_IND': 'de_industry', 'DE_CD': 'de_cd',
  'US_IT': 'us_it', 'US_FIN': 'us_f', 'US_IND': 'us_industry', 'US_CD': 'us_cd',
};

function getCommodityProducts() {
  const products = [];
  for (const [cat, info] of Object.entries(COMMODITY_CATEGORIES)) {
    for (const sym of info.symbols) {
      products.push({ group: 'commodity', category: cat, symbol: sym, klineSymbol: sym });
    }
  }
  return products;
}

// ══════════════════════════════════════════
//  2. 商品 → 板块 相关性映射
// ══════════════════════════════════════════

/**
 * 【待补充】完整正负相关匹配名单
 * 当前为占位结构
 */
const COMMODITY_SECTOR_RELEVANCE = {
  FX:     { IT: 0, FIN: 1, IND: 0, CD: 0, SMALL: 0 },     // 汇率 → FIN 正相关
  METAL:  { IT: 1, FIN: 0, IND: 0, CD: 0, SMALL: 0 },     // 贵金属 → IT 正相关
  ENERGY: { IT: 0, FIN: 0, IND: -1, CD: 0, SMALL: 0 },    // 石油 → IND 负相关
  CRYPTO: { IT: 0, FIN: 0, IND: 0, CD: 1, SMALL: 0 },     // Crypto → CD 正相关（待确认）
  AGRI:   { IT: 0, FIN: 0, IND: 0, CD: 0, SMALL: 1 },     // 农业 → SMALL 正相关（待确认）
};

// ══════════════════════════════════════════
//  3. B 条件：价格形态检测（纯算法，只需 price array）
// ══════════════════════════════════════════

/**
 * V 底检测：急跌后急涨
 * @param {number[]} closes - 收盘价序列（需 ≥ 20 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkVBottom(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;
  // 找窗口内最低点
  let lowestIdx = 0;
  let lowestVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] < lowestVal) { lowestVal = closes[i]; lowestIdx = i; }
  }

  // 谷底不能在两端（至少前后各有 5 根）
  if (lowestIdx < 5 || lowestIdx > n - 5) return { met: false, detail: '谷底在边缘' };

  // 前半段：从起点到谷底的跌幅
  const startPrice = closes[0];
  const dropPct = (lowestVal - startPrice) / startPrice;
  // 后半段：从谷底到终点涨幅
  const endPrice = closes[n - 1];
  const risePct = (endPrice - lowestVal) / lowestVal;

  // V 底特征：跌幅 > 阈值（如 -3%）且反弹 > 阈值（如 2%）
  const DROP_THRESHOLD = -0.03;
  const RISE_THRESHOLD = 0.02;

  if (dropPct <= DROP_THRESHOLD && risePct >= RISE_THRESHOLD) {
    return { met: true, detail: `V底(跌${(dropPct*100).toFixed(1)}%→涨${(risePct*100).toFixed(1)}%)` };
  }
  return { met: false, detail: `非V底(跌${(dropPct*100).toFixed(1)}%→涨${(risePct*100).toFixed(1)}%)` };
}

/**
 * W 底检测：二次回测不破低
 * @param {number[]} closes - 收盘价序列（需 ≥ 30 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkWBottom(closes) {
  if (!closes || closes.length < 30) return { met: false, detail: '数据不足' };

  const n = closes.length;
  const mid = Math.floor(n / 2);

  // 前半段找最低点
  const leftSlice = closes.slice(0, mid);
  const leftLow = Math.min(...leftSlice);
  const leftLowIdx = leftSlice.indexOf(leftLow);

  // 后半段找最低点
  const rightSlice = closes.slice(mid);
  const rightLow = Math.min(...rightSlice);
  const rightLowIdx = mid + rightSlice.indexOf(rightLow);

  // 两次低点相近（差值 < 2%）
  const diffPct = Math.abs(rightLow - leftLow) / Math.min(leftLow, rightLow);
  if (diffPct > 0.02) return { met: false, detail: `二次低点偏差${(diffPct*100).toFixed(1)}%>2%` };

  // 中间要有反弹：最低点到中间最高点的涨幅 > 2%
  const middleHigh = Math.max(...closes.slice(leftLowIdx, rightLowIdx + 1));
  const bouncePct = (middleHigh - Math.min(leftLow, rightLow)) / Math.min(leftLow, rightLow);
  if (bouncePct < 0.02) return { met: false, detail: `中间反弹不足(${(bouncePct*100).toFixed(1)}%)` };

  // 第二次不破前低
  if (rightLow < leftLow * 0.995) return { met: false, detail: '二次跌破前低' };

  return { met: true, detail: `W底(低1=${leftLow.toFixed(2)},低2=${rightLow.toFixed(2)},反弹${(bouncePct*100).toFixed(1)}%)` };
}

/**
 * 一字底检测：横盘平坦
 * @param {number[]} closes - 收盘价序列（需 ≥ 20 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkFlatBottom(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const range = (high - low) / low;

  // 波动范围 < 3% 判定为一字底
  const FLAT_THRESHOLD = 0.03;
  if (range <= FLAT_THRESHOLD) {
    return { met: true, detail: `一字底(波动${(range*100).toFixed(2)}%)` };
  }
  return { met: false, detail: `波动${(range*100).toFixed(2)}%>3%` };
}

/**
 * V 顶检测：急涨后急跌（V底的镜像）
 * @param {number[]} closes - 收盘价序列（需 ≥ 20 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkVTop(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;
  let highestIdx = 0, highestVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > highestVal) { highestVal = closes[i]; highestIdx = i; }
  }

  if (highestIdx < 5 || highestIdx > n - 5) return { met: false, detail: '顶在边缘' };

  const startPrice = closes[0];
  const risePct = (highestVal - startPrice) / startPrice;
  const endPrice = closes[n - 1];
  const dropPct = (endPrice - highestVal) / highestVal;

  const RISE_THRESHOLD = 0.03;
  const DROP_THRESHOLD = -0.02;

  if (risePct >= RISE_THRESHOLD && dropPct <= DROP_THRESHOLD) {
    return { met: true, detail: `V顶(涨${(risePct*100).toFixed(1)}%→跌${(dropPct*100).toFixed(1)}%)` };
  }
  return { met: false, detail: `非V顶(涨${(risePct*100).toFixed(1)}%→跌${(dropPct*100).toFixed(1)}%)` };
}

/**
 * M 顶检测：二次测试不破高（W底的镜像）
 * @param {number[]} closes - 收盘价序列（需 ≥ 30 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkMTop(closes) {
  if (!closes || closes.length < 30) return { met: false, detail: '数据不足' };

  const n = closes.length;
  const mid = Math.floor(n / 2);

  const leftSlice = closes.slice(0, mid);
  const leftHigh = Math.max(...leftSlice);
  const leftHighIdx = leftSlice.indexOf(leftHigh);

  const rightSlice = closes.slice(mid);
  const rightHigh = Math.max(...rightSlice);
  const rightHighIdx = mid + rightSlice.indexOf(rightHigh);

  const diffPct = Math.abs(rightHigh - leftHigh) / Math.min(leftHigh, rightHigh);
  if (diffPct > 0.02) return { met: false, detail: `二次高点偏差${(diffPct*100).toFixed(1)}%>2%` };

  const middleLow = Math.min(...closes.slice(leftHighIdx, rightHighIdx + 1));
  const dropPct = (Math.min(leftHigh, rightHigh) - middleLow) / Math.min(leftHigh, rightHigh);
  if (dropPct < 0.02) return { met: false, detail: `中间回调不足(${(dropPct*100).toFixed(1)}%)` };

  if (rightHigh < leftHigh * 0.995) return { met: false, detail: '二次高点低于前高' };

  return { met: true, detail: `M顶(高1=${leftHigh.toFixed(2)},高2=${rightHigh.toFixed(2)},回调${(dropPct*100).toFixed(1)}%)` };
}

/**
 * 一字顶检测：高位横盘平坦（一字底的镜像）
 * 价格在窗口上半部分 + 波动小
 * @param {number[]} closes - 收盘价序列（需 ≥ 20 根）
 * @returns {{ met: boolean, detail: string }}
 */
function checkFlatTop(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const high = Math.max(...closes);
  const low = Math.min(...closes);
  const range = (high - low) / low;

  if (range > 0.03) return { met: false, detail: `波动${(range*100).toFixed(2)}%>3%` };

  // 判定是否在高位：平均价格在全区间上半部分
  const avg = closes.reduce((a, b) => a + b, 0) / closes.length;
  const position = (avg - low) / (high - low);
  if (position < 0.4) return { met: false, detail: `位置偏低(${(position*100).toFixed(0)}%)非顶部` };

  return { met: true, detail: `一字顶(波动${(range*100).toFixed(2)}%,位置${(position*100).toFixed(0)}%)` };
}

/**
 * B 条件：综合价格形态检测
 * V底 / W底 / 一字底 / V顶 / M顶 / 一字顶，触发一个即算
 * 底形态 → direction = 'up'（转多）
 * 顶形态 → direction = 'down'（转空）
 */
function checkPricePattern(closes) {
  if (!closes || closes.length < 20) return { met: false, pattern: null, direction: null, detail: '数据不足' };

  // 底形态（转多）
  const v = checkVBottom(closes);
  if (v.met) return { met: true, pattern: 'V底', direction: 'up', detail: v.detail };

  const w = checkWBottom(closes);
  if (w.met) return { met: true, pattern: 'W底', direction: 'up', detail: w.detail };

  const f = checkFlatBottom(closes);
  if (f.met) return { met: true, pattern: '一字底', direction: 'up', detail: f.detail };

  // 顶形态（转空）
  const vt = checkVTop(closes);
  if (vt.met) return { met: true, pattern: 'V顶', direction: 'down', detail: vt.detail };

  const mt = checkMTop(closes);
  if (mt.met) return { met: true, pattern: 'M顶', direction: 'down', detail: mt.detail };

  const ft = checkFlatTop(closes);
  if (ft.met) return { met: true, pattern: '一字顶', direction: 'down', detail: ft.detail };

  return { met: false, pattern: null, direction: null, detail: `V底✗ W底✗ 一字底✗ V顶✗ M顶✗ 一字顶✗` };
}

/**
 * 获取产品的 K 线数据
 *
 * 1G 指数组 → 4003（IT_INDEX 等）
 * 2G 商品组 → 4002（IG:CFDGOLD 等）
 * 1G 股票组 → ⏳ 待实现板块→K线映射
 */
async function fetchProductKlines(product) {
  // 1G 指数组 → 4003
  if (product.group === 'index' && product.klineSymbol) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3 * 86400; // 3 days
    const data = await httpGet(`${KLINE_4003}/history?symbol=${product.klineSymbol}&resolution=15&from=${from}&to=${now}`, 5000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }

  // 2G 商品组 → 4002
  if (product.group === 'commodity' && product.klineSymbol) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3 * 86400;
    const data = await httpGet(`${KLINE_4002}/history?symbol=${product.klineSymbol}&resolution=15&from=${from}&to=${now}`, 5000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }

  // 1G 股票组 → 4002（有 klineSymbol 的才能查 K线）
  if (product.group === 'stock' && product.klineSymbol) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 3 * 86400;
    const data = await httpGet(`${KLINE_4002}/history?symbol=${product.klineSymbol}&resolution=15&from=${from}&to=${now}`, 5000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }
  if (product.group === 'stock' && !product.klineSymbol) {
    return { ok: false, detail: '该市场板块无K线映射' };
  }
}

// ══════════════════════════════════════════
//  4. D 条件：放量检测
// ══════════════════════════════════════════

/**
 * 从 8288 获取实时放量数据
 * 同 volume-surge-monitor 的数据源
/**
 * D 条件检测
 * 通过 tools/apis.js 的 fetchVolumeRate() 读取 current.rate（5分钟量比）
 * current.rate > 1.2 → 放量成立
 *
 * 特殊规则：指数组（index）默认没有量数据，跳过 D 条件
 */
async function checkConditionD(product) {
  // 指数组不适用 D 条件
  if (product.group === 'index') {
    return { met: true, skip: true, detail: '指数组 — 跳过D条件' };
  }

  try {
    const volMap = await a.fetchVolumeRate();
    const volSym = VOL_SURGE_ALIAS[product.symbol] || product.symbol;
    const rate = volMap[volSym];
    if (rate !== undefined && rate > 1.2) {
      return { met: true, detail: `放量(${rate.toFixed(2)}x)` };
    }
    return { met: false, detail: rate !== undefined ? `量不足(${rate.toFixed(2)}x)` : '无放量数据' };
  } catch {
    return { met: false, detail: '读取放量API失败' };
  }
}

// ══════════════════════════════════════════
//  5. A 条件：group 折溢价检测
// ══════════════════════════════════════════

/**
 * 【待补充】group 级折溢价数据源
 */
async function checkConditionA(product) {
  return { met: false, detail: '⏳ A条件待实现 — 缺group折溢价数据源' };
}

// ══════════════════════════════════════════
//  6. C 条件：关联事件检测
// ══════════════════════════════════════════

/**
 * 【待补充】事件的具体逻辑和设定
 */
async function checkConditionC(product) {
  return { met: false, detail: '⏳ C条件待实现 — 事件逻辑待补充' };
}

// ══════════════════════════════════════════
//  7. 单产品转折判断
// ══════════════════════════════════════════

/**
 * 对单个产品做 A/B/C/D 全量检测，判断是否有转折
 *
 * 判断逻辑：
 *   指数组：A + B（D 不适用）
 *     有C + A + B → 假转
 *     无C + A + B → 真转
 *   其他组：A + B + D
 *     有C + A + B + D → 假转
 *     无C + A + B + D → 真转
 *   其余 → 无转折
 */
async function checkProductTurnover(product) {
  const result = {
    symbol: product.symbol,
    group: product.group,
    sector: product.sector,
    category: product.category,
    hasTurnover: false,
    direction: null,       // 'up' / 'down'
    isFake: false,         // true = 假转折
    conditions: { a: null, b: null, c: null, d: null },
    detail: '',
  };

  // B 条件：价格形态
  const klines = await fetchProductKlines(product);
  if (klines.ok) {
    result.conditions.b = checkPricePattern(klines.closes);
  } else {
    result.conditions.b = { met: false, pattern: null, detail: klines.detail };
  }

  // A 条件：group 折溢价（待实现）
  result.conditions.a = await checkConditionA(product);

  // C 条件：事件（待实现）
  result.conditions.c = await checkConditionC(product);

  // D 条件：放量（指数组跳过）
  result.conditions.d = await checkConditionD(product);

  const bMet = result.conditions.b.met;
  const aMet = result.conditions.a.met;
  const cMet = result.conditions.c.met;
  const dMet = result.conditions.d.met;
  const dSkip = result.conditions.d.skip;

  if (!bMet) {
    result.detail = 'B条件不满足 — 无价格形态';
    return result;
  }

  if (!aMet) {
    result.detail = `B满足(${result.conditions.b.pattern}) 但A不满足 — 折溢价未扩大`;
    return result;
  }

  // 指数组：跳过 D，只需 A + B
  // 其他组：需要 A + B + D
  if (!dSkip && !dMet) {
    result.detail = `A+B满足 但D不满足 — ${result.conditions.d.detail}`;
    return result;
  }

  // 到达这里说明 A + B + (D跳过或D满足)
  result.hasTurnover = true;
  result.direction = result.conditions.b.direction || null;  // 由形态类型决定方向（底→up, 顶→down）

  if (cMet) {
    // 有事件支撑原趋势 → 假转
    result.isFake = true;
    result.detail = `🚨 假转 — 有持续支撑事件，A+B+D满足但事件不支持方向改变`;
  } else {
    // 无事件 → 真转
    result.isFake = false;
    result.detail = `🚨 真转 — A+B+D满足且无事件支撑，方向改变`;
  }

  return result;
}

// ══════════════════════════════════════════
//  8. 产品状态维护（内存状态）
// ══════════════════════════════════════════

/**
 * 从趋势开始时间至今，每个产品维护：
 * - 当前价格方向
 * - 依次发生的转折记录
 *
 * 【待补充】趋势开始时间（需要从 tracking-state 或 trend 输出获取）
 */
function createProductTracker() {
  // 从 state-machine.json 读取趋势开始时间
  let trendStartTime = null;
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-machine.json'), 'utf-8'));
    trendStartTime = sm.trendStartTime || null;
    // 如果没有 trendStartTime，尝试从最后一次 transition 推导
    if (!trendStartTime && sm.transitions?.length > 0) {
      trendStartTime = sm.transitions[sm.transitions.length - 1].at || null;
    }
  } catch {}

  return {
    trendStartTime,   // 趋势开始时间（从 state-machine.json 读取）
    products: {},     // { [symbol]: { currentDirection, turnovers[] } }
  };
}

function getOrCreateProductState(tracker, product) {
  if (!tracker.products[product.symbol]) {
    tracker.products[product.symbol] = {
      symbol: product.symbol,
      group: product.group,
      sector: product.sector,
      currentDirection: null,
      turnovers: [],
    };
  }
  return tracker.products[product.symbol];
}

function recordTurnover(state, direction, pattern, isFake) {
  state.turnovers.push({
    time: new Date().toISOString(),
    direction,
    pattern,
    isFake,
  });
  state.currentDirection = direction;  // 方向取最新转折的方向
}

// ══════════════════════════════════════════
//  9. 板块聚合
// ══════════════════════════════════════════

const ALL_SECTORS = ['IT', 'FIN', 'IND', 'CD', 'SMALL'];

/**
 * 对单个板块聚合 1G 和 2G 的转折方向
 *
 * 1G（股票 + 指数）：超过 50% 产品有转折且同向 → 1G 方向
 * 2G（商品）：超过 50% 产品有转折（考虑负相关取反）→ 2G 方向
 * 1G === 2G → 板块转折确认
 */
function aggregateSectorTurnover(tracker, sector) {
  const result = { sector, direction: null, confirmed: false, g1: null, g2: null, detail: '' };

  const g1Dirs = [];   // 1G 方向列表
  const g2Dirs = [];   // 2G 方向列表（已取反）

  for (const state of Object.values(tracker.products)) {
    if (!state.currentDirection) continue;

    if (state.sector !== sector) continue;

    if (state.group === 'stock' || state.group === 'index') {
      g1Dirs.push(state.currentDirection);
    } else if (state.group === 'commodity' && state.category) {
      const relevance = COMMODITY_SECTOR_RELEVANCE[state.category]?.[sector] || 0;
      if (relevance === 0) continue;
      // 负相关取反
      const adjustedDir = relevance === -1
        ? (state.currentDirection === 'up' ? 'down' : 'up')
        : state.currentDirection;
      g2Dirs.push(adjustedDir);
    }
  }

  // 1G 判定：超过 50% 同向
  const g1Up = g1Dirs.filter(d => d === 'up').length;
  const g1Down = g1Dirs.filter(d => d === 'down').length;
  const g1Total = g1Dirs.length;
  if (g1Total > 0) {
    if (g1Up / g1Total > 0.5) result.g1 = 'up';
    else if (g1Down / g1Total > 0.5) result.g1 = 'down';
  }

  // 2G 判定：超过 50% 同向
  const g2Up = g2Dirs.filter(d => d === 'up').length;
  const g2Down = g2Dirs.filter(d => d === 'down').length;
  const g2Total = g2Dirs.length;
  if (g2Total > 0) {
    if (g2Up / g2Total > 0.5) result.g2 = 'up';
    else if (g2Down / g2Total > 0.5) result.g2 = 'down';
  }

  // 1G + 2G 同向确认
  if (result.g1 && result.g2 && result.g1 === result.g2) {
    result.direction = result.g1;
    result.confirmed = true;
    result.detail = `1G=${result.g1}(${g1Up}/${g1Total}) 2G=${result.g2}(${g2Up}/${g2Total}) 一致✔`;
  } else {
    result.detail = `1G=${result.g1||'—'}(${g1Up}/${g1Total}) 2G=${result.g2||'—'}(${g2Up}/${g2Total}) 未一致`;
  }

  return result;
}

// ══════════════════════════════════════════
//  Main
// ══════════════════════════════════════════

async function main(options = {}) {
  const atStr = options.at || null;
  const jsonMode = options.json || false;
  const log = jsonMode ? () => {} : console.log;

  const result = {
    timestamp: new Date().toISOString(),
    atTime: atStr || 'now',
    dateKey: h.getHktDateKey(atStr ? new Date(atStr).getTime() : Date.now()),
    steps: [],
    signal: 'NONE',
    triggerDirection: null,
    products: { stock: [], index: [], commodity: [] },
    sectorResults: [],
    productResults: [],
    summary: '',
  };

  log(`
╔══════════════════════════════════════════╗
║   executor-slow-turn — 慢转折检测       ║
║   ⚠️ 开发中版本，未接入正式流程          ║
╚══════════════════════════════════════════╝`);

  // ── Step 1: 获取所有产品 ──
  const stockProducts = getStockProducts();
  const indexProducts = getIndexProducts();
  const commodityProducts = getCommodityProducts();

  result.products.stock = stockProducts;
  result.products.index = indexProducts;
  result.products.commodity = commodityProducts;

  log(`\n📋 产品清单:`);
  log(`  股票组:  ${stockProducts.length} 个`);
  log(`  指数组:  ${indexProducts.length} 个`);
  log(`  商品组:  ${commodityProducts.length} 个`);

  // ── Step 2: 创建产品跟踪器 ──
  const tracker = createProductTracker();
  result.trendStartTime = tracker.trendStartTime;
  const allProducts = [...stockProducts, ...indexProducts, ...commodityProducts];

  log(`\n🔍 逐产品检测...`);
  log(`  趋势开始时间: ${tracker.trendStartTime || '未知'}`);

  for (const product of allProducts) {
    const turnoverResult = await checkProductTurnover(product);

    if (turnoverResult.hasTurnover) {
      const state = getOrCreateProductState(tracker, product);
      recordTurnover(state, turnoverResult.direction, turnoverResult.conditions.b?.pattern, turnoverResult.isFake);
      log(`  🚨 ${product.symbol}: ${turnoverResult.detail}`);
    } else {
      log(`  ➖ ${product.symbol}: ${turnoverResult.detail}`);
    }

    result.productResults.push(turnoverResult);
  }

  // ── Step 3: 按板块聚合 ──
  log(`\n📊 板块聚合:`);
  for (const sector of ALL_SECTORS) {
    const sr = aggregateSectorTurnover(tracker, sector);
    result.sectorResults.push(sr);
    log(`  ${sector}: ${sr.detail}`);
  }

  // ── Step 4: 最终信号判定 ──
  const confirmedDirs = result.sectorResults.filter(s => s.confirmed).map(s => s.direction);
  const upCount = confirmedDirs.filter(d => d === 'up').length;
  const downCount = confirmedDirs.filter(d => d === 'down').length;
  const totalConfirmed = confirmedDirs.length;

  if (totalConfirmed > 0) {
    // 5 个板块同向
    if (upCount === 5) { result.signal = 'LT'; result.triggerDirection = 'up'; }
    else if (downCount === 5) { result.signal = 'ST'; result.triggerDirection = 'down'; }
  }

  result.summary = result.signal !== 'NONE'
    ? `🚨 ${result.signal} 触发 — ${totalConfirmed}/5 板块确认 ${result.triggerDirection==='up'?'📈转多':'📉转空'}`
    : `⏸️ 无转折 — ${totalConfirmed}/5 板块确认`;

  log(`\n══════════ 结果 ══════════`);
  log(result.summary);
  log(`═══════════════════════════`);

  // ── 待完成提示 ──
  log(`\n⏳ 待完成清单:`);
  log(`  1. A条件: group折溢价数据源（待补充）`);
  log(`  2. C条件: 事件逻辑（待补充）`);
  log(`  ✅ D条件: 已接入（查 8285 vol_rate_agg → current.rate）`);
  log(`  ✅ 4. 股票组K线映射（部分市场有映射，SMALL/JP_CD等无）`);
  log(`  5. 农业商品品种列表`);
  log(`  6. 商品正负相关全量名单`);
  log(`  ✅ 7. 转折方向判定（底形态→up, 顶形态→down）`);
  log(`  ✅ 8. 趋势开始时间追踪（从 state-machine.json 读取）`);

  return result;
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  const atI = args.indexOf('--at');
  const atStr = atI >= 0 ? args[atI + 1] : null;
  main({ at: atStr, json: args.includes('--json') }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r));
  }).catch(e => console.error(e.message));
}

module.exports = {
  main,
  getStockProducts, getIndexProducts, getCommodityProducts,
  checkVBottom, checkWBottom, checkFlatBottom, checkPricePattern,
  checkConditionD,
  aggregateSectorTurnover,
};
