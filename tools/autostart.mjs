// SessionStart 훅에서 호출: 오버레이(서버 내장 Electron)가 안 떠 있으면 백그라운드로 띄운다.
// 훅이므로 절대 출력하지 않고(stdout 은 모델 컨텍스트로 들어감) 즉시 끝낸다. 느린 일은 launch-overlay.mjs 에 맡긴다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const done = () => process.exit(0);

// 창 추적이 Windows 전용이라 다른 OS 에선 자동 실행하지 않음. AGENT_BUDDY_AUTOSTART=0 으로 끌 수 있음.
if (process.platform !== 'win32' || process.env.AGENT_BUDDY_AUTOSTART === '0') done();

const port = Number(process.env.AGENT_BUDDY_PORT || 47821);
try {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
  if (r.ok) done(); // 이미 떠 있음 (오버레이든, 직접 띄운 server.mjs 든)
} catch {}

spawn(process.execPath, [path.join(ROOT, 'tools', 'launch-overlay.mjs')], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
}).unref();
done();
