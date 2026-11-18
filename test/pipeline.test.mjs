import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createState, applyEvent, computeMood, T } from '../lib/state.mjs';
import { TokenTracker, isAllowedTranscript } from '../lib/transcript.mjs';
import { createBuddyServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hook.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-'));

// ---------- 헬퍼 ----------
function runHook(port, payload, { raw } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, AGENT_BUDDY_PORT: String(port) } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(raw !== undefined ? raw : JSON.stringify(payload));
  });
}
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const getJson = async (port, p) => JSON.parse((await request(port, { path: p })).body);
const base = (name, extra = {}) => ({
  session_id: 'sess-1',
  transcript_path: '/nonexistent/x.jsonl',
  cwd: '/work/my-app',
  permission_mode: 'default',
  hook_event_name: name,
  ...extra,
});

// ---------- 1. 상태 머신 ----------
test('상태 머신: 한 턴의 흐름과 시간 경과', () => {
  const st = createState();
  // project 는 서버/훅이 cwd 에서 뽑아 넣어 주는 필드
  const ap = (ev, t) => applyEvent(st, { ...ev, project: 'my-app' }, t);
  const mood = (t) => computeMood(st, t).mood;

  ap(base('SessionStart', { source: 'startup' }), 0);
  assert.equal(mood(100), 'idle');
  ap(base('UserPromptSubmit', { prompt: 'x' }), 1000);
  assert.equal(mood(1100), 'thinking');
  ap(base('PreToolUse', { tool_name: 'Read' }), 2000);
  assert.equal(mood(2100), 'reading');
  ap(base('PostToolUse', { tool_name: 'Read' }), 2500);
  ap(base('PreToolUse', { tool_name: 'Edit' }), 3000);
  assert.equal(mood(3100), 'writing');

  // 실패 -> 패닉 -> 시간이 지나면 다시 작업 상태
  ap(base('PostToolUseFailure', { tool_name: 'Edit', error: 'boom' }), 4000);
  assert.equal(mood(4100), 'panic');
  assert.equal(mood(4000 + T.failureMs + 1), 'writing');

  // 권한 요청 -> 대기, 다음 도구 결과로 해제
  ap(base('PreToolUse', { tool_name: 'Bash' }), 7000);
  ap(base('Notification', { notification_type: 'permission_prompt' }), 7100);
  assert.equal(mood(7200), 'waiting');
  ap(base('PostToolUse', { tool_name: 'Bash' }), 9000);
  assert.equal(mood(9100), 'typing');

  // 도구 이벤트가 오래 없으면 '생각 중'
  assert.equal(mood(9000 + T.workingStaleMs + 1), 'thinking');

  // 종료 -> 축하 -> 대기 -> 졸음
  ap(base('Stop', { last_assistant_message: 'done' }), 20000);
  assert.equal(mood(20100), 'celebrate');
  assert.equal(mood(20000 + T.doneMs + 1), 'idle');
  assert.equal(mood(20000 + T.sleepMs + 1), 'sleeping');

  const snap = computeMood(st, 20100);
  assert.equal(snap.project, 'my-app');
  assert.equal(snap.failures, 1);
  assert.equal(snap.toolCalls, 3);
});

test('상태 머신: 특수 케이스', () => {
  let st = createState();
  const ap = (ev, t) => applyEvent(st, ev, t);
  const mood = (t) => computeMood(st, t).mood;

  // 레이트 리밋
  ap(base('StopFailure', { error: 'rate_limit' }), 0);
  assert.equal(mood(10), 'exhausted');
  assert.equal(mood(T.errorMs + 10), 'idle');

  // 다른 API 에러는 패닉
  st = createState();
  ap(base('StopFailure', { error: 'server_error' }), 0);
  assert.equal(mood(10), 'panic');

  // 사용자 인터럽트는 에러가 아니다
  st = createState();
  ap(base('PreToolUse', { tool_name: 'Bash' }), 0);
  ap(base('PostToolUseFailure', { is_interrupt: true }), 100);
  assert.equal(mood(200), 'idle');
  assert.equal(computeMood(st, 200).failures, 0);

  // MCP 도구, 서브에이전트
  st = createState();
  ap(base('PreToolUse', { tool_name: 'mcp__memory__memory_read' }), 0);
  assert.equal(mood(10), 'plugging');
  ap(base('PreToolUse', { tool_name: 'Task' }), 20);
  assert.equal(mood(30), 'delegating');
  ap(base('SubagentStart', {}), 40);
  ap(base('SubagentStart', {}), 41);
  ap(base('SubagentStop', {}), 42);
  assert.equal(computeMood(st, 50).subagents, 1);

  // 도구 10번 이상 쓴 턴은 큰 축하
  st = createState();
  ap(base('UserPromptSubmit'), 0);
  for (let i = 0; i < 10; i++) ap(base('PreToolUse', { tool_name: 'Bash' }), 10 + i);
  ap(base('Stop'), 100);
  assert.equal(mood(110), 'celebrate_big');

  // 버려진 working 세션은 계속 일하는 척하지 않는다
  st = createState();
  ap(base('PreToolUse', { tool_name: 'Bash' }), 0);
  assert.notEqual(mood(T.abandonMs + 1), 'typing');

  // SessionEnd 후 세션 제거, 여러 세션 중 하나라도 승인 대기면 waiting 우선
  st = createState();
  ap(base('PreToolUse', { tool_name: 'Bash' }), 0);
  ap({ ...base('Notification', { notification_type: 'permission_prompt' }), session_id: 'sess-2' }, 5);
  assert.equal(mood(10), 'waiting');
  ap({ ...base('SessionEnd'), session_id: 'sess-2' }, 20);
  assert.equal(mood(30), 'typing');
});

