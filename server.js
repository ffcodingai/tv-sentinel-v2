const express = require('express');
const path = require('path');
const cors = require('cors');
const { initDatabase, closeDatabase, getAllSentinels, getSentinel, createSentinel, updateSentinel, deleteSentinel, setSentinelStatus, getLogs, getStats, getExecutions } = require('./database');

const PORT = 3330;
const app = express();

initDatabase();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Sentinel CRUD ──

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
  res.status(201).json(sentinel);
});

app.put('/api/sentinels/:id', (req, res) => {
  const s = updateSentinel(req.params.id, req.body);
  if (!s) return res.status(404).json({ error: 'Sentinel not found' });
  res.json(s);
});

app.delete('/api/sentinels/:id', (req, res) => {
  deleteSentinel(req.params.id);
  res.json({ success: true });
});

app.post('/api/sentinels/:id/activate', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  setSentinelStatus(s.id, 'active');
  res.json(getSentinel(s.id));
});

app.post('/api/sentinels/:id/pause', (req, res) => {
  const s = getSentinel(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  setSentinelStatus(s.id, 'paused');
  res.json(getSentinel(s.id));
});

// ── Logs ──

app.get('/api/logs', (req, res) => {
  const { sentinel_id, limit } = req.query;
  res.json(getLogs(sentinel_id || null, parseInt(limit) || 50));
});

// ── Stats ──

app.get('/api/executions', (req, res) => {
  const { type, source, triggered, limit } = req.query;
  res.json(getExecutions({
    sentinel_type: type || null,
    source: source || null,
    triggered: triggered !== undefined ? triggered === '1' || triggered === 'true' : undefined,
    limit: parseInt(limit) || 30,
  }));
});

app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '2.0.0' });
});

// ── Catch-all ──

app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🌟 tv-sentinel-v2 哨兵系統`);
  console.log(`  ───────────────────────`);
  console.log(`  URL    http://localhost:${PORT}`);
  console.log(`  DB     ${path.join(__dirname, 'sentinel-v2.db')}\n`);
});

process.on('SIGINT', () => { closeDatabase(); process.exit(0); });
process.on('SIGTERM', () => { closeDatabase(); process.exit(0); });
