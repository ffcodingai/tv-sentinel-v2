const express = require('express');
const path = require('path');
const cors = require('cors');
const { initDatabase, closeDatabase, getAllSentinels, getSentinel, createSentinel, updateSentinel, deleteSentinel, setSentinelStatus, setTriggered, addLog, getLogs, getMarketStates, setMarketState, addDataAssignment, getDataAssignments, getStats } = require('./database');
const http = require('http');

const PORT = 3333;
const app = express();

initDatabase();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Push log to tv-log (:4004) ──
function pushToTvLog(entry) {
  const data = JSON.stringify(entry);
  const req = http.request('http://127.0.0.1:4004/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      try { const j = JSON.parse(body); if (!j.ok) console.error('[tv-log push fail]', j.error); } catch(e) {}
    });
  });
  req.on('error', (e) => console.error('[tv-log push error]', e.message));
  req.write(data);
  req.end();
}
app.use(express.static(path.join(__dirname, 'public')));

// ── Lookup sentinel ID by type (avoid hardcoded UUIDs) ──
function sentinelIdByType(type) {
  const s = getAllSentinels().find(x => x.type === type);
  return s ? s.id : null;
}

// ──────────────────────────────────────────
//  Sentinel CRUD
// ──────────────────────────────────────────

app.get('/api/sentinels', (req, res) => {
  const { type, status } = req.query;
  let list = getAllSentinels();
  if (type) list = list.filter(s => s.type === type);
  if (status) list = list.filter(s => s.status === status);
  res.json(list);
});

app.get('/api/sentinels/:id', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sentinel not found' });
  res.json(s);
});

app.post('/api/sentinels', (req, res) => {
  const { name, type, description, config, data_sources, market, symbol, interval } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const validTypes = ['up_trend', 'up_turn', 'down_trend', 'down_turn', 'sector_rotation'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  const sentinel = createSentinel({ name, type, description, config, data_sources, market, symbol, interval });
  addLog(sentinel.id, 'info', `Sentinel "${name}" created (${type})`);
  res.status(201).json(sentinel);
});

app.put('/api/sentinels/:id', (req, res) => {
  const s = updateSentinel(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Sentinel not found' });
  addLog(s.id, 'state_change', `Sentinel "${s.name}" updated`);
  res.json(s);
});

app.delete('/api/sentinels/:id', (req, res) => {
  deleteSentinel(req.params.id);
  res.json({ success: true });
});

// ──────────────────────────────────────────
//  Sentinel Status Control
// ──────────────────────────────────────────

app.post('/api/sentinels/:id/activate', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  setSentinelStatus(s.id, 'active');
  addLog(s.id, 'state_change', `Sentinel "${s.name}" activated`);
  res.json(getSentinel(s.id));
});

app.post('/api/sentinels/:id/pause', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  setSentinelStatus(s.id, 'paused');
  addLog(s.id, 'state_change', `Sentinel "${s.name}" paused`);
  res.json(getSentinel(s.id));
});

app.post('/api/sentinels/:id/trigger', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  setTriggered(s.id);
  addLog(s.id, 'triggered', req.body.message || `Sentinel "${s.name}" triggered`, null, null);
  res.json(getSentinel(s.id));
});

// ──────────────────────────────────────────
//  Logs
// ──────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const { sentinel_id, limit } = req.query;
  res.json(getLogs(sentinel_id || null, parseInt(limit) || 50));
});

app.post('/api/logs', (req, res) => {
  const { sentinel_id, event, message, old_state, new_state } = req.body;
  if (!sentinel_id || !event) return res.status(400).json({ error: 'sentinel_id and event required' });
  const id = addLog(sentinel_id, event, message, old_state, new_state);
  res.status(201).json({ id });
});

// ──────────────────────────────────────────
//  Market States
// ──────────────────────────────────────────

app.get('/api/states', (req, res) => {
  res.json(getMarketStates());
});

