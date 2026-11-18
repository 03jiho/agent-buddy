// agent-buddy 이벤트 서버: Claude Code 훅 -> 상태 계산 -> 오버레이(SSE)
// 외부 의존성 없음. 127.0.0.1 에만 바인딩한다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createState, applyEvent, computeMood } from './lib/state.mjs';
import { TokenTracker } from './lib/transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.join(HERE, 'overlay');
const DEFAULT_PORT = 47821;
const MAX_BODY = 64 * 1024;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/lines.ko.json': ['lines.ko.json', 'application/json; charset=utf-8'],
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const baseName = (p) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() : undefined);

// 훅 페이로드에서 필요한 필드만 남긴다 (프롬프트/도구 입출력은 받지도 저장하지도 않음)
export function sanitize(ev) {
  if (!ev || typeof ev !== 'object') return {};
  const out = {
    hook_event_name: str(ev.hook_event_name, 40),
    session_id: str(ev.session_id, 100),
    transcript_path: str(ev.transcript_path, 500),
    project: str(ev.project, 60) ?? str(baseName(ev.cwd), 60),
    tool_name: str(ev.tool_name, 80),
    notification_type: str(ev.notification_type, 40),
    is_interrupt: ev.is_interrupt === true,
  };
  if (out.hook_event_name === 'StopFailure') out.error = str(ev.error, 40);
  return out;
}

export function createBuddyServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  claudeDir = process.env.AGENT_BUDDY_CLAUDE_DIR || path.join(os.homedir(), '.claude'),
  now = () => Date.now(),
  tickMs = 1000,
} = {}) {
  const state = createState();
  const tracker = new TokenTracker(claudeDir);
  const recent = [];
  const clients = new Set();
  let lastPayload = '';
  let timer = null;
  let actualPort = port;

  function snapshot() {
    const mood = computeMood(state, now());
    const tokens = tracker.sum(Object.keys(state.sessions));
    return {
      ...mood,
      tokens,
      coffee: Math.floor(tokens.output / 5000), // 장난용 환산: 출력 5천 토큰 = 커피 1잔
      eventSeq: state.seq,
    };
  }

  function broadcast(force = false) {
    const payload = JSON.stringify(snapshot());
    if (!force && payload === lastPayload) return;
    lastPayload = payload;
    for (const res of clients) res.write(`data: ${payload}\n\n`);
  }

  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  function hostOk(req) {
    const h = (req.headers.host || '').toLowerCase();
    return [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`].includes(h);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding 방지: 우리 주소로 온 요청만 처리
      if (!hostOk(req)) return send(res, 403, '{"error":"bad host"}');
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'POST' && url.pathname === '/event') {
        // 다른 웹페이지가 브라우저로 localhost 에 쏘는 것을 막는다
        if (req.headers.origin) return send(res, 403, '{"error":"origin not allowed"}');
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
          return send(res, 415, '{"error":"content-type must be application/json"}');
        }
        let ev;
        try {
          ev = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, e.status || 400, '{"error":"bad body"}');
        }
        const clean = sanitize(ev);
        if (!clean.hook_event_name) return send(res, 400, '{"error":"missing hook_event_name"}');
        const t = now();
        applyEvent(state, clean, t);
        const sid = clean.session_id || 'unknown';
        if (clean.hook_event_name === 'SessionEnd') tracker.forget(sid);
        else if (clean.transcript_path) tracker.update(sid, clean.transcript_path);
        const { transcript_path, ...loggable } = clean;
        recent.push({ t, ...loggable });
        if (recent.length > 50) recent.shift();
        broadcast();
        res.writeHead(204);
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`retry: 1500\n`);
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/state') return send(res, 200, JSON.stringify(snapshot()));
      if (req.method === 'GET' && url.pathname === '/events/recent') return send(res, 200, JSON.stringify(recent));
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, '{"ok":true}');

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(OVERLAY_DIR, file)), type);
      }
      return send(res, 404, '{"error":"not found"}');
    } catch (e) {
      if (!res.headersSent) send(res, 500, '{"error":"internal"}');
      else res.end();
    }
  });

  return {
    server,
    state,
    tracker,
    snapshot,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          actualPort = server.address().port;
          // 시간 경과로 바뀌는 mood(졸음, 완료 축하 종료 등)를 주기적으로 반영
          timer = setInterval(() => broadcast(), tickMs);
          timer.unref();
          resolve(actualPort);
        });
      });
    },
    close() {
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function start() {
  const port = Number(process.env.AGENT_BUDDY_PORT || DEFAULT_PORT);
  const app = createBuddyServer({ port });
  try {
    await app.listen();
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`[agent-buddy] 포트 ${port} 가 이미 사용 중입니다. 이미 실행 중이거나 AGENT_BUDDY_PORT 로 다른 포트를 지정하세요.`);
      process.exit(1);
    }
    throw e;
  }
  console.log(`[agent-buddy] http://127.0.0.1:${port}/  (훅 수신: POST /event, 상태: GET /state)`);
  return { app, port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
