import fs from 'node:fs';
import path from 'node:path';
import { Stop } from './errors.js';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === 'EPERM'; }
}

// 进程级互斥：同一数据目录不能有两个编排器。
export function acquireProcessLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'orchestrator.lock');
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let stale = false;
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      stale = !pidAlive(cur.pid);
    } catch { stale = true; }
    if (!stale) throw new Stop('已有一个编排器实例在运行');
    fs.unlinkSync(file);
    return acquireProcessLock(dir);
  }
  return () => { try { fs.unlinkSync(file); } catch { /* 锁已消失 */ } };
}

// 同一进程里的异步单飞。赞助 POST 与 create_order 都不允许重叠。
export function createSingleFlight() {
  let tail = Promise.resolve();
  return function singleFlight(fn) {
    const run = tail.then(() => fn());
    tail = run.then(() => {}, () => {});
    return run;
  };
}
