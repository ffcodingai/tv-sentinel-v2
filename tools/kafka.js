// ── Kafka 推送工具（v2）──
// 合併 4 個 executor 的結果，一條推一次

const { Kafka } = require('kafkajs');

const BROKERS = ['192.168.25.148:9092', '192.168.25.148:9093', '192.168.25.148:9094'];
const TOPIC = 't_signal_info_data';

const kafka = new Kafka({
  clientId: 'sentinel-push',
  brokers: BROKERS,
});

/**
 * 推送合併信號到 Kafka
 * @param {object} merged - { ts, dateKey, activeMarkets, trend, turn, lt, st, state }
 */
async function pushSignal(merged) {
  try {
    const producer = kafka.producer();
    await producer.connect();

    const jsonData = JSON.stringify({
      ts: merged.ts,
      dateKey: merged.dateKey,
      activeMarkets: merged.activeMarkets,
      trend: merged.trend,
      turn: merged.turn,
      slow: merged.slow,
      rotation: merged.rotation,
      state: merged.state,
    });

    const tsFm = Math.floor(Date.now() / 60000) * 60000;
    const tsTo = tsFm + 60000;

    // jsonData 內不允許有 |（Kafka 訊息用 | 分隔）
    const safeJsonData = jsonData.replace(/\|/g, ',');

    const message = [
      String(tsFm),
      String(tsTo),
      'sentinel_monitor',
      'sentinel_market_agg',
      'ai_data',
      safeJsonData,
      String(tsTo),
      '1',
    ].join('|');

    await producer.send({
      topic: TOPIC,
      messages: [{ value: message }],
    });

    console.log('[Kafka] Pushed to', TOPIC);
    await producer.disconnect();
  } catch (e) {
    console.error('[Kafka] Error:', e.message);
  }
}

module.exports = { pushSignal };