// ---------- 2. 트랜스크립트 토큰 ----------
test('토큰 추적: 스트리밍 중복 제거, 줄 경계, 멀티바이트 경계, 경로 가드', () => {
  const claudeDir = tmp();
  const proj = path.join(claudeDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 'sess.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  const asst = (id, out, extra = {}) =>
    line({ type: 'assistant', message: { id, usage: { input_tokens: 3, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, ...extra } } });

  fs.writeFileSync(file, line({ type: 'user', message: { content: '안녕하세요' } }) + asst('m1', 10) + asst('m1', 50) + asst('m2', 20));
  const tr = new TokenTracker(claudeDir);
  let t = tr.update('s', file);
  assert.equal(t.messages, 2); // m1 은 한 번만
  assert.equal(t.output, 70); // 50 + 20
  assert.equal(t.cacheRead, 10000);
  assert.equal(t.total, 3 * 2 + 70 + 100 * 2); // input+output+cacheCreate (캐시 읽기 제외)

  // 마지막 줄이 중간에 끊긴 상태 + 한글 UTF-8 바이트가 중간에 잘린 상태
  const full = Buffer.from(
    line({ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: '한글🙂텍스트' }], usage: { input_tokens: 1, output_tokens: 7 } } }),
  );
  const cut = full.indexOf(Buffer.from('글')) + 1; // '글' 의 첫 바이트만 쓴 위치
  fs.appendFileSync(file, full.subarray(0, cut));
  t = tr.update('s', file);
  assert.equal(t.messages, 2); // 아직 완성 안 됨
  fs.appendFileSync(file, full.subarray(cut));
  t = tr.update('s', file);
  assert.equal(t.messages, 3);
  assert.equal(t.output, 77);

  // 파일이 줄어들면(교체/압축) 처음부터 다시 읽는다
  fs.writeFileSync(file, asst('z1', 5));
  t = tr.update('s', file);
  assert.equal(t.messages, 1);
  assert.equal(t.output, 5);

  // 경로 가드
  const outside = path.join(tmp(), 'evil.jsonl');
  fs.writeFileSync(outside, asst('e1', 999));
  assert.equal(isAllowedTranscript(file, claudeDir), true);
  assert.equal(isAllowedTranscript(outside, claudeDir), false);
  assert.equal(isAllowedTranscript(path.join(proj, '..', '..', '..', path.basename(outside)), claudeDir), false);
  assert.equal(isAllowedTranscript(path.join(proj, 'sess.txt'), claudeDir), false);
  assert.equal(new TokenTracker(claudeDir).update('x', outside).output, 0);
});

// ---------- 3. 서버 + 훅 통합 ----------
test('통합: 실제 hook.mjs 로 이벤트 전달, 민감 필드는 서버에 도달하지 않음', async () => {
  const claudeDir = tmp();
  const proj = path.join(claudeDir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, 'sess-1.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'assistant', message: { id: 'a1', usage: { input_tokens: 10, output_tokens: 12000, cache_creation_input_tokens: 500 } } }) + '\n',
  );

  const app = createBuddyServer({ port: 0, claudeDir });
  const port = await app.listen();
  try {
    const SECRET = 'TOP_SECRET_PROMPT_9f3a';
    const send = (name, extra) => runHook(port, base(name, { transcript_path: transcript, ...extra }));

    for (const r of [
      await send('SessionStart', { source: 'startup' }),
      await send('UserPromptSubmit', { prompt: SECRET }),
      await send('PreToolUse', { tool_name: 'Bash', tool_input: { command: `echo ${SECRET}` }, tool_use_id: 't1' }),
    ]) {
      assert.equal(r.code, 0);
      assert.equal(r.out, '', 'hook 은 stdout 에 아무것도 쓰면 안 된다');
      assert.equal(r.err, '');
    }
    let s = await getJson(port, '/state');
    assert.equal(s.mood, 'typing');
    assert.equal(s.project, 'my-app');
    assert.equal(s.toolCalls, 1);
    assert.equal(s.tokens.output, 12000);
    assert.equal(s.coffee, 2);

    await send('PostToolUseFailure', { tool_name: 'Bash', error: SECRET, tool_response: SECRET });
    assert.equal((await getJson(port, '/state')).mood, 'panic');

    await send('Notification', { notification_type: 'permission_prompt', message: SECRET });
    assert.equal((await getJson(port, '/state')).mood, 'waiting');

    await send('Stop', { last_assistant_message: SECRET, stop_hook_active: false });
    s = await getJson(port, '/state');
    assert.equal(s.mood, 'celebrate');
    assert.equal(s.failures, 1);

    // 서버가 받은/보관한 어떤 것에도 비밀이 없어야 한다
    const everything = (await request(port, { path: '/events/recent' })).body + JSON.stringify(s);
    assert.ok(!everything.includes(SECRET), '민감 텍스트가 서버까지 전달됨');
    assert.ok(!everything.includes('transcript'), '트랜스크립트 경로가 노출됨');

    await send('SessionEnd', { reason: 'other' });
    assert.equal((await getJson(port, '/state')).activeSessions, 0);
  } finally {
    await app.close();
  }
});

