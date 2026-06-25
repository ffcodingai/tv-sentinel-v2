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

// ── 可调参数 ──
const CONFIG = {
  KLINE_RESOLUTION: '5',           // K线分辨率（5分钟）
  ROLLBACK_SLOPE_THRESHOLD: 0.0005, // 回滚斜率阈值：每根K线价格变化 0.05%
  ROLLBACK_MIN_KLINES: 4,           // 回滚检测最少K线数
};

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
//
//  数据来源：sector-dict.js (tradingview-ui-backend-dev)
//  本地维护一份独立定义，不直接 import，因为：
//    - slow-turn 板块名与 sector-dict 不同 (IT/FIN/IND/CD/SMALL vs IT/金融/工业/可选消费/农业)
//    - slow-turn 有自己的市场白名单和品种筛选
//    - 后续可能新增 slow-turn 专属品种
// ══════════════════════════════════════════

// ── slow-turn 板块名 ──
const ALL_SECTORS = ['IT', 'FIN', 'IND', 'CD', 'SMALL'];
// sector-dict 对应: IT→IT, FIN→金融, IND→工业, CD→可选消费, SMALL→农业

// ── helpers.js 市场代码 → sector-dict 国家名 ──
const MARKET_TO_COUNTRY = {
  'JP': '日本',
  'KR': '韩国',
  'CN': 'A股',
  'HK': '香港',
  'UK': '英国',
  'FR': '法国',
  'DE': '德国',
  'US': '美国大盘',
  'US_SM': '美国小盘',
};

// 有 sector API 支持的市场才纳入 A 条件计算 (排除 AU/SG/TW)
const STOCK_MARKETS_WITH_SPREAD = ['CN','HK','JP','KR','UK','FR','DE','US','US_SM'];

/**
 * 股票组产品定义表
 *
 * 每个市场 × 5 板块，列出该 (市场, 板块) 的全部产品：
 *   kline   → 4002 K线 symbol (用于 B条件形态检测)
 *   vol     → 8285 vol_rate_agg 量symbol (用于 D条件放量)
 *   spread  → 8285 sector API 市场代码 (用于 A条件折溢价)
 *
 * 数据搬迁自 sector-dict.js 的 SECTORS + VOLUME_SYMBOLS + SYMBOL_COUNTRY
 * 农业板块(SMALL)在 sector-dict 中每市场有多个产品，这里全部列出。
 */
const STOCK_PRODUCTS = {
  // ═══ 日本 ═══
  'JP': {
    IT:    [{ kline: 'JP_IT',     vol: 'jp_it' }],
    FIN:   [{ kline: 'JP_F',      vol: 'jp_bank' }],
    IND:   [{ kline: 'JP_I',      vol: 'jp_machinery' }],
    CD:    [{ kline: 'JP_CD',     vol: 'jp_car' }],
    SMALL: [{ kline: 'JP_U',      vol: 'jp_property' }],
  },
  // ═══ 韩国 ═══
  'KR': {
    IT:    [{ kline: 'KR_IT',     vol: 'kr_it' }],
    FIN:   [{ kline: 'KR_F',      vol: 'kr_f' }],
    IND:   [{ kline: 'KR_I',      vol: 'kr_industry' }],
    CD:    [{ kline: 'KR_CD',     vol: 'kr_cd' }],
    SMALL: [{ kline: 'KR_H',      vol: 'kr_medical' }],
  },
  // ═══ A股 ═══
  'CN': {
    IT:    [{ kline: '399388',    vol: 'cn_szse_computer_software' }],
    FIN:   [{ kline: '399914',    vol: 'cn_szse_banking' }],
    IND:   [{ kline: '399383',    vol: 'cn_szse_battery_power_equipment' }],
    CD:    [{ kline: '399384',    vol: 'cn_szse_home_appliances' }],
    SMALL: [
      { kline: '399386',          vol: 'cn_szse_healthcare' },
      { kline: '399438',          vol: 'cn_szse_utilities_power' },
      { kline: '399241',          vol: 'cn_szse_real_estate' },
    ],
  },
  // ═══ 香港 ═══
  'HK': {
    IT:    [{ kline: 'HSCI.IT',   vol: 'hsci_it' }],
    FIN:   [{ kline: 'HSCI.F',    vol: 'hsci_f' }],
    IND:   [{ kline: null,        vol: null }],  // ❌ 香港无工业板块指数
    CD:    [{ kline: 'HSCI.CD',   vol: 'hsci_cd' }],
    SMALL: [
      { kline: 'HSCI.H',          vol: 'hsci_h' },
      { kline: 'HSCI.U',          vol: 'hsci_u' },
      { kline: 'HSCI.P',          vol: 'hsci_p' },
    ],
  },
  // ═══ 英国 ═══
  'UK': {
    IT:    [{ kline: 'GB_IT',     vol: 'uk_it' }],
    FIN:   [{ kline: 'GB_F',      vol: 'uk_f' }],
    IND:   [{ kline: 'GB_I',      vol: 'uk_industry' }],
    CD:    [{ kline: 'GB_CD',     vol: 'uk_cd' }],
    SMALL: [
      { kline: 'GB_CS',           vol: 'uk_c' },
      { kline: 'GB_H',            vol: 'uk_medical' },
      { kline: 'GB_U',            vol: 'uk_property' },
    ],
  },
  // ═══ 法国 ═══
  'FR': {
    IT:    [{ kline: 'FR_IT',     vol: 'fr_it' }],
    FIN:   [{ kline: 'FR_F',      vol: 'fr_f' }],
    IND:   [{ kline: 'FR_I',      vol: 'fr_industry' }],
    CD:    [{ kline: 'FR_CD',     vol: 'fr_cd' }],
    SMALL: [
      { kline: 'FR_CS',           vol: 'fr_c' },
      { kline: 'FR_H',            vol: 'fr_medical' },
    ],
  },
  // ═══ 德国 ═══
  'DE': {
    IT:    [{ kline: 'DE_IT',     vol: 'de_it' }],
    FIN:   [{ kline: 'DE_F',      vol: 'de_f' }],
    IND:   [{ kline: 'DE_I',      vol: 'de_industry' }],
    CD:    [{ kline: 'DE_CD',     vol: 'de_cd' }],
    SMALL: [{ kline: 'DE_H',      vol: 'de_medical' }],
  },
  // ═══ 美国大盘 ═══
  'US': {
    IT:    [{ kline: 'S5INFT',    vol: 'us_500_it' }],
    FIN:   [{ kline: 'SPF',       vol: 'us_500_f' }],
    IND:   [{ kline: 'S5INDU',    vol: 'us_500_industry' }],
    CD:    [{ kline: 'S5COND',    vol: 'us_500_cd' }],
    SMALL: [
      { kline: 'S5CONS',          vol: 'us_500_c' },
      { kline: 'S5HLTH',          vol: 'us_500_medical' },
      { kline: 'S5REAS',          vol: 'us_500_property' },
    ],
  },
  // ═══ 美国小盘 ═══
  'US_SM': {
    IT:    [{ kline: 'NQUSS10',   vol: 'us_it' }],
    FIN:   [{ kline: 'NQUSS30',   vol: 'us_f' }],
    IND:   [{ kline: 'NQUSS50',   vol: 'us_industry' }],
    CD:    [{ kline: 'NQUSS40',   vol: 'us_cd' }],
    SMALL: [
      { kline: 'NQUSS20',         vol: 'us_medical' },
      { kline: 'NQUSS35',         vol: 'us_property' },
    ],
  },
};

/**
 * 获取股票组产品 — 仅当前开盘市场
 *
 * 单产品板块：直接返回该产品
 * 多产品板块（SMALL）：合成为一个合成产品，symbol = `${market}_SMALL_SYNTH`
 *   - K线：运行时拉取各子产品K线 → 波动率归一化等权合成（buildSyntheticCloses）
 *   - 放量：任一子产品触发放量即算（checkConditionD 遍历 subSymbols）
 */
function getStockProducts(atTime) {
  const { markets } = h.getActiveMarkets(atTime);
  const products = [];
  for (const mkt of markets) {
    if (!STOCK_MARKETS_WITH_SPREAD.includes(mkt)) continue;
    const marketDef = STOCK_PRODUCTS[mkt];
    if (!marketDef) continue;
    for (const sec of ALL_SECTORS) {
      const items = marketDef[sec];
      if (!items) continue;
      const validItems = items.filter(it => it.kline);
      if (validItems.length === 0) continue;  // 跳过无K线映射的（如 HK.IND）

      if (validItems.length === 1) {
        // 单产品板块
        products.push({
          group: 'stock',
          market: mkt,
          sector: sec,
          symbol: validItems[0].kline,
          klineSymbol: validItems[0].kline,
          volSymbol: validItems[0].vol,
        });
      } else {
        // 多产品板块 → 合成产品
        products.push({
          group: 'stock',
          market: mkt,
          sector: sec,
          symbol: `${mkt}_${sec}_SYNTH`,        // 合成标识
          klineSymbol: null,                      // 合成产品无单一K线symbol
          volSymbol: null,                        // 合成产品无单一量symbol
          isSynthetic: true,                      // 标记为合成产品
          subSymbols: validItems.map(it => ({
            kline: it.kline,
            vol: it.vol,
          })),
        });
      }
    }
  }
  return products;
}

/**
 * 1G 指数组：5 个板块的综合指数
 * K线数据从 4003 获取 (symbol = IT_INDEX / FIN_INDEX / IND_INDEX / CD_INDEX / SMALL_INDEX)
 */
function getIndexProducts() {
  return ALL_SECTORS.map(sec => ({
    group: 'index',
    sector: sec,
    symbol: `${sec}_INDEX`,
    klineSymbol: `${sec}_INDEX`,
    volSymbol: null,  // 指数组无放量数据
  }));
}

/**
 * 2G 商品组：5 个品类
 *
 * 每个品类列出的品种同时给出：
 *   kline → K线 symbol (用于 B条件形态检测，走 4002)
 *   vol   → vol_rate_agg 量symbol (用于 D条件放量)
 *
 * 数据搬迁自 sector-dict.js + volume-surge-monitor.js CATEGORY
 */
const COMMODITY_CATEGORIES = {
  FX: {
    label: '汇率',
    symbols: [
      { kline: 'EUR_FX',  vol: 'SD_IDX:EUR' },
      { kline: 'JPY_FX',  vol: 'SD_IDX:JPY' },
      { kline: 'GBP_FX',  vol: 'SD_IDX:GBP' },
      { kline: 'AUD_FX',  vol: 'SD_IDX:AUD' },
      { kline: 'CHF_FX',  vol: 'SD_IDX:CHF' },
      { kline: 'CAD_FX',  vol: 'SD_IDX:CAD' },
    ],
  },
  METAL: {
    label: '贵金属',
    symbols: [
      { kline: 'IG:CFDGOLD',   vol: 'IG:CFDGOLD' },
      { kline: 'IG:CFDSILVER', vol: 'IG:CFDSILVER' },
      { kline: 'IG:COPPER',    vol: 'IG:COPPER' },
      { kline: 'XPTUSD',       vol: 'CAPITALCOM:XPTUSD' },
      { kline: 'XPDUSD',       vol: 'CAPITALCOM:XPDUSD' },
    ],
  },
  ENERGY: {
    label: '能源',
    symbols: [
      { kline: 'IG:CL',     vol: 'IG:CL' },
      { kline: 'IG:LCO',    vol: 'IG:LCO' },
      { kline: 'GASOIL',    vol: 'CAPITALCOM:GASOIL' },
      { kline: 'IG:NG',     vol: 'IG:NG' },
    ],
  },
  CRYPTO: {
    label: 'Crypto',
    symbols: [
      { kline: 'BTC_SPOT',  vol: 'BTC' },
      { kline: 'ETH_SPOT',  vol: 'ETH' },
      { kline: 'SOL_SPOT',  vol: 'SOL' },
    ],
  },
  AGRI: {
    label: '农业',
    symbols: [
      // ⚠️ volume-surge 里 C→IG:C, S→IG:S, COTTON→PEPPERSTONE:COTTON, SUGAR→PEPPERSTONE:SUGAR
      { kline: 'C',       vol: 'IG:C' },
      { kline: 'S',       vol: 'IG:S' },
      { kline: 'COTTON',  vol: 'PEPPERSTONE:COTTON' },
      { kline: 'WHEAT',   vol: 'PEPPERSTONE:WHEAT' },
      { kline: 'SUGAR',   vol: 'PEPPERSTONE:SUGAR' },
    ],
  },
};

function getCommodityProducts() {
  const products = [];
  for (const [cat, info] of Object.entries(COMMODITY_CATEGORIES)) {
    for (const item of info.symbols) {
      products.push({
        group: 'commodity',
        category: cat,
        symbol: item.kline,
        klineSymbol: item.kline,
        volSymbol: item.vol,
      });
    }
  }
  return products;
}

// ══════════════════════════════════════════
//  2. 商品 → 板块 相关性映射
// ══════════════════════════════════════════

/**
 * 商品 → 板块 相关性映射
 * 正相关 (1)：商品方向直接传递给板块
 * 负相关 (-1)：商品方向取反后传递给板块
 *
 * 定义（Alisa 6/24 确认）：
 *   IT     ← 贵金属 (正相关)
 *   FIN    ← 汇率 (正相关)
 *   CD     ← CRYPTO (正相关)
 *   IND    ← 能源/石油 (正相关)
 *   SMALL  ← 农业 (负相关)
 */
const COMMODITY_SECTOR_RELEVANCE = {
  FX:     { IT: 0, FIN: 1, IND: 0, CD: 0, SMALL: 0 },     // 汇率 → FIN 正相关
  METAL:  { IT: 1, FIN: 0, IND: 0, CD: 0, SMALL: 0 },     // 贵金属 → IT 正相关
  ENERGY: { IT: 0, FIN: 0, IND: 1, CD: 0, SMALL: 0 },     // 能源/石油 → IND 正相关
  CRYPTO: { IT: 0, FIN: 0, IND: 0, CD: 1, SMALL: 0 },     // Crypto → CD 正相关
  AGRI:   { IT: 0, FIN: 0, IND: 0, CD: 0, SMALL: -1 },    // 农业 → SMALL 负相关
};

// ══════════════════════════════════════════
//  3. B 条件：价格形态检测（纯算法，只需 price array）
// ══════════════════════════════════════════

/**
 * V 底检测：急跌→单点极端低点→急涨，高斜率，左右对称
 *
 * 1. 前半段：高斜率直线向下
 * 2. 底点：触及孤立极端最低点，立即逆转
 * 3. 后半段：高斜率直线向上，与前半段对称
 */
function checkVBottom(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;

  // 找最低点
  let lowestIdx = 0, lowestVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] < lowestVal) { lowestVal = closes[i]; lowestIdx = i; }
  }

  // 底点不能在两端
  if (lowestIdx < 5 || lowestIdx > n - 5) return { met: false, detail: '底点在边缘' };

  // 前半段：起点到低点的跌幅
  const startPrice = closes[0];
  const dropPct = (lowestVal - startPrice) / startPrice;
  if (dropPct > -0.02) return { met: false, detail: `前半段跌幅不足(${(dropPct*100).toFixed(1)}%)` };

  // 后半段：低点到终点的涨幅
  const endPrice = closes[n - 1];
  const risePct = (endPrice - lowestVal) / lowestVal;
  if (risePct < 0.02) return { met: false, detail: `后半段涨幅不足(${(risePct*100).toFixed(1)}%)` };

  // 斜率对称性：前半段跌幅速率 vs 后半段涨幅速率
  const leftSlope = Math.abs(dropPct) / lowestIdx;       // 每根K线的跌幅
  const rightSlope = risePct / (n - 1 - lowestIdx);       // 每根K线的涨幅
  const ratio = Math.min(leftSlope, rightSlope) / Math.max(leftSlope, rightSlope);
  if (ratio < 0.3) return { met: false, detail: `V形不对称(左斜${(leftSlope*100).toFixed(3)}%/右斜${(rightSlope*100).toFixed(3)}%,比${(ratio*100).toFixed(0)}%)` };

  // 单点转折：底点附近5根内没有二次接近底点的价格（无二次回踩）
  const neighborhood = 5;
  const threshold = lowestVal * 1.005; // 0.5%以内算接近
  let nearCount = 0;
  for (let i = Math.max(0, lowestIdx - neighborhood); i <= Math.min(n - 1, lowestIdx + neighborhood); i++) {
    if (closes[i] <= threshold) nearCount++;
  }
  if (nearCount > 3) return { met: false, detail: `底点非单点转折(附近${nearCount}根接近底价)` };

  return { met: true, detail: `V底(跌${(dropPct*100).toFixed(1)}%→涨${(risePct*100).toFixed(1)}%,对称${(ratio*100).toFixed(0)}%)` };
}

