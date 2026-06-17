#!/usr/bin/env node
/**
 * backtest/export-csv.js
 * Export sentinel executions to CSV.
 *
 * Usage:
 *   node backtest/export-csv.js \
 *     --from=2026-06-17 --to=2026-06-17 \
 *     --type=check --source=backtest \
 *     --out=/tmp/sentinel-report.csv
 */

const fs = require('fs');
const path = require('path');
const { initDatabase, exportExecutionsCSV } = require('../database');

initDatabase();

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });

const FROM = args['from'] || '';
const TO   = args['to'] || '';
const TYPE = args['type'] || '';
const SOURCE = args['source'] || '';
const OUT  = args['out'] || '';

const csv = exportExecutionsCSV({
  from: FROM ? `${FROM}T00:00:00` : null,
  to: TO ? `${TO}T23:59:59` : null,
  sentinel_type: TYPE || null,
  source: SOURCE || null,
});

if (OUT) {
  fs.writeFileSync(OUT, csv, 'utf-8');
  console.log(`Written ${OUT} (${csv.split('\n').length - 1} rows)`);
} else {
  console.log(csv);
}
