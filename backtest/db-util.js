/**
 * backtest/db-util.js
 * Shared utilities for backtest DB integration.
 */
const path = require('path');
const fs = require('fs');
const { initDatabase, createBacktestRun, getBacktestRun, registerSnapshot, registerResult, listBacktestRuns } = require('../database');

initDatabase();

const BACKTEST_ROOT = path.join(__dirname); // ~/tv-sentinel/backtest/

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Get the base directory for a backtest run's files */
function getRunDir(runId) {
  return path.join(BACKTEST_ROOT, runId);
}

/** Get subdirectory for snapshots */
function getSnapshotDir(runId) {
  return path.join(getRunDir(runId), 'snapshots');
}

/** Get subdirectory for results */
function getResultDir(runId) {
  return path.join(getRunDir(runId), 'results');
}

/**
 * Create a new backtest run in DB + filesystem.
 * Returns the run object.
 */
function createRun({ name, fromTime, toTime, interval, config } = {}) {
  const run = createBacktestRun({
    name: name || '',
    from_time: fromTime || '',
    to_time: toTime || '',
    interval: interval || '1h',
    config: config || {},
  });
  // Create directories
  ensureDir(getSnapshotDir(run.id));
  ensureDir(getResultDir(run.id));
  return run;
}

/**
 * Register a snapshot file path in DB after writing it.
 * @param {string} runId
 * @param {string} dataType - 'rotation' | 'volume_surge' | 'composite_index' | 'resistance'
 * @param {string} timestamp - ISO string or date string
 * @param {string} fileName - just the filename (not full path)
 */
function regSnapshot(runId, dataType, timestamp, fileName) {
  const fullPath = path.join(getSnapshotDir(runId), fileName);
  return registerSnapshot(runId, dataType, timestamp, fullPath);
}

/**
 * Register a result file path in DB after writing it.
 * @param {string} runId
 * @param {string} sentinelType - 'lt' | 'st' | 'trend' | 'check'
 * @param {string} timestamp - ISO string
 * @param {string} fileName - just the filename
 */
function regResult(runId, sentinelType, timestamp, fileName) {
  const fullPath = path.join(getResultDir(runId), fileName);
  return registerResult(runId, sentinelType, timestamp, fullPath);
}

/**
 * Load a snapshot from file, looking up the path via DB.
 * Returns null if not found.
 */
function loadSnapshot(runId, dataType, timestamp) {
  const run = getBacktestRun(runId);
  if (!run) return null;
  const paths = run.snapshots?.[dataType];
  if (!paths) return null;

  // Find closest matching timestamp
  const ts = Object.keys(paths).sort().find(k => k <= timestamp);
  if (!ts) return null;

  const filePath = paths[ts];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Load result from file.
 */
function loadResult(runId, sentinelType, timestamp) {
  const run = getBacktestRun(runId);
  if (!run) return null;
  const paths = run.results?.[sentinelType];
  if (!paths) return null;

  const ts = Object.keys(paths).sort().find(k => k <= timestamp);
  if (!ts) return null;

  const filePath = paths[ts];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = {
  createRun,
  getRunDir,
  getSnapshotDir,
  getResultDir,
  regSnapshot,
  regResult,
  loadSnapshot,
  loadResult,
  getBacktestRun,
  listBacktestRuns,
};