/**
 * W 底检测：双底回测，颈线突破
 *
 * 1. 第一底：价格下跌触及低点A，随后反弹形成颈线位
 * 2. 第二底：从颈线再次下跌，在低点A附近（水平相近）停止
 * 3. 最终突破：从低点B反弹并突破颈线位
 */
function checkWBottom(closes) {
  if (!closes || closes.length < 30) return { met: false, detail: '数据不足' };

  const n = closes.length;

  // 找全局最低点（低点A）
  let aIdx = 0, aVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] < aVal) { aVal = closes[i]; aIdx = i; }
  }
  if (aIdx < 3 || aIdx > n - 10) return { met: false, detail: '低点A位置不适合' };

  // 低点A之后找颈线位（A到末段的最高点）
  let neckIdx = aIdx, neckVal = closes[aIdx];
  for (let i = aIdx + 1; i < n; i++) {
    if (closes[i] > neckVal) { neckVal = closes[i]; neckIdx = i; }
  }
  if (neckIdx === n - 1) return { met: false, detail: '颈线在末尾，未形成第二底' };

  // 颈线之后找低点B
  let bIdx = neckIdx, bVal = closes[neckIdx];
  for (let i = neckIdx + 1; i < n; i++) {
    if (closes[i] < bVal) { bVal = closes[i]; bIdx = i; }
  }
  if (bIdx === n - 1) return { met: false, detail: '低点B在末尾，未突破颈线' };

  // 低点A和低点B水平相近（差值 < 2%）
  const diffPct = Math.abs(bVal - aVal) / Math.min(aVal, bVal);
  if (diffPct > 0.02) return { met: false, detail: `双底偏差${(diffPct*100).toFixed(1)}%>2%` };

  // 颈线反弹幅度 > 2%
  const bouncePct = (neckVal - Math.min(aVal, bVal)) / Math.min(aVal, bVal);
  if (bouncePct < 0.02) return { met: false, detail: `颈线反弹不足(${(bouncePct*100).toFixed(1)}%)` };

  // 最终突破：末尾价格突破颈线
  const endPrice = closes[n - 1];
  if (endPrice < neckVal) return { met: false, detail: `未突破颈线(末价${endPrice.toFixed(2)}<颈线${neckVal.toFixed(2)})` };

  return { met: true, detail: `W底(低A=${aVal.toFixed(2)}@${aIdx},颈线=${neckVal.toFixed(2)}@${neckIdx},低B=${bVal.toFixed(2)}@${bIdx},突破)` };
}

/**
 * 一字底检测：低位横盘后向上突破
 *
 * 1. 前半段：价格明显下跌趋势
 * 2. 底部横盘：价格转为水平，低点齐平，波动极小
 * 3. 后半段：脱离横盘向上延伸
 */
function checkFlatBottom(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;
  const high = Math.max(...closes);
  const low = Math.min(...closes);

  // 找最低点位置
  let lowIdx = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] < closes[lowIdx]) lowIdx = i;
  }
  if (lowIdx < 3 || lowIdx > n - 5) return { met: false, detail: '低点位置不适合' };

  // 横盘区域：低点前后各看一段，检查是否水平
  const flatStart = Math.max(0, lowIdx - 5);
  const flatEnd = Math.min(n - 1, lowIdx + 5);
  const flatSlice = closes.slice(flatStart, flatEnd + 1);
  const flatHigh = Math.max(...flatSlice);
  const flatRange = (flatHigh - low) / low;

  // 横盘波动 < 2%
  if (flatRange > 0.02) return { met: false, detail: `横盘波动${(flatRange*100).toFixed(2)}%>2%` };

  // 前半段下跌：起点到低点的跌幅 > 2%
  const startPrice = closes[0];
  const dropPct = (low - startPrice) / startPrice;
  if (dropPct > -0.02) return { met: false, detail: `前段跌幅不足(${(dropPct*100).toFixed(1)}%)` };

  // 后半段向上突破：末尾价格 > 横盘高点
  const endPrice = closes[n - 1];
  if (endPrice <= flatHigh) return { met: false, detail: `未向上突破(末价${endPrice.toFixed(2)}≤横盘高${flatHigh.toFixed(2)})` };

  return { met: true, detail: `一字底(跌${(dropPct*100).toFixed(1)}%→横盘${(flatRange*100).toFixed(2)}%→突破)` };
}

/**
 * V 顶检测：急涨→单点极端高点→急跌，高斜率，左右对称
 * V底的镜像
 */
function checkVTop(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;

  // 找最高点
  let highestIdx = 0, highestVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > highestVal) { highestVal = closes[i]; highestIdx = i; }
  }

  if (highestIdx < 5 || highestIdx > n - 5) return { met: false, detail: '顶点在边缘' };

  // 前半段：起点到高点的涨幅
  const startPrice = closes[0];
  const risePct = (highestVal - startPrice) / startPrice;
  if (risePct < 0.02) return { met: false, detail: `前半段涨幅不足(${(risePct*100).toFixed(1)}%)` };

  // 后半段：高点到终点的跌幅
  const endPrice = closes[n - 1];
  const dropPct = (endPrice - highestVal) / highestVal;
  if (dropPct > -0.02) return { met: false, detail: `后半段跌幅不足(${(dropPct*100).toFixed(1)}%)` };

  // 斜率对称性
  const leftSlope = risePct / highestIdx;
  const rightSlope = Math.abs(dropPct) / (n - 1 - highestIdx);
  const ratio = Math.min(leftSlope, rightSlope) / Math.max(leftSlope, rightSlope);
  if (ratio < 0.3) return { met: false, detail: `V形不对称(左斜${(leftSlope*100).toFixed(3)}%/右斜${(rightSlope*100).toFixed(3)}%,比${(ratio*100).toFixed(0)}%)` };

  // 单点转折：顶点附近5根内没有二次接近高点的价格
  const neighborhood = 5;
  const threshold = highestVal * 0.995;
  let nearCount = 0;
  for (let i = Math.max(0, highestIdx - neighborhood); i <= Math.min(n - 1, highestIdx + neighborhood); i++) {
    if (closes[i] >= threshold) nearCount++;
  }
  if (nearCount > 3) return { met: false, detail: `顶点非单点转折(附近${nearCount}根接近顶价)` };

  return { met: true, detail: `V顶(涨${(risePct*100).toFixed(1)}%→跌${(dropPct*100).toFixed(1)}%,对称${(ratio*100).toFixed(0)}%)` };
}

/**
 * M 顶检测：双顶回测，颈线跌破
 * W底的镜像
 *
 * 1. 第一顶：价格上涨触及高点A，随后回调形成颈线位
 * 2. 第二顶：从颈线再次上涨，在高点A附近停止
 * 3. 最终跌破：从高点B下跌并跌破颈线位
 */
