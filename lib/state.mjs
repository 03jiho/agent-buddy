// 훅 이벤트 -> 캐릭터 상태(mood) 변환. 순수 함수만 두어서 테스트하기 쉽게 한다.

export const FLAVOR = {
  Bash: 'typing',
  PowerShell: 'typing',
  Edit: 'writing',
  MultiEdit: 'writing',
  Write: 'writing',
  NotebookEdit: 'writing',
  Read: 'reading',
  Grep: 'reading',
  Glob: 'reading',
  LS: 'reading',
  WebSearch: 'searching',
  WebFetch: 'searching',
  Task: 'delegating',
  Agent: 'delegating',
};

export function flavorOf(tool) {
  if (!tool) return 'typing';
  if (tool.startsWith('mcp__')) return 'plugging';
  return FLAVOR[tool] ?? 'typing';
}

// 시간 기준값(ms)
export const T = {
  workingStaleMs: 8_000, // 도구 이벤트가 이 시간 넘게 없으면 '생각 중'
  failureMs: 2_500, // 실패 직후 패닉 표시 시간
  doneMs: 5_000, // 완료 축하 표시 시간
  errorMs: 20_000, // StopFailure 표시 시간
  sleepMs: 120_000, // 이 시간 이벤트가 없으면 졸음
  abandonMs: 600_000, // 이 시간 넘게 조용한 working/thinking 은 버려진 세션으로 본다
};

export function createState() {
  return { sessions: {}, seq: 0, totalStops: 0 };
}

function ensure(state, ev, now) {
  const id = ev.session_id || 'unknown';
  let s = state.sessions[id];
  if (!s) {
    s = state.sessions[id] = {
      id,
      project: '',
      phase: 'idle', // idle | thinking | working | done | error
      tool: null,
      flavor: null,
      startedAt: now,
      lastEventAt: now,
      lastFailureAt: -Infinity,
      doneAt: -Infinity,
      errorAt: -Infinity,
      errorKind: null,
      waiting: false,
      waitingSince: 0,
      idleHint: false,
      toolCalls: 0,
      turnToolCalls: 0,
      failures: 0,
      streak: 0,
      subagents: 0,
      turns: 0,
    };
  }
  if (ev.project) s.project = ev.project;
  s.lastEventAt = now;
  return s;
}

export function applyEvent(state, ev, now = Date.now()) {
  const name = ev.hook_event_name;
  state.seq++;
  if (name === 'SessionEnd') {
    delete state.sessions[ev.session_id || 'unknown'];
    return;
  }
  const s = ensure(state, ev, now);
  switch (name) {
    case 'SessionStart':
      s.phase = 'idle';
      s.waiting = false;
      s.idleHint = false;
      s.startedAt = now;
      break;
    case 'UserPromptSubmit':
      s.phase = 'thinking';
      s.waiting = false;
      s.idleHint = false;
      s.turnToolCalls = 0;
      break;
    case 'PreToolUse':
      s.phase = 'working';
      s.tool = ev.tool_name || null;
      s.flavor = flavorOf(ev.tool_name);
      s.toolCalls++;
      s.turnToolCalls++;
      s.waiting = false;
      s.idleHint = false;
      break;
    case 'PostToolUse':
      s.phase = 'working';
      s.streak++;
      s.waiting = false;
      break;
    case 'PostToolUseFailure':
      if (ev.is_interrupt) {
        // 사용자가 직접 끊은 경우: 에러가 아니라 그냥 멈춤
        s.phase = 'idle';
        s.tool = null;
        s.waiting = false;
      } else {
        s.failures++;
        s.streak = 0;
        s.lastFailureAt = now;
      }
      break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt') {
        s.waiting = true;
        s.waitingSince = now;
      } else if (ev.notification_type === 'idle_prompt') {
        s.idleHint = true;
      } else if (ev.notification_type === 'agent_completed') {
        s.phase = 'done';
        s.doneAt = now;
      }
      break;
    case 'Stop':
      s.phase = 'done';
      s.doneAt = now;
      s.waiting = false;
      s.tool = null;
      s.turns++;
      state.totalStops++;
      break;
    case 'StopFailure':
      s.phase = 'error';
      s.errorAt = now;
      s.errorKind = ev.error || 'unknown';
      s.waiting = false;
      break;
    case 'SubagentStart':
      s.subagents++;
      break;
    case 'SubagentStop':
      s.subagents = Math.max(0, s.subagents - 1);
      break;
    default:
      break;
  }
}

// 여러 세션이 동시에 돌 수 있으므로 우선순위로 대표 mood 하나를 고른다.
export function computeMood(state, now = Date.now()) {
  const list = Object.values(state.sessions);
  const agg = {
    mood: 'sleeping',
    tool: null,
    project: '',
    activeSessions: list.length,
    subagents: 0,
    turnToolCalls: 0,
    toolCalls: 0,
    failures: 0,
    streak: 0,
    turns: 0,
    pulse: state.totalStops,
  };
  if (!list.length) return agg;

  let lead = list[0];
  for (const s of list) {
    if (s.lastEventAt > lead.lastEventAt) lead = s;
    agg.subagents += s.subagents;
    agg.toolCalls += s.toolCalls;
    agg.failures += s.failures;
    agg.turns += s.turns;
    agg.streak = Math.max(agg.streak, s.streak);
  }
  agg.project = lead.project;
  agg.turnToolCalls = lead.turnToolCalls;

  const live = (x) => now - x.lastEventAt < T.abandonMs;
  let s;
  if ((s = list.find((x) => x.waiting))) {
    agg.mood = 'waiting';
    agg.tool = s.tool;
  } else if ((s = list.find((x) => x.phase === 'error' && now - x.errorAt < T.errorMs))) {
    agg.mood = s.errorKind === 'rate_limit' ? 'exhausted' : 'panic';
  } else if (
    // 실패 직후에만 패닉. 그 뒤에 성공한 도구(streak>0)나 Stop 이 있었다면 더 최근 상태가 우선
    (s = list.find((x) => x.streak === 0 && x.lastFailureAt > x.doneAt && now - x.lastFailureAt < T.failureMs))
  ) {
    agg.mood = 'panic';
    agg.tool = s.tool;
  } else if ((s = list.find((x) => x.phase === 'working' && live(x)))) {
    agg.tool = s.tool;
    agg.mood = now - s.lastEventAt > T.workingStaleMs ? 'thinking' : s.flavor || 'typing';
  } else if ((s = list.find((x) => x.phase === 'thinking' && live(x)))) {
    agg.mood = 'thinking';
  } else if ((s = list.find((x) => x.phase === 'done' && now - x.doneAt < T.doneMs))) {
    agg.mood = s.turnToolCalls >= 10 ? 'celebrate_big' : 'celebrate';
  } else {
    agg.mood = lead.idleHint || now - lead.lastEventAt > T.sleepMs ? 'sleeping' : 'idle';
  }
  return agg;
}
