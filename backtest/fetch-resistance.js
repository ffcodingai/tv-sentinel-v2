#!/usr/bin/env node
/**
 * backtest/fetch-resistance.js
 * HTTP API → historical resistance/support data + DB registration.
 *
 * Usage:
 *   node backtest/fetch-resistance.js --backtest-id=<id> --date=2026-06-14
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { initDatabase } = require('../database');
const { regSnapshot } = require('./db-util');

initDatabase();

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });
const BACKTEST_ID = args['backtest-id'];
const DATE_STR = args['date'];
if (!BACKTEST_ID || !DATE_STR) {
  console.error('Usage: node fetch-resistance.js --backtest-id=ID --date=YYYY-MM-DD'); process.exit(1);
}

const API_BASE = 'http://192.168.25.190:3000';
const MARKETS = ['china','hongkong','japan','korea','taiwan','uk','france','germany','america'];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    }).on('error', reject);
  });
}

async function main() {
  const snapDir = path.join(__dirname, BACKTEST_ID, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const result = { status: 'ok', date: DATE_STR, updatedAt: new Date().toISOString(), data: { markets: {} } };

  for (const market of MARKETS) {
    console.log(`\n[${market}] Fetching top stocks...`);
    // Get current top stock list (no date param needed for symbols)
    const liveData = await httpGet(`${API_BASE}/api/stock-resistance?market=${market}`);
    const stocks = liveData?.data?.stocks || [];
    if (stocks.length === 0) { console.log(`  No stocks for ${market}`); continue; }

    const marketResult = { stocks: [] };
    let done = 0;

    for (const s of stocks) {
      const symbol = s.tvSymbol || s.yahooSymbol;
      if (!symbol) continue;

      // Query historical S/R for this specific date
      const srData = await httpGet(`${API_BASE}/api/community-sr/lookup?symbol=${symbol}&date=${DATE_STR}`);
      const info = srData?.data?.[symbol];
      if (!info) continue;

      // Calculate pctToResistance and pctToSupport from nearest levels
      const price = info.currentPrice;
      const resistances = info.resistances || [];
      const supports = info.supports || [];
      const pctToRes = resistances.length > 0
        ? ((resistances[0].price - price) / price * 100)
        : 999;
      const pctToSup = supports.length > 0
        ? ((price - supports[supports.length - 1].price) / price * 100)
        : 999;

      marketResult.stocks.push({
        tvSymbol: symbol,
        yahooSymbol: s.yahooSymbol || '',
        name: s.name || '',
        currentPrice: price,
        pctToResistance: parseFloat(pctToRes.toFixed(2)),
        pctToSupport: parseFloat(pctToSup.toFixed(2)),
        resistance: resistances[0]?.price || null,
        support: supports[supports.length - 1]?.price || null,
        status: pctToRes < 5 ? 'close' : '',
      });
      done++;
      if (done % 5 === 0) process.stdout.write(`  ${done}/${stocks.length}...\r`);
    }
    result.data.markets[market] = marketResult;
    console.log(`  ${done} stocks done for ${market}`);
  }

  const fileName = `resistance-${DATE_STR}.json`;
  const outFile = path.join(snapDir, fileName);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  regSnapshot(BACKTEST_ID, 'resistance', DATE_STR, fileName);
  console.log(`\nDone: wrote ${fileName} with ${Object.keys(result.data.markets).length} markets`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