function checkMTop(closes) {
  if (!closes || closes.length < 30) return { met: false, detail: '数据不足' };

  const n = closes.length;

  // 找全局最高点（高点A）
  let aIdx = 0, aVal = closes[0];
  for (let i = 1; i < n; i++) {
    if (closes[i] > aVal) { aVal = closes[i]; aIdx = i; }
  }
  if (aIdx < 3 || aIdx > n - 10) return { met: false, detail: '高点A位置不适合' };

  // 高点A之后找颈线位（A到末段的最低点）
  let neckIdx = aIdx, neckVal = closes[aIdx];
  for (let i = aIdx + 1; i < n; i++) {
    if (closes[i] < neckVal) { neckVal = closes[i]; neckIdx = i; }
  }
  if (neckIdx === n - 1) return { met: false, detail: '颈线在末尾，未形成第二顶' };

  // 颈线之后找高点B
  let bIdx = neckIdx, bVal = closes[neckIdx];
  for (let i = neckIdx + 1; i < n; i++) {
    if (closes[i] > bVal) { bVal = closes[i]; bIdx = i; }
  }
  if (bIdx === n - 1) return { met: false, detail: '高点B在末尾，未跌破颈线' };

  // 高点A和高点B水平相近（差值 < 2%）
  const diffPct = Math.abs(bVal - aVal) / Math.min(aVal, bVal);
  if (diffPct > 0.02) return { met: false, detail: `双顶偏差${(diffPct*100).toFixed(1)}%>2%` };

  // 颈线回调幅度 > 2%
  const dropPct = (Math.max(aVal, bVal) - neckVal) / Math.max(aVal, bVal);
  if (dropPct < 0.02) return { met: false, detail: `颈线回调不足(${(dropPct*100).toFixed(1)}%)` };

  // 最终跌破：末尾价格跌破颈线
  const endPrice = closes[n - 1];
  if (endPrice > neckVal) return { met: false, detail: `未跌破颈线(末价${endPrice.toFixed(2)}>颈线${neckVal.toFixed(2)})` };

  return { met: true, detail: `M顶(高A=${aVal.toFixed(2)}@${aIdx},颈线=${neckVal.toFixed(2)}@${neckIdx},高B=${bVal.toFixed(2)}@${bIdx},跌破)` };
}

/**
 * 一字顶检测：高位横盘后向下破位
 * 一字底的镜像
 *
 * 1. 前半段：价格明显上涨趋势
 * 2. 顶部横盘：价格转为水平，高点齐平，波动极小
 * 3. 后半段：脱离横盘向下延伸
 */
function checkFlatTop(closes) {
  if (!closes || closes.length < 20) return { met: false, detail: '数据不足' };

  const n = closes.length;
  const high = Math.max(...closes);
  const low = Math.min(...closes);

  // 找最高点位置
  let highIdx = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[highIdx]) highIdx = i;
  }
  if (highIdx < 3 || highIdx > n - 5) return { met: false, detail: '高点位置不适合' };

  // 横盘区域：高点前后各看一段，检查是否水平
  const flatStart = Math.max(0, highIdx - 5);
  const flatEnd = Math.min(n - 1, highIdx + 5);
  const flatSlice = closes.slice(flatStart, flatEnd + 1);
  const flatLow = Math.min(...flatSlice);
  const flatRange = (high - flatLow) / flatLow;

  // 横盘波动 < 2%
  if (flatRange > 0.02) return { met: false, detail: `横盘波动${(flatRange*100).toFixed(2)}%>2%` };

  // 前半段上涨：起点到高点的涨幅 > 2%
  const startPrice = closes[0];
  const risePct = (high - startPrice) / startPrice;
  if (risePct < 0.02) return { met: false, detail: `前段涨幅不足(${(risePct*100).toFixed(1)}%)` };

  // 后半段向下破位：末尾价格 < 横盘低点
  const endPrice = closes[n - 1];
  if (endPrice >= flatLow) return { met: false, detail: `未向下破位(末价${endPrice.toFixed(2)}≥横盘低${flatLow.toFixed(2)})` };

  return { met: true, detail: `一字顶(涨${(risePct*100).toFixed(1)}%→横盘${(flatRange*100).toFixed(2)}%→破位)` };
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
 * 合成价格序列（波动率归一化等权平均 → 滚动累计）
 *
 * 算法同 3336 buildComposite：
 *   1. 各子产品算收益率 r[t] = (close[t] - close[t-1]) / |close[t-1]|
 *   2. 滚动窗口算波动率 vol = std(r, window)
 *   3. 归一化 r_norm = r / vol
 *   4. 等权平均 avg = sum(r_norm) / count
 *   5. 滚动累计 ci = ci * (1 + avg * scale)
 *
 * @param {number[][]} closeArrays - 各子产品的收盘价序列（已对齐时间戳）
 * @param {number} window - 波动率窗口（默认 20）
 * @param {number} scale - 缩放因子（默认 0.01）
 * @returns {number[]} 合成收盘价序列
 */
function buildSyntheticCloses(closeArrays, window = 20, scale = 0.01) {
  const n = closeArrays[0].length;
  const numSyms = closeArrays.length;

  // 1. 各产品收益率序列
  const rts = [];  // rts[s][t]
  for (let s = 0; s < numSyms; s++) {
    const r = [];
    for (let t = 0; t < n; t++) {
      if (t === 0 || closeArrays[s][t - 1] === 0) { r.push(0); continue; }
      r.push((closeArrays[s][t] - closeArrays[s][t - 1]) / Math.abs(closeArrays[s][t - 1]));
    }
    rts.push(r);
  }

  // 2. 滚动波动率
  const vols = [];  // vols[s][t]
  for (let s = 0; s < numSyms; s++) {
    const v = [];
    for (let t = 0; t < n; t++) {
      const sl = rts[s].slice(Math.max(0, t - window + 1), t + 1).filter(x => x !== null && x !== 0);
      if (sl.length < 3) { v.push(1); continue; }
      const m = sl.reduce((a, b) => a + b, 0) / sl.length;
      const std = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / sl.length) || 0.0001;
      v.push(std);
    }
    vols.push(v);
  }

  // 3. 归一化 + 等权平均 + 滚动累计
  let ci = 1000;
  const synthCloses = [];
  for (let t = 0; t < n; t++) {
    let tr = 0, cnt = 0;
    for (let s = 0; s < numSyms; s++) {
      const r = rts[s][t], vol = vols[s][t];
      if (r === 0 || vol === 0) continue;
      tr += r / vol;
      cnt++;
    }
    if (cnt > 0) {
      ci = ci * (1 + (tr / cnt) * scale);
      synthCloses.push(Math.round(ci * 100) / 100);
    }
  }
  return synthCloses;
}

/**
 * 获取产品的 K 线数据
 *
 * 普通产品 → 直接拉 4002/4003
 * 合成产品 → 拉取所有子产品K线 → 时间对齐 → 合成
 */
