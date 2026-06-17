#!/usr/bin/env node
/**
 * backtest/fetch-index.js
 * Kafka global_spread_agg → composite-index JSON files + DB registration.
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \\
 *   node backtest/fetch-index.js --backtest-id=<id> --from=ISO --to=ISO
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
  console.error('Usage: node fetch-index.js --backtest-id=ID --from=ISO --to=ISO'); process.exit(1);
}

const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC = 't_signal_info_data';

const kafka = new Kafka({ clientId: `bt-index-${BACKTEST_ID}`, brokers: BROKERS, retry: { retries: 3 } });

async function main() {
  const snapDir = path.join(__dirname, BACKTEST_ID, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const consumer = kafka.consumer({ groupId: `bt-index-${BACKTEST_ID}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  const buffer = new Map(); // tsFm → { compositeIndex, spreadRecords, segments, composite, indexData }

  await consumer.run({
    eachMessage: async ({ message }) => {
      const v = message.value ? message.value.toString() : '';
      if (!v) return;
      const p = v.split('|');
      if (p.length < 7) return;
      const tsFm = p[0], type = p[2], sym = p[3];
      const jData = p.slice(5, -2).join('|');
      const tsMs = parseInt(tsFm, 10);
      if (isNaN(tsMs)) return;
      const dt = new Date(tsMs);
      if (dt < new Date(FROM_ISO) || dt > new Date(TO_ISO)) return;
      if (type !== 'global_spread' || sym !== 'global_spread_agg') return;

      let parsed;
      try { parsed = JSON.parse(jData); } catch { return; }

      // Kafka global_spread_agg has: composite{value,time}, segment{direction,startTime,endTime},
      // rocSpread{value,strongest,weakest}, stats{...}
      // Accumulate composite points over time to build the index array
      const compPt = parsed.composite;
      if (compPt && compPt.value != null) {
        if (!buffer.has(tsFm)) buffer.set(tsFm, { tsFm, tsMs, points: [], segments: [], spreadRecords: [] });
        const entry = buffer.get(tsFm);
        entry.points.push({ value: compPt.value, time: compPt.time || tsMs });
        if (parsed.segment && parsed.segment.direction) {
          entry.segments.push({
            type: parsed.segment.direction,
            startTime: parsed.segment.startTime,
            endTime: parsed.segment.endTime || tsMs,
          });
        }
        if (parsed.rocSpread) {
          entry.spreadRecords.push({
            time: tsMs,
            value: parsed.rocSpread.value,
            status: parsed.rocSpread.status,
            strongest: parsed.rocSpread.strongest,
            weakest: parsed.rocSpread.weakest,
          });
        }
      }
    },
  });

  await new Promise(r => setTimeout(r, 3000));
  await consumer.disconnect();

  console.log(`Consumed ${buffer.size} index snapshots.`);

  const sorted = [...buffer.keys()].sort((a, b) => parseInt(a) - parseInt(b));
  let written = 0;

  for (const tsFm of sorted) {
    const entry = buffer.get(tsFm);
    const dt = new Date(entry.tsMs);
    const tsLabel = dt.toISOString().replace('T', ' ').substring(0, 19);
    const fileName = `composite-index-${tsLabel}.json`;
    const outFile = path.join(snapDir, fileName);

    // Sort points by time and build arrays
    const sortedPoints = entry.points.sort((a, b) => a.time - b.time);
    const output = {
      generatedAt: tsLabel,
      composite: sortedPoints,
      indexData: sortedPoints,
      compositeIndex: sortedPoints.map(p => p.value),
      spreadRecords: entry.spreadRecords,
      segments: entry.segments,
      turnpoints: null,  // Not available in Kafka global_spread_agg
    };

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    regSnapshot(BACKTEST_ID, 'composite_index', tsLabel, fileName);
    written++;
  }

  console.log(`\nDone: ${written} index snapshots written to ${snapDir}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
