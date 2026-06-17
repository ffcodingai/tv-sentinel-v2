#!/usr/bin/env node
/**
 * backtest/fetch-rotation.js
 * Kafka → rotation-ui JSON files (per timestamp) + DB registration.
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \\
 *   node backtest/fetch-rotation.js --backtest-id=<id> --from=ISO --to=ISO
 */

const { Kafka } = require('kafkajs');
const fs = require('fs');
const path = require('path');
const { initDatabase } = require('../database');
const { regSnapshot } = require('./db-util');

initDatabase();

const args = {};
process.argv.slice(2).forEach(a => { const m = a.match(/^--([^=]+)=(.+)$/); if (m) args[m[1]] = m[2]; });
const BACKTEST_ID = args['backtest-id'];
const FROM_ISO = args['from'];
const TO_ISO = args['to'];
if (!BACKTEST_ID || !FROM_ISO || !TO_ISO) {
  console.error('Usage: node fetch-rotation.js --backtest-id=ID --from=ISO --to=ISO'); process.exit(1);
}

const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC = 't_signal_info_data';

const kafka = new Kafka({ clientId: `bt-rotation-${BACKTEST_ID}`, brokers: BROKERS, retry: { retries: 3 } });

const COUNTRY_LABELS = {
  US:'美國大盤', US_SM:'美國小盤', UK:'英國', FR:'法國', DE:'德國',
  JP:'日本', KR:'韓國', TW:'台灣', CN:'A股', HK:'香港',
};

async function main() {
  const snapDir = path.join(__dirname, BACKTEST_ID, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const consumer = kafka.consumer({ groupId: `bt-rotation-${BACKTEST_ID}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const buffer = new Map(); // tsFm → msgs[]

  await consumer.run({
    eachMessage: async ({ message }) => {
      const v = message.value ? message.value.toString() : '';
      if (!v) return;
      const p = v.split('|');
      if (p.length < 7) return;
      const tsFm = p[0], tsTo = p[1], type = p[2], sym = p[3], sigKey = p[4];
      const jData = p.slice(5, -2).join('|');
      const tsMs = parseInt(tsFm, 10);
      if (isNaN(tsMs)) return;
      const fromDt = new Date(tsMs);
      if (fromDt < new Date(FROM_ISO) || fromDt > new Date(TO_ISO)) return;
      if (type !== 'market_sector') return;
      if (!['asia_sector','china_sector','europe_sector','us_sector'].includes(sym)) return;

      if (!buffer.has(tsFm)) buffer.set(tsFm, []);
      buffer.get(tsFm).push({ tsFm, tsMs, sym, jData });
    },
  });

  await new Promise(r => setTimeout(r, 3000));
  await consumer.disconnect();

  console.log(`Consumed ${buffer.size} unique timestamps.`);

  const sorted = [...buffer.keys()].sort((a, b) => parseInt(a) - parseInt(b));
  let written = 0;

  for (const tsFm of sorted) {
    const msgs = buffer.get(tsFm);
    const countries = {};
    for (const msg of msgs) {
      let parsed;
      try { parsed = JSON.parse(msg.jData); } catch { continue; }
      const ms = parsed.MARKETS_SECTOR || {};
      for (const [abbr, data] of Object.entries(ms)) {
        countries[abbr] = {
          label: COUNTRY_LABELS[abbr] || abbr,
          status: 'open',
          sector: {
            UP: data.UP || [],
            DOWN: data.DOWN || [],
            MULTI: data.MULTI || [],
            NEUTRAL: data.NEUTRAL || [],
          },
          VOL_TREND: data.VOL_TREND || {},
        };
      }
    }
    if (Object.keys(countries).length === 0) continue;

    const dt = new Date(parseInt(tsFm, 10));
    const tsLabel = dt.toISOString().replace('T', ' ').substring(0, 19);
    const fileName = `sector-rotation-ui-${tsLabel}.json`;
    const outFile = path.join(snapDir, fileName);

    fs.writeFileSync(outFile, JSON.stringify({ generatedAt: tsLabel, countries }, null, 2));
    regSnapshot(BACKTEST_ID, 'rotation', tsLabel, fileName);
    written++;
    console.log(`  [${tsLabel}] ${Object.keys(countries).length} countries → ${fileName}`);
  }

  console.log(`\nDone: ${written} rotation snapshots written to ${snapDir}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
