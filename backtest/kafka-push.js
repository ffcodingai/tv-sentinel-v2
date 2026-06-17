#!/usr/bin/env node
/**
 * backtest/kafka-push.js
 * Push sentinel execution results to Kafka topic t_signal_info_data.
 *
 * Usage:
 *   NODE_PATH=~/tradingview-ui-backend-dev/node_modules \
 *   node backtest/kafka-push.js \
 *     --type=check --source=backtest --backtest-id=xxx \
 *     --triggered=false --summary="無商品放量" \
 *     --json='{"sentinel_type":"check","triggered":false,"key_signals":{}}'
 */

const { Kafka } = require('kafkajs');

const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC = 't_signal_info_data';

const kafka = new Kafka({
  clientId: 'sentinel-push',
  brokers: BROKERS,
  retry: { retries: 3 },
});

let _producer = null;

async function getProducer() {
  if (!_producer) {
    _producer = kafka.producer();
    await _producer.connect();
  }
  return _producer;
}

/**
 * Push a sentinel execution to Kafka.
 *
 * @param {object} opts
 * @param {string} opts.sentinelType - 'lt'|'st'|'trend'|'check'
 * @param {string} opts.source - 'live'|'cron'|'backtest'
 * @param {string|null} opts.backtestId
 * @param {number} opts.timestampMs - epoch ms
 * @param {boolean} opts.triggered
 * @param {string} opts.summary
 * @param {object} opts.keySignals - { volume_surge, global_consensus, spread, slope }
 */
async function pushExecution(opts) {
  const tsMs = opts.timestampMs || Date.now();
  const tsTo = tsMs;

  const jsonData = JSON.stringify({
    sentinel_type: opts.sentinelType,
    source: opts.source,
    backtest_id: opts.backtestId || null,
    timestamp: new Date(tsMs).toISOString(),
    triggered: !!opts.triggered,
    summary: opts.summary || '',
    key_signals: opts.keySignals || {},
  });

  const kafkaSymbol = `sentinel_${opts.sentinelType}`;
  const message = `${tsMs}|${tsTo}|sentinel_execution|${kafkaSymbol}|ai_data|${jsonData}|${tsMs}|1`;

  try {
    const producer = await getProducer();
    await producer.send({
      topic: TOPIC,
      messages: [{ value: message }],
    });
    return true;
  } catch (err) {
    console.error(`[KafkaPush] Error: ${err.message}`);
    return false;
  }
}

async function disconnect() {
  if (_producer) {
    try { await _producer.disconnect(); } catch {}
    _producer = null;
  }
}

// ── CLI mode ──
if (require.main === module) {
  const args = {};
  process.argv.slice(2).forEach(a => {
    const m = a.match(/^--([^=]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
    else if (a.startsWith('--') && !a.includes('=')) args[a.slice(2)] = true;
  });

  (async () => {
    const ok = await pushExecution({
      sentinelType: args['type'] || 'check',
      source: args['source'] || 'cli',
      backtestId: args['backtest-id'] || null,
      timestampMs: parseInt(args['ts']) || Date.now(),
      triggered: args['triggered'] === 'true',
      summary: args['summary'] || '',
      keySignals: args['json'] ? JSON.parse(args['json']) : {},
    });
    await disconnect();
    process.exit(ok ? 0 : 1);
  })();
}

module.exports = { pushExecution, disconnect };
