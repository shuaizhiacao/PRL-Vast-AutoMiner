import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Stop } from './errors.js';

// 只在真正租机时生成。私钥留在本机 0600 文件，不进日志，也不拷进 Clore 容器。
export function loadOrCreateSshKey(dir) {
  const file = path.join(dir, 'id_ed25519');
  if (fs.existsSync(`${file}.pub`)) {
    try { fs.chmodSync(file, 0o600); } catch { /* 已有私钥保持原权限 */ }
    return Promise.resolve({ privatePath: file, publicKey: fs.readFileSync(`${file}.pub`, 'utf8').trim() });
  }
  return generateSshKey(dir);
}

export function generateSshKey(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'id_ed25519');
  const comment = `flop-${crypto.randomBytes(3).toString('hex')}`;
  const child = spawn('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', file, '-C', comment], { stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    child.on('error', () => reject(new Stop('无法运行 ssh-keygen')));
    child.on('exit', (code) => {
      if (code !== 0) reject(new Stop('ssh-keygen 失败'));
      else {
        try { fs.chmodSync(file, 0o600); } catch { /* 权限在 POSIX 上应可设置 */ }
        const publicKey = fs.readFileSync(`${file}.pub`, 'utf8').trim();
        resolve({ privatePath: file, publicKey });
      }
    });
  });
}

export function sshExec({ privateKeyPath, endpoint }) {
  return {
    exec(command) {
      if (!endpoint?.host || !(endpoint.port > 1024)) throw new Stop('SSH 端口还不是高位映射');
      return new Promise((resolve, reject) => {
        const args = [
          '-i', privateKeyPath,
          '-p', String(endpoint.port),
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'BatchMode=yes',
          `${endpoint.user || 'root'}@${endpoint.host}`,
          command,
        ];
        const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (buf) => { out += buf; });
        child.on('error', () => reject(new Stop('ssh 执行失败')));
        child.on('exit', (code) => {
          if (code !== 0) reject(new Stop('远端命令失败'));
          else resolve(out);
        });
      });
    },
  };
}