// ---------- 4. 훅은 절대 에이전트를 막지 않는다 ----------
test('훅: 서버가 꺼져 있어도 조용히, 빠르게, exit 0', async () => {
  // 바로 닫은 서버의 포트 = 연결 거부 상태
  const dead = createBuddyServer({ port: 0, claudeDir: tmp() });
  const port = await dead.listen();
  await dead.close();

  const r = await runHook(port, base('PreToolUse', { tool_name: 'Bash' }));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  assert.ok(r.ms < 1400, `너무 오래 걸림: ${r.ms}ms`);

  const bad = await runHook(port, null, { raw: 'not json at all' });
  assert.equal(bad.code, 0);
  assert.equal(bad.out + bad.err, '');
  const empty = await runHook(port, null, { raw: '' });
  assert.equal(empty.code, 0);
});

// ---------- 5. HTTP 보호 장치 ----------
test('서버: Host/Origin/Content-Type/크기 제한', async () => {
  const app = createBuddyServer({ port: 0, claudeDir: tmp() });
  const port = await app.listen();
  try {
    const ok = JSON.stringify({ hook_event_name: 'Stop', session_id: 'a' });
    assert.equal((await request(port, { method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json' }, body: ok })).status, 204);
    assert.equal((await request(port, { method: 'POST', path: '/event', headers: { 'Content-Type': 'text/plain' }, body: ok })).status, 415);
    assert.equal((await request(port, { method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: ok })).status, 403);
    assert.equal((await request(port, { path: '/state', headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await request(port, { method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json' }, body: '{"foo":1}' })).status, 400);
    assert.equal((await request(port, { path: '/nope' })).status, 404);
    assert.equal((await request(port, { path: '/../server.mjs' })).status, 404); // 정적 파일 경로 이탈 불가

    const big = JSON.stringify({ hook_event_name: 'Stop', pad: 'x'.repeat(70 * 1024) });
    let status;
    try {
      status = (await request(port, { method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json' }, body: big })).status;
    } catch {
      status = 'reset';
    }
    assert.ok(status === 413 || status === 'reset', `큰 본문이 거부되지 않음: ${status}`);

    const page = await request(port, { path: '/' });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('agent-buddy'));
    assert.equal((await request(port, { path: '/lines.ko.json' })).status, 200);
  } finally {
    await app.close();
  }
});

// ---------- 6. SSE ----------
test('SSE: 연결 즉시 현재 상태, 이벤트마다 갱신', async () => {
  const app = createBuddyServer({ port: 0, claudeDir: tmp(), tickMs: 50 });
  const port = await app.listen();
  const messages = [];
  const req = http.get({ host: '127.0.0.1', port, path: '/stream' });
  const waitFor = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const hit = messages.find(pred);
        if (hit) { clearInterval(iv); resolve(hit); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout; got ' + JSON.stringify(messages.map((m) => m.mood)))); }
      }, 20);
    });
  req.on('response', (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = block.match(/^data: (.*)$/m);
        if (m) messages.push(JSON.parse(m[1]));
      }
    });
  });
  try {
    const first = await waitFor(() => true);
    assert.equal(first.mood, 'sleeping'); // 세션 없음 = 출근 전
    await runHook(port, base('PreToolUse', { tool_name: 'WebSearch' }));
    const searching = await waitFor((m) => m.mood === 'searching');
    assert.equal(searching.activeSessions, 1);
    await runHook(port, base('Stop'));
    await waitFor((m) => m.mood === 'celebrate');
  } finally {
    req.destroy();
    await app.close();
  }
});