async function fetchProductKlines(product, fromTime, atTime) {
  const now = atTime ? Math.floor(new Date(atTime).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const from = fromTime || (now - 3 * 86400); // 默认3天，或从 trendStartTime 开始

  // ── 合成产品：拉子产品 → 对齐 → 合成 ──
  if (product.isSynthetic && product.subSymbols) {
    const allData = await Promise.all(product.subSymbols.map(sub =>
      httpGet(`${KLINE_4003}/history?symbol=${sub.kline}&resolution=${CONFIG.KLINE_RESOLUTION}&from=${from}&to=${now}`, 30000)
        .then(d => ({ kline: sub.kline, t: d?.t || [], c: d?.c || [] }))
        .catch(() => ({ kline: sub.kline, t: [], c: [] }))
    ));

    // 找共同时间戳
    let commonTs = null;
    for (const d of allData) {
      const ts = new Set(d.t);
      if (commonTs === null) commonTs = ts;
      else commonTs = new Set([...commonTs].filter(x => ts.has(x)));
    }
    if (!commonTs || commonTs.size === 0) {
      return { ok: false, detail: `${product.symbol} 子产品无共同时间戳` };
    }
    const sortedTs = [...commonTs].sort((a, b) => a - b);

    // 对齐各产品收盘价
    const closeArrays = allData.map(d => {
      const map = {};
      for (let i = 0; i < d.t.length; i++) map[d.t[i]] = d.c[i];
      return sortedTs.map(t => map[t] || 0);
    });

    // 过滤掉任一产品为0的时间点
    const validIdx = [];
    for (let i = 0; i < sortedTs.length; i++) {
      if (closeArrays.every(arr => arr[i] !== 0)) validIdx.push(i);
    }
    if (validIdx.length < 20) {
      return { ok: false, detail: `${product.symbol} 有效数据不足(${validIdx.length})` };
    }
    const validCloses = closeArrays.map(arr => validIdx.map(i => arr[i]));

    // 合成
    const synthCloses = buildSyntheticCloses(validCloses);
    return { ok: true, closes: synthCloses, times: validIdx.map(i => sortedTs[i]) };
  }

  // ── 普通产品 ──
  // 1G 指数组 → 4003
  if (product.group === 'index' && product.klineSymbol) {
    const data = await httpGet(`${KLINE_4003}/history?symbol=${product.klineSymbol}&resolution=${CONFIG.KLINE_RESOLUTION}&from=${from}&to=${now}`, 30000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }

  // 2G 商品组 → 4002
  if (product.group === 'commodity' && product.klineSymbol) {
    const data = await httpGet(`${KLINE_4002}/history?symbol=${product.klineSymbol}&resolution=${CONFIG.KLINE_RESOLUTION}&from=${from}&to=${now}`, 30000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }

  // 1G 股票组（单产品）→ 4003
  if (product.group === 'stock' && product.klineSymbol) {
    const data = await httpGet(`${KLINE_4003}/history?symbol=${product.klineSymbol}&resolution=${CONFIG.KLINE_RESOLUTION}&from=${from}&to=${now}`, 30000);
    if (data && data.s === 'ok' && data.c) return { ok: true, closes: data.c, times: data.t };
    return { ok: false, detail: `${product.klineSymbol} 无数据` };
  }
  if (product.group === 'stock' && !product.klineSymbol && !product.isSynthetic) {
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
 * 通过 tools/apis.js 的 fetchVolumeRate() 读取放量数据
 * 放量条件: current.rate > 1.2 或 存在活跃放量段(segments.status=active)
 *
 * 特殊规则：指数组（index）默认没有量数据，跳过 D 条件
 */
async function checkConditionD(product, atTime) {
  // 指数组不适用 D 条件
  if (product.group === 'index') {
    return { met: true, skip: true, detail: '指数组 — 跳过D条件' };
  }

  try {
    const volMap = await a.fetchVolumeRate(atTime);

    // 合成产品：任一子产品触发放量即算
    if (product.isSynthetic && product.subSymbols) {
      let bestRate = 0;
      let bestSym = null;
      let bestSeg = false;
      for (const sub of product.subSymbols) {
        if (!sub.vol) continue;
        const v = volMap[sub.vol];
        if (!v) continue;
        if (v.hasSegment && !bestSeg) {
          bestSeg = true;
          bestSym = sub.vol;
        }
        if (v.rate != null && v.rate > bestRate) {
          bestRate = v.rate;
          if (!bestSym) bestSym = sub.vol;
        }
      }
      if (bestRate > 1.2) {
        return { met: true, detail: `放量(${bestRate.toFixed(2)}x via ${bestSym})` };
      }
      if (bestSeg) {
        return { met: true, detail: `放量段(via ${bestSym})` };
      }
      return { met: false, detail: bestRate > 0 ? `量不足(${bestRate.toFixed(2)}x)` : '无放量数据' };
    }

    // 普通产品
    const volSym = product.volSymbol || product.symbol;
    const v = volMap[volSym];
    if (v) {
      if (v.rate != null && v.rate > 1.2) {
        return { met: true, detail: `放量(${v.rate.toFixed(2)}x)` };
      }
      if (v.hasSegment) {
        return { met: true, detail: '放量段(active)' };
      }
      return { met: false, detail: v.rate != null ? `量不足(${v.rate.toFixed(2)}x)` : '无放量数据' };
    }
    return { met: false, detail: '无放量数据' };
  } catch {
    return { met: false, detail: '读取放量API失败' };
  }
}

// ══════════════════════════════════════════
//  5. A 条件：group 折溢价检测
// ══════════════════════════════════════════

/**
 * category → 3336 premium API 端点名
 */
const PREMIUM_API_MAP = { FX:'fx', METAL:'mtl', ENERGY:'oil', CRYPTO:'crypto', AGRI:'agri' };

/**
 * 查询 8285 global_sector 的 SPREAD_TREND
 */
async function fetchGlobalSpreadTrend(atTime) {
  const now = atTime ? new Date(atTime).getTime() : Date.now();
  const s = encodeURIComponent(h.fmtHkt(now - 3600000));
  const e = encodeURIComponent(h.fmtHkt(now));
  const data = await httpGet(
    `http://192.168.25.127:8285/signal/data/list?symbol=global_sector&startTime=${s}&endTime=${e}`, 4000
  );
  if (data?.results?.length > 0) {
    const sorted = data.results.sort((a, b) => b.createTime - a.createTime);
    const latest = JSON.parse(sorted[0].ai_data.value);
    return latest.MARKETS_SECTOR?.GL?.SPREAD_TREND || null;
  }
  return null;
}

/**
 * 查询 3336 全部 5 个 premium API，返回按品类 key 索引的 { stateIdx, state, ... }
 */
async function fetchCommodityPremiums(atTime) {
  const cats = ['fx','mtl','oil','crypto','agri'];
  const result = {};
  for (const cat of cats) {
    const url = atTime
      ? `http://localhost:3336/api/${cat}-premium?at=${encodeURIComponent(atTime)}`
      : `http://localhost:3336/api/${cat}-premium`;
    const data = await httpGet(url, 3000);
    if (data?.available) {
      const key = cat === 'fx' ? 'FX' : cat === 'mtl' ? 'METAL' : cat === 'oil' ? 'ENERGY' : cat === 'crypto' ? 'CRYPTO' : 'AGRI';
      result[key] = data;
    }
  }
  return result;
}

/**
 * 获取活跃市场的 sector 折溢价数据
 * 返回 { marketCode: '扩大'|'稳定'|'缩小' }
 */
async function fetchSectorSpreads(activeCodes, atTime) {
  const spreadResults = await a.fetchSectorSpread(activeCodes, 2, atTime);
  const spreads = {};
  for (const entry of spreadResults) {
    Object.assign(spreads, entry.spreads);
  }
  return spreads;
}

/**
 * A 条件：group 折溢价检测
 *
 * 商品组 → 3336 premium API (stateIdx ∈ [1,3,4,5] → 折溢价大)
 * 股票组 → 所在市场的 SPREAD_TREND (扩大 → 折溢价大)
 * 指数组 → global_sector GL.SPREAD_TREND (扩大 → 折溢价大)
 */
async function checkConditionA(product, options = {}) {
  if (product.group === 'commodity') {
    const apiCat = PREMIUM_API_MAP[product.category];
    if (!apiCat) return { met: false, detail: `无对应 premium API: ${product.category}` };
    const premium = options.commodityPremiums?.[product.category];
    if (!premium) return { met: false, detail: `${apiCat}-premium 无数据` };
    const isLarge = [1, 3, 4, 5].includes(premium.stateIdx);
    return {
      met: isLarge,
      stateIdx: premium.stateIdx,
      state: premium.state,
      detail: isLarge ? `折溢价大(${premium.state})` : `折溢价不够大(${premium.state},idx=${premium.stateIdx})`
    };
  }

  if (product.group === 'stock') {
    const st = options.sectorSpreads?.[product.market];
    if (!st) return { met: false, detail: `${product.market} 无 sector SPREAD_TREND` };
    const isLarge = st === '扩大';
    return { met: isLarge, spreadTrend: st, detail: isLarge ? `折溢价扩大` : `折溢价${st}` };
  }

  if (product.group === 'index') {
    const st = options.globalSpreadTrend;
    if (!st) return { met: false, detail: 'global_sector 无数据' };
    const isLarge = st === '扩大';
    return { met: isLarge, spreadTrend: st, detail: isLarge ? `折溢价扩大` : `折溢价${st}` };
  }

  return { met: false, detail: '未知产品组' };
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
 * @param {object} product - 产品定义
 * @param {object} context - 上下文数据 (sectorSpreads, globalSpreadTrend, commodityPremiums)
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
async function checkProductTurnover(product, context = {}, fromTime, atTime) {
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
    klines: null,          // 保存K线数据供方向判断用
  };

  // B 条件：价格形态
  const klines = await fetchProductKlines(product, fromTime, atTime);
  result.klines = klines;
  if (klines.ok) {
    result.conditions.b = checkPricePattern(klines.closes);
  } else {
    result.conditions.b = { met: false, pattern: null, detail: klines.detail };
  }

  // A 条件：group 折溢价
  result.conditions.a = await checkConditionA(product, context);

  // C 条件：事件（待实现）
  result.conditions.c = await checkConditionC(product);

  // D 条件：放量（指数组跳过）
  result.conditions.d = await checkConditionD(product, atTime);

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
    result.isFake = true;
    result.detail = `🚨 假转 — 有持续支撑事件，A+B+D满足但事件不支持方向改变`;
  } else {
    result.isFake = false;
    result.detail = `🚨 真转 — A+B+D满足且无事件支撑，方向改变`;
  }

  return result;
}

// ══════════════════════════════════════════
//  8. 产品状态维护（内存状态）
// ══════════════════════════════════════════

const STATE_FILE = path.join(__dirname, 'slow-turn-state.json');

/**
 * 产品状态跟踪器
 *
 * 持久化到 slow-turn-state.json，每次运行加载上次状态。
 * 当 trendStartTime 变化（趋势切换）时，清空所有产品状态重新开始。
 *
 * 每个产品维护：
 *   - currentDirection: 目前方向 ('up'/'down')，始终有值
 *     · 有转折记录 → 取最新转折方向
 *     · 无转折记录 → 从 trendStartTime 到现在的 K线首尾比较
 *   - turnovers[]: 从趋势开始依次发生的转折记录
 */
function createProductTracker(atTime) {
  // 回测模式用独立状态文件
  const stateFile = atTime ? path.join(__dirname, 'slow-turn-state-backtest.json') : STATE_FILE;
  // 从 state-machine.json 读取趋势开始时间
  let trendStartTime = null;
  try {
    const sm = JSON.parse(fs.readFileSync(path.join(__dirname, 'state-machine.json'), 'utf-8'));
    trendStartTime = sm.trendStartTime || null;
    if (!trendStartTime && sm.transitions?.length > 0) {
      trendStartTime = sm.transitions[sm.transitions.length - 1].at || null;
    }
  } catch {}

  // 加载持久化状态
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {}

  // 趋势切换检测：trendStartTime 变了 → 清空重新开始
  if (saved && saved.trendStartTime === trendStartTime) {
    return { trendStartTime, products: saved.products || {}, _stateFile: stateFile };
  }

  // 新趋势或首次运行
  return { trendStartTime, products: {}, _stateFile: stateFile };
}

/**
 * 保存跟踪器状态到文件
 */
function saveProductTracker(tracker) {
  const stateFile = tracker._stateFile || STATE_FILE;
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      trendStartTime: tracker.trendStartTime,
      products: tracker.products,
    }, null, 2));
  } catch (e) {
    console.warn();
  }
}

