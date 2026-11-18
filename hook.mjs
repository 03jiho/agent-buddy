#!/usr/bin/env node
// Claude Code 훅 -> agent-buddy 서버 전달용 스크립트.
//
// 설계 원칙
//  1) 절대 에이전트를 막지 않는다: 항상 exit 0, stdout/stderr 에 아무것도 쓰지 않는다
//     (UserPromptSubmit/SessionStart 등은 stdout 이 모델 컨텍스트에 들어갈 수 있다).
//  2) 서버가 꺼져 있어도 조용히 종료한다. 전체 제한시간 1.5초.
//  3) 프롬프트 본문, 도구 입력/출력 등 민감할 수 있는 필드는 이 프로세스 밖으로 보내지 않는다.
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENT_BUDDY_PORT || 47821);

const done = () => process.exit(0);
setTimeout(done, 1500); // 안전장치 (stdin 이 닫히지 않는 경우 등)

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let ev;
  try {
    ev = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return done();
  }
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  const payload = {
    hook_event_name: ev.hook_event_name,
    session_id: ev.session_id,
    transcript_path: ev.transcript_path, // 서버가 토큰 숫자만 읽는 용도
    project: cwd.split(/[\\/]/).filter(Boolean).pop(),
    tool_name: ev.tool_name,
    notification_type: ev.notification_type,
    is_interrupt: ev.is_interrupt === true,
  };
  if (ev.hook_event_name === 'StopFailure') payload.error = ev.error; // rate_limit 등 종류만

  const body = JSON.stringify(payload);
  const req = http.request(
    {
      host: HOST,
      port: PORT,
      path: '/event',
      method: 'POST',
      agent: false,
      timeout: 600,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    },
    (res) => {
      res.resume();
      res.on('end', done);
      res.on('error', done);
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', done);
  req.end(body);
});
