#!/usr/bin/env node
/**
 * backtest/fetch-rotation.js
 * Reads Kafka topic t_signal_info_data for market_sector type messages
 * and writes sector rotation UI files per timestamp.
 *
 * Usage:
 *   node backtest/fetch-rotation.js --backtest-id=test001 --from=2026-06-01T00:00:00 --to=2026-06-17T00:00:00
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
  console.error('Usage: node fetch-rotation.js --backtest-id=ID --from=ISO --to=ISO');
  process.exit(1);
}

const FROM_MS    = new Date(FROM_ISO).getTime();
const TO_MS      = new Date(TO_ISO).getTime();
const OUT_DIR    = path.join(__dirname, BACKTEST_ID);

// ── Kafka setup ─────────────────────────────────────────────────────────────
const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC   = 't_signal_info_data';

const kafka = new Kafka({
  clientId: `backtest-rotation-${BACKTEST_ID}`,
  brokers: BROKERS,
  retry: { retries: 3 },
});

// ── Country mapping ─────────────────────────────────────────────────────────
const COUNTRY_LABELS = {
  US:    '美國大盤',
  US_SM: '美國小盤',
  UK:    '英國',
  FR:    '法國',
  DE:    '德國',
  JP:    '日本',
  KR:    '韓國',
  TW:    '台灣',
  CN:    'A股',
  HK:    '香港',
};

// Assemble a rotation-ui entry from buffered sector messages at one ts
function buildRotationEntry(sectorMessages) {
  const countries = {};

  for (const msg of sectorMessages) {
    let jsonData;
    try {
      jsonData = JSON.parse(msg.jsonData);
    } catch {
      continue;
    }

    const marketsSector = jsonData.MARKETS_SECTOR;
    if (!marketsSector) continue;

    for (const [countryKey, sectorData] of Object.entries(marketsSector)) {
      const label = COUNTRY_LABELS[countryKey] || countryKey;
      countries[countryKey] = {
        label,
        status: 'open',
        sector: {
          UP:      (sectorData.UP      || []).map(s => String(s)),
          DOWN:    (sectorData.DOWN    || []).map(s => String(s)),
          MULTI:   (sectorData.MULTI   || []).map(s => String(s)),
          NEUTRAL: (sectorData.NEUTRAL || []).map(s => String(s)),
        },
        VOL_TREND: sectorData.VOL_TREND || {},
      };
    }
  }

  return { countries };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const consumer = kafka.consumer({ groupId: `backtest-rotation-${BACKTEST_ID}-${Date.now()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

  // Buffer all relevant messages keyed by tsFm
  const buffer = new Map(); // tsFm → [messages]

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
      const jData  = parts.slice(5, -2).join('|'); // jsonData may contain pipes
      const timeSync = parts[parts.length - 2];
      const interval = parts[parts.length - 1];

      if (type !== 'market_sector') return;
      if (!['asia_sector', 'china_sector', 'europe_sector', 'us_sector'].includes(sym)) return;

      const tsMs = parseInt(tsFm, 10);
      if (isNaN(tsMs)) return;
      if (tsMs < FROM_MS || tsMs > TO_MS) return;

      if (!buffer.has(tsFm)) buffer.set(tsFm, []);
      buffer.get(tsFm).push({
        tsFm, tsTo, type, symbol: sym, signalKey: sigKey, jsonData: jData, timeSync, interval, tsMs,
      });
    },
  });

  // Give consumer a moment to drain queue, then disconnect
  await new Promise(r => setTimeout(r, 5000));
  await consumer.disconnect();

  console.log(`Consumed ${buffer.size} unique timestamps with market_sector data.`);

  // ── Write per-timestamp files ─────────────────────────────────────────────
  const timestamps = [];
  const sortedTs = [...buffer.keys()].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  for (const tsFm of sortedTs) {
    const msgs = buffer.get(tsFm);
    const entry = buildRotationEntry(msgs);

    // Only write if we have at least some countries
    if (Object.keys(entry.countries).length === 0) continue;

    const dt = new Date(parseInt(tsFm, 10));
    const tsLabel = formatTs(dt);
    timestamps.push({ tsFm, tsLabel, iso: dt.toISOString() });

    const outFile = path.join(OUT_DIR, `sector-rotation-ui-${tsLabel}.json`);
    const output = {
      generatedAt: tsLabel,
      ...entry,
    };

    fs.writeFileSync(outFile, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`  Wrote ${outFile}`);
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  const manifestFile = path.join(OUT_DIR, 'rotation-manifest.json');
  const manifest = {
    backtestId: BACKTEST_ID,
    from: FROM_ISO,
    to: TO_ISO,
    generatedCount: timestamps.length,
    timestamps,
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Wrote manifest: ${manifestFile} (${timestamps.length} entries)`);
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
