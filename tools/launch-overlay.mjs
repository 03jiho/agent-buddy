// 오버레이 실행기 (autostart.mjs 가 분리 프로세스로 띄움).
// 처음이면 npm install → Electron 바이너리 확인(Node 24 압축 해제 버그 우회) → Electron 실행.
// 진행 상황은 %TEMP%/agent-buddy-launch.log 에 남긴다.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EL = path.join(ROOT, 'node_modules', 'electron');
const EXE = path.join(EL, 'dist', 'electron.exe');
const LOG = path.join(os.tmpdir(), 'agent-buddy-launch.log');
const LOCK = path.join(ROOT, '.launch.lock');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

// 세션 여러 개가 동시에 시작돼도 설치/실행은 한 번만. 10분 넘은 잠금은 죽은 것으로 보고 치운다.
function takeLock() {
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch {}
  try {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60 * 1000) return false;
    fs.rmSync(LOCK, { force: true });
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    return true;
  } catch { return false; }
}

function findFile(dir, name) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return null;
}

// Node 24 에서 Electron 의 extract-zip 이 첫 파일만 풀고 멈춘다 → 캐시된 zip 을 체크섬 확인 후 tar 로 직접 푼다.
function repairElectron() {
  spawnSync(process.execPath, [path.join(EL, 'install.js')], { cwd: EL, windowsHide: true }); // zip 다운로드(캐시)까지는 됨
  if (fs.existsSync(EXE)) return;
  const { version } = JSON.parse(fs.readFileSync(path.join(EL, 'package.json'), 'utf8'));
  const name = `electron-v${version}-win32-${process.arch}.zip`;
  const zip = findFile(path.join(process.env.LOCALAPPDATA || os.homedir(), 'electron', 'Cache'), name);
  if (!zip) return log(`repair: ${name} not in cache`);
  const sums = JSON.parse(fs.readFileSync(path.join(EL, 'checksums.json'), 'utf8'));
  const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (sums[name] !== hash) return log(`repair: checksum mismatch for ${name}`);
  const dist = path.join(EL, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const r = spawnSync(tar, ['-xf', zip, '-C', dist], { windowsHide: true });
  fs.writeFileSync(path.join(EL, 'path.txt'), 'electron.exe');
  log(`repair: tar exit ${r.status}`);
}

if (!takeLock()) process.exit(0);
try {
  if (!fs.existsSync(EXE)) {
    log('first run: npm install (Electron 다운로드, 몇 분 걸릴 수 있음)');
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, shell: true, windowsHide: true });
    log(`npm install exit ${r.status}`);
  }
  if (!fs.existsSync(EXE) && fs.existsSync(EL)) repairElectron();
  if (!fs.existsSync(EXE)) {
    log('electron.exe not found; giving up');
  } else {
    // Electron 이 단일 인스턴스 잠금을 갖고 있어서 이미 떠 있으면 새 것은 스스로 종료된다.
    spawn(EXE, [path.join(ROOT, 'electron', 'main.cjs')], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
    log('overlay started');
  }
} finally {
  fs.rmSync(LOCK, { force: true });
}
