#!/usr/bin/env node
/**
 * slow-turn 回测脚本
 * 
 * 用法:
 *   node run-backtest.js --from="2026-06-22T00:00:00Z" --to="2026-06-25T00:00:00Z" --backtest-id="bt-001"
 *   node run-backtest.js --from="2026-06-22T00:00:00Z" --to="2026-06-25T00:00:00Z" --backtest-id="bt-001" --interval=300
 * 
 * 参数:
 *   --from=ISO        回测开始时间 (必填)
 *   --to=ISO          回测结束时间 (必填)
 *   --backtest-id=ID  回测版本号 (必填)
 *   --interval=N      时间间隔秒数，默认 300 (5分钟)
 */

const { spawn } = require('child_process');
const path = require('path');

function parseArgs(args) {
  const opts = {};
  for (const a of args) {
    if (a.startsWith('--from=')) opts.from = a.slice(7);
    else if (a.startsWith('--to=')) opts.to = a.slice(5);
    else if (a.startsWith('--backtest-id=')) opts.backtestId = a.slice(14);
    else if (a.startsWith('--interval=')) opts.interval = parseInt(a.slice(11));
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  
  if (!opts.from || !opts.to || !opts.backtestId) {
    console.error('用法: node run-backtest.js --from=ISO --to=ISO --backtest-id=ID [--interval=300]');
    process.exit(1);
  }
  
  const interval = opts.interval || 300; // 默认 5 分钟
  const fromMs = new Date(opts.from).getTime();
  const toMs = new Date(opts.to).getTime();
  
  if (isNaN(fromMs) || isNaN(toMs) || fromMs >= toMs) {
    console.error('时间范围无效');
    process.exit(1);
  }
  
  const totalPoints = Math.floor((toMs - fromMs) / (interval * 1000));
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   slow-turn 回测                          ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`  backtest-id: ${opts.backtestId}`);
  console.log(`  时间范围: ${opts.from} → ${opts.to}`);
  console.log(`  间隔: ${interval}s (${interval/60}分钟)`);
  console.log(`  总点数: ${totalPoints}`);
  console.log(`  开始: ${new Date().toISOString()}\n`);
  
  let success = 0;
  let failed = 0;
  const failures = [];
  
  const executorPath = path.join(__dirname, 'executor-slow-turn.js');
  
  for (let i = 0; i <= totalPoints; i++) {
    const ts = new Date(fromMs + i * interval * 1000);
    const atStr = ts.toISOString();
    const progress = `[${i+1}/${totalPoints+1}]`;
    
    process.stdout.write(`${progress} ${atStr} ... `);
    
    const ret = await new Promise((resolve) => {
      const child = spawn('node', [
        executorPath,
        '--json',
        `--at=${atStr}`,
        `--backtest-id=${opts.backtestId}`,
        '--save-db',
      ], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      
      // 单点超时 120s
      setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ code: -1, stdout, stderr: 'timeout' });
      }, 120000);
    });
    
    if (ret.code === 0) {
      try {
        const result = JSON.parse(ret.stdout);
        console.log(`${result.signal} | ${result.summary?.slice(0, 60) || ''}`);
        success++;
      } catch {
        console.log('OK (parse error)');
        success++;
      }
    } else {
      console.log(`FAIL (${ret.code}) ${ret.stderr?.slice(0, 80) || ''}`);
      failed++;
      failures.push({ atStr, error: ret.stderr?.slice(0, 200) || 'unknown' });
    }
  }
  
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`回测完成: ${success} 成功, ${failed} 失败, 共 ${totalPoints+1} 点`);
  console.log(`耗时: ${new Date().toISOString()}`);
  if (failures.length > 0) {
    console.log(`\n失败列表:`);
    for (const f of failures) {
      console.log(`  ${f.atStr}: ${f.error}`);
    }
  }
  console.log(`═══════════════════════════════════════════\n`);
}

main().catch(e => console.error('Error:', e.message));