function getOrCreateProductState(tracker, product) {
  if (!tracker.products[product.symbol]) {
    tracker.products[product.symbol] = {
      symbol: product.symbol,
      group: product.group,
      sector: product.sector,
      market: product.market || null,
      category: product.category || null,
      currentDirection: null,   // 将在主流程中通过K线方向初始化
      turnovers: [],
    };
  }
  return tracker.products[product.symbol];
}

function recordTurnover(state, direction, pattern, isFake, baselinePrice, atTime) {
  // 方向没变不重复推入
  if (state.currentDirection === direction) return;
  state.turnovers.push({
    time: atTime ? new Date(atTime).toISOString() : new Date().toISOString(),
    direction,
    pattern,
    isFake,
    baselinePrice: baselinePrice || null,  // 转折时价格基准
    rolledBack: false,                     // 是否被回滚
  });
  state.currentDirection = direction;  // 转折改变方向
}

/**
 * 从K线首尾比较得出价格方向（无转折时的方向判断）
 * close[end] > close[start] → 'up'
 * close[end] < close[start] → 'down'
 * 相等 → 'up'（默认）
 */
function priceDirectionFromKlines(closes) {
  if (!closes || closes.length < 2) return 'up';
  return closes[closes.length - 1] >= closes[0] ? 'up' : 'down';
}

/**
 * 线性回归斜率
 * 返回每根K线的价格变化率（归一化）
 * @param {number[]} closes
 * @returns {number} 斜率（正=上升，负=下降）
 */
