// ~/.claude/settings.json 에 붙여 넣을 hooks 설정을 출력한다. (파일을 직접 수정하지 않는다)
//   node tools/print-settings.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hookPath = path
  .resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook.mjs')
  .replace(/\\/g, '/'); // Windows: Git Bash 가 역슬래시를 먹어서 훅이 조용히 안 돌아가는 문제 방지

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
];

const entry = { hooks: [{ type: 'command', command: `node "${hookPath}"`, async: true }] };
const hooks = Object.fromEntries(EVENTS.map((e) => [e, [entry]]));
console.log(JSON.stringify({ hooks }, null, 2));
console.error(
  '\n# 위 JSON 의 "hooks" 항목을 ~/.claude/settings.json 에 병합하세요 (이미 hooks 가 있으면 이벤트별 배열에 추가).\n' +
    '# 적용 확인: Claude Code 에서 /hooks 입력, 문제 시 claude --debug-file <경로> 로 로그 확인.',
);
