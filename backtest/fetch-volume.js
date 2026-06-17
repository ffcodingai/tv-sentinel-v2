#!/usr/bin/env node
/**
 * backtest/fetch-volume.js
 * Kafka vol_agg → volume-surge JSON files + DB registration.
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \\
 *   node backtest/fetch-volume.js --backtest-id=<id> --from=ISO --to=ISO
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
  console.error('Usage: node fetch-volume.js --backtest-id=ID --from=ISO --to=ISO'); process.exit(1);
}

const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC = 't_signal_info_data';

const kafka = new Kafka({ clientId: `bt-volume-${BACKTEST_ID}`, brokers: BROKERS, retry: { retries: 3 } });

async function main() {
  const snapDir = path.join(__dirname, BACKTEST_ID, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const consumer = kafka.consumer({ groupId: `bt-volume-${BACKTEST_ID}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const buffer = new Map(); // tsFm → { segments, data }

  await consumer.run({
    eachMessage: async ({ message }) => {
      const v = message.value ? message.value.toString() : '';
      if (!v) return;
      const p = v.split('|');
      if (p.length < 7) return;
      const tsFm = p[0], tsTo = p[1], type = p[2], sym = p[3];
      const jData = p.slice(5, -2).join('|');
      const tsMs = parseInt(tsFm, 10);
      if (isNaN(tsMs)) return;
      const dt = new Date(tsMs);
      if (dt < new Date(FROM_ISO) || dt > new Date(TO_ISO)) return;
      if (type !== 'vol_agg' || sym !== 'vol_rate_agg') return;

      let parsed;
      try { parsed = JSON.parse(jData); } catch { return; }
      buffer.set(tsFm, { tsFm, tsMs, data: parsed });
    },
  });

  await new Promise(r => setTimeout(r, 3000));
  await consumer.disconnect();

  console.log(`Consumed ${buffer.size} volume snapshots.`);

  const sorted = [...buffer.keys()].sort((a, b) => parseInt(a) - parseInt(b));
  let written = 0;

  for (const tsFm of sorted) {
    const entry = buffer.get(tsFm);
    const dt = new Date(entry.tsMs);
    const tsLabel = dt.toISOString().replace('T', ' ').substring(0, 19);
    const fileName = `volume-surge-${tsLabel}.json`;
    const outFile = path.join(snapDir, fileName);

    const output = {
      generatedAt: tsLabel,
      segments: entry.data.segments || [],
      timestamp: tsLabel,
    };

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    regSnapshot(BACKTEST_ID, 'volume_surge', tsLabel, fileName);
    written++;
    console.log(`  [${tsLabel}] ${output.segments.length} segments → ${fileName}`);
  }

  console.log(`\nDone: ${written} volume snapshots written to ${snapDir}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