function linearRegressionSlope(closes) {
  if (!closes || closes.length < 2) return 0;
  const n = closes.length;
  // 用对数价格算斜率，避免价格绝对值影响
  const logPrices = closes.map(c => Math.log(Math.max(c, 0.0001)));
  const xMean = (n - 1) / 2;
  const yMean = logPrices.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (logPrices[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * 右侧追踪验证：检测转折后是否持续反向偏离
 *
 * 转折后默认有效，只有持续反向偏离才回滚。
 * 用线性回归斜率检测 [转折时间, now] 窗口内的价格趋势。
 *
 * @param {object} state - 产品状态
 * @param {number[]} closes - 从转折时间到现在的K线收盘价
 * @returns {{ rolledBack: boolean, detail: string }}
 */
function checkRollback(state, closes, atTime) {
  // 取最后一条未被回滚的转折记录
  const lastTurn = (state.turnovers || []).filter(t => !t.rolledBack).pop();
  if (!lastTurn) return { rolledBack: false, detail: '无转折记录' };

  if (!closes || closes.length < CONFIG.ROLLBACK_MIN_KLINES) {
    return { rolledBack: false, detail: `K线不足${CONFIG.ROLLBACK_MIN_KLINES}根，跳过回滚检测` };
  }

  const slope = linearRegressionSlope(closes);
  const threshold = CONFIG.ROLLBACK_SLOPE_THRESHOLD;

  // 转多(up)：斜率 < -阈值 → 持续下降 → 回滚
  if (lastTurn.direction === 'up' && slope < -threshold) {
    // 回滚：标记该转折为已回滚
    lastTurn.rolledBack = true;
    lastTurn.rollbackAt = atTime ? new Date(atTime).toISOString() : new Date().toISOString();
    lastTurn.rollbackSlope = slope;
    // 方向回滚到前一个有效转折的方向
    const prevTurn = (state.turnovers || []).filter(t => !t.rolledBack).pop();
    state.currentDirection = prevTurn ? prevTurn.direction : null;
    return { rolledBack: true, detail: `⚠️ 回滚(转多后持续下降, 斜率${(slope*100).toFixed(4)}%)` };
  }

  // 转空(down)：斜率 > +阈值 → 持续上升 → 回滚
  if (lastTurn.direction === 'down' && slope > threshold) {
    lastTurn.rolledBack = true;
    lastTurn.rollbackAt = atTime ? new Date(atTime).toISOString() : new Date().toISOString();
    lastTurn.rollbackSlope = slope;
    const prevTurn = (state.turnovers || []).filter(t => !t.rolledBack).pop();
    state.currentDirection = prevTurn ? prevTurn.direction : null;
    return { rolledBack: true, detail: `⚠️ 回滚(转空后持续上升, 斜率${(slope*100).toFixed(4)}%)` };
  }

  return { rolledBack: false, detail: `追踪中(斜率${(slope*100).toFixed(4)}%, 阈值±${(threshold*100).toFixed(4)}%)` };
}

// ══════════════════════════════════════════
//  9. 板块聚合
// ══════════════════════════════════════════

/**
 * 对单个板块聚合 1G 和 2G 的转折方向
 *
 * 1G = 股票组 + 指数组（对等）
 * 2G = 商品组（按相关性调整方向后）
 *
 * 每个组的转折判定（两种条件，A 或 B）：
 *   A: 大部分产品有转折记录且最新转折同向 → 该组转折
 *   B: 部分产品有转折同向（未达大部分），但其余产品无转折记录且方向支持转折后的方向 → 该组转折
 *
 * 1G + 2G 都判定转折且同向 → 板块转折确认
 *
 * 信号定义：
 *   LT = 上涨中转折 = 5 板块全部转空
 *   ST = 下跌中转折 = 5 板块全部转多
 */
function aggregateSectorTurnover(tracker, sector, atTime) {
  const result = { sector, direction: null, confirmed: false, g1: null, g2: null, detail: '' };

  // 1G 范围：当前开盘市场的股票产品 + 指数产品（永远包含）
  // 2G 范围：全部商品产品（期货，近24h交易）
  const { markets: activeMarkets } = h.getActiveMarkets(atTime);

  // ── 收集产品状态 ──
  // 每个产品提供：direction（目前方向，始终有值）+ hasTurn（是否有转折记录）
  const g1Products = [];
  const g2Products = [];

  for (const state of Object.values(tracker.products)) {
    if (state.group === 'index') {
      // 指数永远包含
      if (state.sector !== sector) continue;
      g1Products.push({
        direction: state.currentDirection || null,
        hasTurn: (state.turnovers || []).filter(t => !t.rolledBack).length > 0,
      });
    } else if (state.group === 'stock') {
      // 股票只算当前在盘市场
      if (state.sector !== sector) continue;
      if (!activeMarkets.includes(state.market)) continue;
      g1Products.push({
        direction: state.currentDirection || null,
        hasTurn: (state.turnovers || []).filter(t => !t.rolledBack).length > 0,
      });
    } else if (state.group === 'commodity' && state.category) {
      // 2G: 商品按相关性映射到板块，不按 sector 过滤
      const relevance = COMMODITY_SECTOR_RELEVANCE[state.category]?.[sector] || 0;
      if (relevance === 0) continue;
      // 负相关取反
      const rawDir = state.currentDirection || null;
      const adjustedDir = rawDir
        ? (relevance === -1
            ? (rawDir === 'up' ? 'down' : 'up')
            : rawDir)
        : null;
      g2Products.push({
        direction: adjustedDir,
        hasTurn: (state.turnovers || []).filter(t => !t.rolledBack).length > 0,
      });
    }
  }

  // ── 1G / 2G 判定 ──
  result.g1 = judgeGroupTurnover(g1Products);
  result.g2 = judgeGroupTurnover(g2Products);

  // ── 1G + 2G 同向确认 ──
  if (result.g1 && result.g2 && result.g1 === result.g2) {
    result.direction = result.g1;
    result.confirmed = true;
    result.detail = `1G=${result.g1} 2G=${result.g2} 一致✔`;
  } else {
    result.detail = `1G=${result.g1 || '—'} 2G=${result.g2 || '—'} 未一致`;
  }

  return result;
}

/**
 * 判定一个组（1G 或 2G）的转折方向
 *
 * 每个产品提供：
 *   - direction: 目前方向（'up'/'down'/null），始终有值（null=数据异常）
 *   - hasTurn: 是否有转折记录
 *
 * 条件 A：大部分产品有转折记录（hasTurn=true）且最新转折方向同向
 * 条件 B：部分产品有转折记录且同向（未达大部分），
 *         其余无转折记录（hasTurn=false）的产品目前方向支持转折方向
 *
 * @param {Array<{direction: string|null, hasTurn: boolean}>} products
 * @returns {'up'|'down'|null}
 */
function judgeGroupTurnover(products) {
  if (products.length === 0) return null;

  const total = products.length;

  // 有转折记录的产品
  const turnedUp = products.filter(p => p.hasTurn && p.direction === 'up');
  const turnedDown = products.filter(p => p.hasTurn && p.direction === 'down');
  const turnedUpCount = turnedUp.length;
  const turnedDownCount = turnedDown.length;

  // 无转折记录的产品
  const noTurn = products.filter(p => !p.hasTurn);

  // 条件 A：大部分产品有转折记录且同向
  if (turnedUpCount / total > 0.5) return 'up';
  if (turnedDownCount / total > 0.5) return 'down';

  // 条件 B：部分有转折同向（未达大部分）+ 其余无转折的产品目前方向支持
  // up 方向：有 up 转折，其余无转折的产品方向也是 up（支持）
  if (turnedUpCount > 0 && turnedUpCount >= turnedDownCount) {
    const supporting = noTurn.filter(p => p.direction === 'up').length;
    const opposing = noTurn.filter(p => p.direction === 'down').length;
    // 其余全部支持（不反对）
    if (opposing === 0 && turnedUpCount + supporting === total) return 'up';
  }

  // down 方向
  if (turnedDownCount > 0 && turnedDownCount >= turnedUpCount) {
    const supporting = noTurn.filter(p => p.direction === 'down').length;
    const opposing = noTurn.filter(p => p.direction === 'up').length;
    if (opposing === 0 && turnedDownCount + supporting === total) return 'down';
  }

  return null;
}

// ══════════════════════════════════════════
//  Main
// ══════════════════════════════════════════

async function main(options = {}) {
  const atStr = options.at || null;
  const jsonMode = options.json || false;
  const backtestId = options.backtestId || null;
  const saveDb = options.saveDb || false;
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
  const stockProducts = getStockProducts(atStr);
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
  const tracker = createProductTracker(atStr);
  result.trendStartTime = tracker.trendStartTime;
  const allProducts = [...stockProducts, ...indexProducts, ...commodityProducts];

  // ── Step 3: 获取 A 条件上下文数据 ──
  const activeCodes = [...new Set(stockProducts.map(p => p.market))];
  log(`\n📡 获取 A 条件数据...`);
  log(`  股票组 sector 市场: ${activeCodes.join(', ')}`);

  const [sectorSpreads, globalSpreadTrend, commodityPremiums] = await Promise.all([
    fetchSectorSpreads(activeCodes, atStr),
    fetchGlobalSpreadTrend(atStr),
    fetchCommodityPremiums(atStr),
  ]);

  log(`  股票组 SPREAD_TREND: ${Object.entries(sectorSpreads).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  log(`  指数组 GL.SPREAD_TREND: ${globalSpreadTrend || 'N/A'}`);
  log(`  商品组 premium:`);
  for (const [cat, p] of Object.entries(commodityPremiums)) {
    log(`    ${cat}: idx=${p.stateIdx} ${p.state}`);
  }

  const contextData = { sectorSpreads, globalSpreadTrend, commodityPremiums };

  // ── Step 4: 逐产品检测 ──
  log(`\n🔍 逐产品检测...`);
  log(`  趋势开始时间: ${tracker.trendStartTime || '未知'}`);

  // ── Step 4: 逐产品检测 ──
  log(`\n🔍 逐产品检测...`);
  log(`  趋势开始时间: ${tracker.trendStartTime || '未知'}`);

  for (const product of allProducts) {
    const state = getOrCreateProductState(tracker, product);

    // 动态窗口：有转折记录时从最后一次转折时间拉K线，否则从 trendStartTime
    const lastTurn = (state.turnovers || []).filter(t => !t.rolledBack).pop();
    const windowStart = lastTurn
      ? Math.floor(new Date(lastTurn.time).getTime() / 1000)
      : (tracker.trendStartTime ? Math.floor(new Date(tracker.trendStartTime).getTime() / 1000) : null);

    const turnoverResult = await checkProductTurnover(product, contextData, windowStart, atStr);

    // 先检测回滚（用新窗口的K线）
    if (lastTurn && turnoverResult.klines && turnoverResult.klines.ok) {
      const rollback = checkRollback(state, turnoverResult.klines.closes, atStr);
      if (rollback.rolledBack) {
        log(`  ${rollback.detail} — ${product.symbol} 删除转折(${lastTurn.direction}), 方向回滚为 ${state.currentDirection || 'null'}`);
        // 回滚后重新获取方向（可能后续还会检测到新转折）
      } else if (!turnoverResult.hasTurnover) {
        log(`  📎 ${product.symbol}: ${rollback.detail}`);
      }
    }

    if (turnoverResult.hasTurnover) {
      // 有转折 → 记录并更新方向
      const baselinePrice = turnoverResult.klines?.closes
        ? turnoverResult.klines.closes[turnoverResult.klines.closes.length - 1]
        : null;
      recordTurnover(state, turnoverResult.direction, turnoverResult.conditions.b?.pattern, turnoverResult.isFake, baselinePrice, atStr);
      log(`  🚨 ${product.symbol}: ${turnoverResult.detail}`);
    } else {
      // 无转折 → 用K线首尾比较算当前方向（仅当没有转折记录时）
      // 有转折记录的产品保留上次转折方向，不被K线覆盖
      if ((state.turnovers || []).filter(t => !t.rolledBack).length === 0) {
        if (turnoverResult.klines && turnoverResult.klines.ok) {
          state.currentDirection = priceDirectionFromKlines(turnoverResult.klines.closes);
        } else {
          state.currentDirection = null;
        }
      }
      // 有转折记录但无新转折，且未被回滚 → 保留方向，不输出额外日志（回滚日志已输出）
      const hasActiveTurn = (state.turnovers || []).some(t => !t.rolledBack);
      if (!hasActiveTurn) {
        log(`  ➖ ${product.symbol}: ${turnoverResult.detail} → 方向=${state.currentDirection || '未知(数据异常)'}`);
      }
    }

    // 输出时去掉 K线原始数据
    const output = { ...turnoverResult };
    output.klineOk = !!(turnoverResult.klines && turnoverResult.klines.ok);
    delete output.klines;
    result.productResults.push(output);
  }

  // ── 保存状态 ──
  saveProductTracker(tracker);


  // ── Step 5: 按板块聚合 ──
  log(`\n📊 板块聚合:`);
  for (const sector of ALL_SECTORS) {
    const sr = aggregateSectorTurnover(tracker, sector, atStr);
    result.sectorResults.push(sr);
    log(`  ${sector}: ${sr.detail}`);
  }

  // ── Step 6: 最终信号判定 ──
  const confirmedDirs = result.sectorResults.filter(s => s.confirmed).map(s => s.direction);
  const upCount = confirmedDirs.filter(d => d === 'up').length;
  const downCount = confirmedDirs.filter(d => d === 'down').length;
  const totalConfirmed = confirmedDirs.length;

  if (totalConfirmed > 0) {
    // LT = 上涨中转折 = 5板块全部转空
    // ST = 下跌中转折 = 5板块全部转多
    if (downCount === 5) { result.signal = 'LT'; result.triggerDirection = 'down'; }
    else if (upCount === 5) { result.signal = 'ST'; result.triggerDirection = 'up'; }
  }

  // ── 摘要 ──
  // 符号：1️⃣=1G通过 2️⃣=2G通过 🔄=1G+2G都通过(确认) ➖=都不满足
  const sectorProgress = result.sectorResults.map(s => {
    let icon;
    if (s.confirmed) icon = '✅';
    else if (s.g1 && !s.g2) icon = '1️⃣';
    else if (!s.g1 && s.g2) icon = '2️⃣';
    else icon = '➖';
    const dir = s.direction || s.g1 || s.g2 || '待定';
    return `${icon}${s.sector}:${dir}`;
  }).join(' ');

  result.summary = result.signal !== 'NONE'
    ? `🚨 ${result.signal} 触发 — ${totalConfirmed}/5 板块确认 ${result.triggerDirection==='up'?'📈转多':'📉转空'} [${sectorProgress}]`
    : `⏸️ 无转折 — ${totalConfirmed}/5 板块确认 [${sectorProgress}]`;

  // ── 数据源摘要（简洁，反映数据拉取状态） ──
  const srcParts = [];
  // A 条件：折溢价数据源
  const spreadMarkets = Object.keys(contextData.sectorSpreads || {});
  if (spreadMarkets.length > 0) {
    const expandingMarkets = spreadMarkets.filter(m => contextData.sectorSpreads[m] === '扩大').length;
    srcParts.push(`A:sector(${spreadMarkets.length}市场,${expandingMarkets}扩大)`);
  } else {
    srcParts.push('⚠️ A:sector(无数据)');
  }
  if (contextData.globalSpreadTrend) {
    srcParts.push('GL:' + contextData.globalSpreadTrend);
  } else {
    srcParts.push('⚠️ GL:无数据');
  }
  const premiumCats = Object.entries(contextData.commodityPremiums || {});
  if (premiumCats.length > 0) {
    const bigCount = premiumCats.filter(([,v]) => v.stateIdx >= 0 && [1,3,4,5].includes(v.stateIdx)).length;
    srcParts.push(`Premium(${premiumCats.length}类,${bigCount}折溢价大)`);
  } else {
    srcParts.push('⚠️ Premium:无数据');
  }
  // B 条件：K线拉取状态
  const klineOkCount = result.productResults.filter(r => r.klineOk === true).length;
  const klineFailCount = result.productResults.length - klineOkCount;
  srcParts.push(`B:K线(${klineOkCount}OK` + (klineFailCount > 0 ? `,${klineFailCount}失败` : '') + ')');
  // D 条件：放量数据
  const dHits = result.productResults.filter(r => r.conditions.d?.met).length;
  srcParts.push('D:放量' + dHits + '品');
  srcParts.push('C:未实现');
  result.sources = srcParts.join(' | ');

  log(`\n══════════ 结果 ══════════`);
  log(result.summary);
  log(`数据源: ${result.sources}`);
  log(`═══════════════════════════`);

  // ── 板块详情日志 ──
  log(`\n📊 板块转折进度:`);
  for (const sr of result.sectorResults) {
    const icon = sr.confirmed ? '✅' : (sr.g1 || sr.g2) ? '⏳' : '➖';
    log(`  ${icon} ${sr.sector}: ${sr.detail}`);
  }

  // ── 产品检测明细（写入日志文件可查） ──
  const detailLog = path.join('/tmp/sentinel-v2-logs', 'slow-detail.log');
  const detailLines = [
    `\n===== ${new Date().toISOString()} =====`,
    `趋势开始: ${tracker.trendStartTime || '未知'}`,
    `信号: ${result.signal} | ${result.summary}`,
    '',
    '--- 产品检测明细 ---',
  ];
  for (const pr of result.productResults) {
    const b = pr.conditions.b;
    const a = pr.conditions.a;
    const d = pr.conditions.d;
    const c = pr.conditions.c;
    const parts = [];
    parts.push(`A=${a?.met ? '✅' : '✗'}`);
    parts.push(`B=${b?.met ? `✅(${b.pattern})` : '✗'}`);
    parts.push(`C=${c?.met ? '✅' : '✗'}`);
    parts.push(`D=${d?.skip ? '⏭️' : (d?.met ? '✅' : '✗')}`);
    detailLines.push(`  ${pr.symbol}: [${parts.join(' ')}] ${pr.detail}`);
  }
  detailLines.push('');
  detailLines.push('--- 板块聚合 ---');
  for (const sr of result.sectorResults) {
    detailLines.push(`  ${sr.sector}: ${sr.detail}`);
  }
  detailLines.push('');
  try { fs.appendFileSync(detailLog, detailLines.join('\n') + '\n'); } catch {}

  // ── 写入 DB（实时或回测） ──
  if (saveDb) {
    try {
      const Database = require(path.join(__dirname, 'node_modules', 'better-sqlite3'));
      const dbPath = path.join(__dirname, 'sentinel-v2.db');
      const db = new Database(dbPath);
      const crypto = require('crypto');
      const id = crypto.randomUUID();
      const ts = atStr || new Date().toISOString();
      db.prepare(`INSERT INTO sentinel_executions
        (id, sentinel_type, source, backtest_id, timestamp, triggered, summary, result_json, signal, sources)
        VALUES (?, 'slow', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        backtestId ? 'backtest' : 'cli',
        backtestId,
        ts,
        result.signal !== 'NONE' ? 1 : 0,
        result.summary || '',
        JSON.stringify(result),
        result.signal || 'NONE',
        result.sources || ''
      );
      db.close();
      log(`\n💾 DB 写入: id=${id.slice(0,8)}, timestamp=${ts}, backtest_id=${backtestId || 'null'}`);
    } catch (e) {
      log(`\n⚠️ DB 写入失败: ${e.message}`);
    }
  }

  return result;
}

// ── CLI ──
if (require.main === module) {
  const args = process.argv.slice(2);
  // 支持 --at VALUE 和 --at=VALUE 两种形式
  let atStr = null;
  const atEq = args.find(a => a.startsWith('--at='));
  if (atEq) {
    atStr = atEq.slice(5);
  } else {
    const atI = args.indexOf('--at');
    if (atI >= 0) atStr = args[atI + 1];
  }
  // --backtest-id=VALUE 或 --backtest-id VALUE
  let backtestId = null;
  const btEq = args.find(a => a.startsWith('--backtest-id='));
  if (btEq) {
    backtestId = btEq.slice(14);
  } else {
    const btI = args.indexOf('--backtest-id');
    if (btI >= 0) backtestId = args[btI + 1];
  }
  const saveDb = args.includes('--save-db');
  main({ at: atStr, json: args.includes('--json'), backtestId, saveDb }).then(r => {
    if (args.includes('--json')) console.log(JSON.stringify(r));
  }).catch(e => console.error(e.message));
}

module.exports = {
  main,
  getStockProducts, getIndexProducts, getCommodityProducts,
  checkVBottom, checkWBottom, checkFlatBottom, checkPricePattern,
  checkConditionD, buildSyntheticCloses,
  aggregateSectorTurnover, judgeGroupTurnover, priceDirectionFromKlines,
};
