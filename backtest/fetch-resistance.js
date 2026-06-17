#!/usr/bin/env node
/**
 * backtest/fetch-resistance.js
 * Uses HTTP API to query stock resistance/support for all markets on a given date.
 *
 * Usage:
 *   node backtest/fetch-resistance.js --backtest-id=test001 --date=2026-06-14
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (match) args[match[1]] = match[2];
});

const BACKTEST_ID = args['backtest-id'];
const DATE_STR    = args['date'];

if (!BACKTEST_ID || !DATE_STR) {
  console.error('Usage: node fetch-resistance.js --backtest-id=ID --date=YYYY-MM-DD');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, BACKTEST_ID);

// ── Config ──────────────────────────────────────────────────────────────────
const API_BASE = 'http://192.168.25.190:3000';
const MARKETS   = ['china', 'hongkong', 'japan', 'korea', 'taiwan', 'uk', 'france', 'germany', 'america'];
const MARKET_REQ_MAP = {
  china:    'china',
  hongkong: 'hongkong',
  japan:    'japan',
  korea:    'korea',
  taiwan:   'taiwan',
  uk:       'uk',
  france:   'france',
  germany:  'germany',
  america:  'america',
};

// ── HTTP helpers ────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allStocks = {}; // market → stock list
  const totals = [];

  // Step 1: For each market, get the current top stock list (live, no date parameter)
  for (const market of MARKETS) {
    const url = `${API_BASE}/api/stock-resistance?market=${market}`;
    console.log(`Fetching top stocks for market=${market}...`);
    try {
      const resp = await httpGet(url);
      if (resp.status === 'ok' && Array.isArray(resp.data?.stocks)) {
        allStocks[market] = resp.data.stocks;
        totals.push({ market, count: resp.data.stocks.length });
        console.log(`  Got ${resp.data.stocks.length} stocks for ${market}`);
      } else {
        console.warn(`  Unexpected response format for ${market}: status=${resp.status}`);
        allStocks[market] = [];
      }
    } catch (err) {
      console.warn(`  Failed to fetch ${market}: ${err.message}`);
      allStocks[market] = [];
    }
    await sleep(200); // be kind to the API
  }

  // Step 2: For each stock, lookup community SR on the specified date
  const enriched = {};

  for (const market of MARKETS) {
    const stocks = allStocks[market] || [];
    enriched[market] = [];

    for (const stock of stocks) {
      const symbol = stock.symbol || stock.name || stock.code;
      if (!symbol) continue;

      const lookupUrl = `${API_BASE}/api/community-sr/lookup?symbol=${encodeURIComponent(symbol)}&date=${DATE_STR}`;
      try {
        const srResp = await httpGet(lookupUrl);
        const levels = srResp.levels || srResp.data?.levels || srResp.data || [];

        // Calculate nearest R and S
        const currentPrice = stock.price || stock.lastPrice || stock.last || 0;
        let nearestResistance = null;
        let nearestSupport = null;

        if (Array.isArray(levels)) {
          for (const level of levels) {
            const price = typeof level === 'number' ? level : (level.price || level.value || 0);
            if (price > currentPrice) {
              if (nearestResistance === null || price < nearestResistance) nearestResistance = price;
            } else if (price < currentPrice) {
              if (nearestSupport === null || price > nearestSupport) nearestSupport = price;
            }
          }
        }

        const enrichedStock = {
          ...stock,
          communitySR: {
            levels: Array.isArray(levels) ? levels : [],
            nearestResistance,
            nearestSupport,
            pctToResistance: nearestResistance ? ((nearestResistance - currentPrice) / currentPrice * 100).toFixed(2) : null,
            pctToSupport: nearestSupport ? ((currentPrice - nearestSupport) / currentPrice * 100).toFixed(2) : null,
          },
        };

        enriched[market].push(enrichedStock);
      } catch (err) {
        // Add without SR data
        enriched[market].push({
          ...stock,
          communitySR: {
            levels: [],
            nearestResistance: null,
            nearestSupport: null,
            pctToResistance: null,
            pctToSupport: null,
          },
          srError: err.message,
        });
      }

      await sleep(100); // rate limit
    }

    console.log(`  Enriched ${enriched[market].length}/${stocks.length} stocks for ${market}`);
  }

  // Step 3: Write output file
  const output = {
    status: 'ok',
    data: {
      date: DATE_STR,
      markets: {},
    },
  };

  for (const market of MARKETS) {
    output.data.markets[market] = {
      market,
      stocks: enriched[market],
    };
  }
  output.data.totals = totals;

  const outFile = path.join(OUT_DIR, `resistance-${DATE_STR}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nWrote ${outFile}`);
  console.log(`Total enriched stocks: ${totals.reduce((s, t) => s + t.count, 0)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