app.post('/api/states', (req, res) => {
  const { sentinel_id, market, state, confidence, detail } = req.body;
  if (!sentinel_id || !market || !state) return res.status(400).json({ error: 'sentinel_id, market, state required' });
  const id = setMarketState(sentinel_id, market, state, confidence, detail);
  res.status(201).json({ id });
});

// ──────────────────────────────────────────
//  Sentinel Execution
// ──────────────────────────────────────────

const { main: runSentinelCheck } = require('./executor');
const { main: runTrendCheck } = require('./executor-trend');

/**
 * POST /api/sentinels/check
 * Run the consensus turning point sentinel check
 * Body: { at?: "2026-06-10 09:30" } (optional for historical)
 */
app.post('/api/sentinels/check', express.json(), async (req, res) => {
  try {
    const source = req.body.source === 'cron' ? 'cron' : 'manual';
    const options = { at: req.body.at || null, source };
    const result = await runSentinelCheck(options);

    // Log result every run (not just triggered)
    const turnId = sentinelIdByType('up_turn');
    if (turnId) {
      const triggered = result.triggered;
      const msg = `[${source}] ${triggered ? '🚨' : '✅'} 轉折檢查 — ${result.triggerReason || result.triggerType || '無信號'}`;
      addLog(turnId, triggered ? 'triggered' : 'info', msg);
      pushToTvLog({
        agent: 'tv-sentinel',
        type: 'check',
        info_type: triggered ? 'triggered' : 'info',
        header: triggered ? `🚨 ${result.triggerType} 觸發 [${source}]` : `✅ 轉折檢查通過 [${source}]`,
        status: triggered ? 'trigger' : 'ok',
        market: 'global',
        alert: triggered ? '🔴' : '⚪',
        info: JSON.stringify({ triggered, reason: result.triggerReason, triggerType: result.triggerType, source }),
        ref_id: turnId,
        ref_source: 'sentinel.check',
      });
    }

    res.json(result);
  } catch (err) {
    console.error('[Sentinel Check Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sentinels/trend-check
 * Run the trend management sentinel check
 */
app.post('/api/sentinels/trend-check', express.json(), async (req, res) => {
  try {
    const source = req.body.source === 'cron' ? 'cron' : 'manual';
    const options = { at: req.body.at || null, source };
    const result = await runTrendCheck(options);

    if (result.trendHealthy) {
      const trendId = sentinelIdByType('up_trend');
      if (trendId) {
        addLog(trendId, 'info',
          `[${source}] 🟢 趨勢健康 — ${result.trendDirection==='up'?'📈上漲':'📉下跌'}延續 (${result.reason})`);
        pushToTvLog({
          agent: 'tv-sentinel',
          type: 'trend',
          info_type: 'healthy',
          header: `🟢 趨勢健康 [${source}] — ${result.trendDirection==='up'?'📈上漲':'📉下跌'}延續`,
          status: 'ok',
          market: 'global',
          alert: '⚪',
          info: JSON.stringify({ direction: result.trendDirection, reason: result.reason, source }),
          ref_id: trendId,
          ref_source: 'sentinel.trend',
        });
      }
    } else if (!result.trendHealthy && result.reason !== '休市' && result.reason !== '數據不可用') {
      const trendId = sentinelIdByType('up_trend');
      if (trendId) {
        addLog(trendId, 'info',
          `[${source}] ⚠️ 趨勢轉弱 — ${result.reason}`);
        pushToTvLog({
          agent: 'tv-sentinel',
          type: 'trend',
          info_type: 'warning',
          header: `⚠️ 趨勢轉弱 [${source}]`,
          status: 'warn',
          market: 'global',
          alert: '🟡',
          info: JSON.stringify({ reason: result.reason, source }),
          ref_id: trendId,
          ref_source: 'sentinel.trend',
        });
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[Trend Check Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
//  Data Assignments
// ──────────────────────────────────────────
//  Rotation Sentinels
// ──────────────────────────────────────────

// Map market codes to agent IDs
const ROTATION_MAP = {
  judge: { agent: 'tv-rot-judge', name: '🔄 板塊輪動判定中樞' },
  cn: { agent: 'tv-rot-cn', name: '🇨🇳 板塊輪動-中國' },
  kr: { agent: 'tv-rot-kr', name: '🇰🇷 板塊輪動-韓國' },
  jp: { agent: 'tv-rot-jp', name: '🇯🇵 板塊輪動-日本' },
  tw: { agent: 'tv-rot-tw', name: '🇹🇼 板塊輪動-台灣' },
  hk: { agent: 'tv-rot-hk', name: '🇭🇰 板塊輪動-香港' },
  uk: { agent: 'tv-rot-uk', name: '🇬🇧 板塊輪動-英國' },
  fr: { agent: 'tv-rot-fr', name: '🇫🇷 板塊輪動-法國' },
  de: { agent: 'tv-rot-de', name: '🇩🇪 板塊輪動-德國' },
  us: { agent: 'tv-rot-us', name: '🇺🇸 板塊輪動-美國' },
};

/**
 * POST /api/sentinels/rotation-exec
 * Trigger a rotation market sentinel. Logs the trigger in DB.
 * Body: { market: "judge"|"cn"|"kr"|... }
 */
// ──────────────────────────────────────────
//  LT / ST 哨兵檢查 API
// ──────────────────────────────────────────

const { main: runLtCheck } = require('./executor-lt');
const { main: runStCheck } = require('./executor-st');

app.post('/api/sentinels/lt-check', express.json(), async (req, res) => {
  try {
    const source = req.body.source === 'cron' ? 'cron' : 'manual';
    const options = { at: req.body.at || null, source };
    const result = await runLtCheck(options);

    const ltId = sentinelIdByType('lt');
    if (ltId) {
      setTriggered(ltId);
      const msg = `[${source}] ${result.ltTriggered ? '🚨' : '✅'} LT檢查 — ${result.ltReason || '無信號'}`;
      addLog(ltId, 'info', msg);
      pushToTvLog({
        agent: 'tv-sentinel',
        type: 'lt',
        info_type: result.ltTriggered ? 'triggered' : 'info',
        header: result.ltTriggered ? `🚨 LT觸發 [${source}]` : `✅ LT檢查通過 [${source}]`,
        status: result.ltTriggered ? 'trigger' : 'ok',
        market: 'global',
        alert: result.ltTriggered ? '🔴' : '⚪',
        info: JSON.stringify({ triggered: result.ltTriggered, reason: result.ltReason, source }),
        ref_id: ltId,
        ref_source: 'sentinel.lt',
      });
    }

    res.json({ ...result, source });
  } catch (err) {
    console.error('[LT Check Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sentinels/st-check', express.json(), async (req, res) => {
  try {
    const source = req.body.source === 'cron' ? 'cron' : 'manual';
    const options = { at: req.body.at || null, source };
    const result = await runStCheck(options);

    const stId = sentinelIdByType('st');
    if (stId) {
      setTriggered(stId);
      const msg = `[${source}] ${result.stTriggered ? '🚨' : '✅'} ST檢查 — ${result.stReason || '無信號'}`;
      addLog(stId, 'info', msg);
      pushToTvLog({
        agent: 'tv-sentinel',
        type: 'st',
        info_type: result.stTriggered ? 'triggered' : 'info',
        header: result.stTriggered ? `🚨 ST觸發 [${source}]` : `✅ ST檢查通過 [${source}]`,
        status: result.stTriggered ? 'trigger' : 'ok',
        market: 'global',
        alert: result.stTriggered ? '🔴' : '⚪',
        info: JSON.stringify({ triggered: result.stTriggered, reason: result.stReason, source }),
        ref_id: stId,
        ref_source: 'sentinel.st',
      });
    }

    res.json({ ...result, source });
  } catch (err) {
    console.error('[ST Check Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────
//  Rotation exec
// ──────────────────────────────────────────

app.post('/api/rotation/exec', express.json(), async (req, res) => {
  try {
    const market = req.body.market;
    const source = req.body.source === 'cron' ? 'cron' : 'manual';
    if (!market || !ROTATION_MAP[market]) {
      return res.status(400).json({ error: 'Invalid market. Valid: ' + Object.keys(ROTATION_MAP).join(', ') });
    }
    const info = ROTATION_MAP[market];
    
    // Find the sentinel by data_sources containing the agentId
    const allSentinels = getAllSentinels();
    const sentinel = allSentinels.find(s => {
      const cfg = typeof s.config === 'object' ? s.config : {};
      return cfg.agentId === info.agent;
    });
    
    if (!sentinel) {
      return res.status(404).json({ error: `Sentinel for ${info.agent} not found in DB. Create it first.` });
    }
    
    // Log the trigger locally
    setTriggered(sentinel.id);
    addLog(sentinel.id, 'triggered', `[${source}] 🎯 ${info.name} 被觸發`, null, null);
    
    // Push to tv-log
    pushToTvLog({
      agent: 'tv-rot',
      type: 'rotation',
      info_type: 'triggered',
      time: new Date(Date.now() + 8*3600000).toISOString().replace('T', ' ').slice(0, 19) + ' HKT',
      header: `${info.flag || '🔄'} ${info.name} ${source==='cron'?'⏰ 定時觸發':'👆 手動觸發'}`,
      status: 'ok',
      market: market,
      alert: '⚪',
      info: JSON.stringify({ agent: info.agent, market, source }),
      ref_id: sentinel.id,
      ref_source: 'sentinel.rotation',
    });
    
    res.json({
      ok: true,
      sentinel_id: sentinel.id,
      agent: info.agent,
      name: info.name,
      source,
      message: `✅ [${source}] 已記錄觸發！請執行: sessions_spawn(agentId="${info.agent}", task="板塊輪動檢查", mode="run")`
    });
  } catch (err) {
    console.error('[Rotation Exec Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sentinels/rotation-exec?market=judge
 * Quick status of rotation sentinel
 */
app.get('/api/rotation/markets', (req, res) => {
  const { market } = req.query;
  if (market && ROTATION_MAP[market]) {
    const info = ROTATION_MAP[market];
    const all = getAllSentinels();
    const s = all.find(x => {
      const cfg = typeof x.config === 'object' ? x.config : {};
      return cfg.agentId === info.agent;
    });
    return res.json({ market, agent: info.agent, name: info.name, sentinel: s || null });
  }
  res.json({ markets: Object.keys(ROTATION_MAP).length, list: Object.entries(ROTATION_MAP).map(([k,v]) => ({ market: k, agent: v.agent, name: v.name })) });
});

// ──────────────────────────────────────────

app.get('/api/assignments', (req, res) => {
  const { sentinel_id } = req.query;
  if (!sentinel_id) return res.status(400).json({ error: 'sentinel_id required' });
  res.json(getDataAssignments(sentinel_id));
});

app.post('/api/assignments', (req, res) => {
  const { sentinel_id, agent_id, endpoint, params } = req.body;
  if (!sentinel_id || !agent_id) return res.status(400).json({ error: 'sentinel_id and agent_id required' });
  const id = addDataAssignment(sentinel_id, agent_id, endpoint, params);
  res.status(201).json({ id });
});

// ──────────────────────────────────────────
//  Stats
// ──────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ──────────────────────────────────────────
//  Health
// ──────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ──────────────────────────────────────────
//  Serve frontend (catch-all)
// ──────────────────────────────────────────

app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ──────────────────────────────────────────
//  Start
// ──────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🌟 tv-sentinel 哨兵系統`);
  console.log(`  ─────────────────────`);
  console.log(`  URL    http://localhost:${PORT}`);
  console.log(`  API    http://localhost:${PORT}/api`);
  console.log(`  DB     ${path.join(__dirname, 'sentinel.db')}\n`);
});

process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });
