#!/usr/bin/env node
/**
 * backtest/fetch-volume.js
 * Reads Kafka topic t_signal_info_data for vol_agg type messages
 * and writes volume-surge segment files per timestamp.
 *
 * Usage:
 *   node backtest/fetch-volume.js --backtest-id=test001 --from=2026-06-01T00:00:00 --to=2026-06-17T00:00:00
 */

const { Kafka } = require('kafkajs');
const fs = require('fs');
const path = require('path');

// ── CLI args ────────────────────────────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach(arg => {
  const match = arg.match(/^--([^=]+)=(.+)$/);
  if (match) args[match[1]] = match[2];
});

const BACKTEST_ID = args['backtest-id'];
const FROM_ISO = args['from'];
const TO_ISO   = args['to'];

if (!BACKTEST_ID || !FROM_ISO || !TO_ISO) {
  console.error('Usage: node fetch-volume.js --backtest-id=ID --from=ISO --to=ISO');
  process.exit(1);
}

const FROM_MS = new Date(FROM_ISO).getTime();
const TO_MS   = new Date(TO_ISO).getTime();
const OUT_DIR = path.join(__dirname, BACKTEST_ID);

// ── Kafka setup ─────────────────────────────────────────────────────────────
const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC   = 't_signal_info_data';

const kafka = new Kafka({
  clientId: `backtest-volume-${BACKTEST_ID}`,
  brokers: BROKERS,
  retry: { retries: 3 },
});

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const consumer = kafka.consumer({ groupId: `backtest-volume-${BACKTEST_ID}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  // Buffer messages keyed by tsFm
  const buffer = new Map(); // tsFm → segments array

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value ? message.value.toString() : '';
      if (!value) return;

      const parts = value.split('|');
      if (parts.length < 7) return;

      const tsFm   = parts[0];
      const tsTo   = parts[1];
      const type   = parts[2];
      const sym    = parts[3];
      const sigKey = parts[4];
      const jData  = parts.slice(5, -2).join('|');
      const timeSync = parts[parts.length - 2];
      const interval = parts[parts.length - 1];

      if (type !== 'vol_agg') return;
      if (sym !== 'vol_rate_agg') return;

      const tsMs = parseInt(tsFm, 10);
      if (isNaN(tsMs)) return;
      if (tsMs < FROM_MS || tsMs > TO_MS) return;

      let parsed;
      try {
        parsed = JSON.parse(jData);
      } catch {
        return;
      }

      if (!Array.isArray(parsed)) return;

      if (!buffer.has(tsFm)) buffer.set(tsFm, { tsFm, segments: [], timeSync, interval, tsMs });
      buffer.get(tsFm).segments.push(...parsed);
    },
  });

  // Drain
  await new Promise(r => setTimeout(r, 5000));
  await consumer.disconnect();

  console.log(`Consumed ${buffer.size} unique timestamps with vol_agg data.`);

  // ── Write per-timestamp files ─────────────────────────────────────────────
  const sortedTs = [...buffer.keys()].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  for (const tsFm of sortedTs) {
    const entry = buffer.get(tsFm);
    if (!entry.segments.length) continue;

    const dt = new Date(parseInt(tsFm, 10));
    const tsLabel = formatTs(dt);

    const outFile = path.join(OUT_DIR, `volume-surge-${tsLabel}.json`);
    const output = {
      generatedAt: tsLabel,
      segments: entry.segments,
    };

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  Wrote ${outFile} (${entry.segments.length} segments)`);
  }
}

function formatTs(d) {
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
