# Agent Buddy

Claude Code가 일하는 동안 **Claude 데스크톱 창 하단에서 같이 일하는 "직장인 풍자" 캐릭터**입니다.
Claude Code 훅으로 에이전트 상태를 받아서, 파일을 고치면 메모하고, 승인을 기다리면 "결재 대기" 팻말을 들고, 에러가 나면 당황합니다.

![표정 모음](assets/sheet.jpg)

## 캐릭터가 하는 일

| Claude Code 상태 | 캐릭터 |
|---|---|
| 생각 중 | 머리 위 점 세 개 |
| 파일 읽기 | 안경 쓰고 책 읽기 |
| 파일 수정 | 메모장에 끄적끄적 |
| 터미널 명령 | 노트북 타이핑 |
| 웹 검색 | 돋보기 |
| 서브에이전트 | 양옆에 부하직원 등장 |
| MCP 도구 | 플러그 연결 |
| **승인 대기** | "결재 대기" 팻말 + 주황 말풍선 (승인할 때까지 유지) |
| 에러 | 땀 흘리며 허둥지둥 |
| 사용량 한도 | 백기 |
| 작업 완료 | 만세 + 색종이 (도구 10번 이상 쓰면 더 크게) |
| 한동안 조용함 | 꾸벅꾸벅 |

## 특징

- **Claude 창에만 붙어 있음**: Claude 창을 따라 움직이고, Claude가 맨 앞이 아니거나 최소화되면 숨습니다. 다른 작업을 가리지 않습니다.
- **작고 조용함**: 작업 중에는 말하지 않고 동작으로만 보여줍니다. 말풍선은 승인 대기·에러·한도·완료처럼 알아야 할 때만 뜹니다.
- **상태 점**: 작아도 한눈에 보이도록 캐릭터에 점을 하나 달았습니다. 초록은 작업 중, 주황은 승인 대기, 빨강은 에러, 회색은 쉬는 중입니다.
- **마우스 올리면 HUD**: 프로젝트 이름, 도구 호출 수, 실패 수, 토큰, "커피"(출력 5천 토큰당 1잔)를 한 줄로 보여줍니다.
- **끌어서 옮기기, 클릭하면 반응**: 놓은 위치는 기억합니다.
- **크기 3단계**: 트레이 아이콘에서 작게/보통/크게를 고를 수 있고, 고른 크기는 저장됩니다.
- **클릭 통과**: 캐릭터 위에서만 클릭을 받고, 나머지 영역은 클릭이 아래 Claude 창으로 넘어갑니다.
- **접근성**: 시스템의 "애니메이션 줄이기" 설정을 따릅니다.

## 구조

```
Claude Code 훅 (hook.mjs)
   │  POST /event  (이벤트명·도구명·프로젝트 폴더명만)
   ▼
로컬 서버 (server.mjs, 127.0.0.1:47821)  ── 상태 머신(lib/state.mjs) + 토큰 집계(lib/transcript.mjs)
   │  SSE /stream
   ▼
오버레이 (overlay/index.html)
   ├─ Electron 투명창 (electron/main.cjs) — Claude 창 하단에 붙음
   └─ 또는 아무 브라우저 탭
```

## 설치 (Windows, Node 20 이상)

```bash
git clone https://github.com/03jiho/agent-buddy.git
cd agent-buddy
npm install
```

> Node 24에서 `npm install` 뒤 Electron 실행 시 "Electron failed to install correctly"가 나면,
> Electron 압축 해제 라이브러리(extract-zip)가 Node 24에서 첫 파일만 풀고 멈추는 문제입니다.
> Node 22 LTS로 설치하거나, 아래처럼 캐시된 zip을 직접 풀면 됩니다 (PowerShell).
>
> ```powershell
> cd node_modules\electron
> $zip = Get-ChildItem "$env:LOCALAPPDATA\electron\Cache" -Recurse -Filter "electron-v*-win32-x64.zip" | Select-Object -First 1
> tar.exe -xf $zip.FullName -C dist
> Set-Content path.txt electron.exe -NoNewline
> ```

### 1. 훅 등록

```bash
node tools/print-settings.mjs
```

출력된 JSON의 `hooks`를 `~/.claude/settings.json`의 `hooks`에 **병합**합니다. 기존 설정은 지우지 말고, 먼저 백업해두세요.
도구는 파일을 직접 고치지 않습니다. 훅 경로는 `C:/...`처럼 슬래시여야 합니다(Git Bash가 역슬래시를 먹어서 훅이 조용히 안 돌 수 있음). 출력은 이미 슬래시로 나옵니다.

### 2. 서버 실행 (터미널 하나 켜두기)

```bash
node server.mjs
```

### 3. 오버레이 실행

```bash
npm run overlay
```

서버가 이미 떠 있으면 거기에 붙고, 없으면 자체로 띄웁니다. 종료는 트레이 아이콘 → 종료.

### 4. Claude Code 재시작

재시작해야 훅이 적용됩니다. 아무 작업이나 시키면 캐릭터가 반응합니다.

Electron 없이 보고 싶으면 브라우저로 http://127.0.0.1:47821/?bg=1 을 열어도 됩니다 (Claude 데스크톱 앱의 브라우저 패널에 띄워도 됩니다).

## 미리보기 URL

| 주소 | 내용 |
|---|---|
| `/?sheet=1` | 모든 표정 한눈에 |
| `/?demo=1` | 자동 데모 (숫자키 1~9로 표정 강제) |
| `/?mood=waiting` | 특정 상태 고정 |
| `/?size=s` · `m` · `l` | 캐릭터 크기 (56 / 72 / 96px) |
| `/?hud=1` | HUD 항상 표시 |
| `/?bg=1` | 밝은 배경 (투명 대신) |

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AGENT_BUDDY_PORT` | `47821` | 서버 포트 (훅·서버·오버레이 공통) |
| `AGENT_BUDDY_BOTTOM_OFFSET` | `100` | Claude 창 하단에서 몇 px 위에 띄울지 (입력창 위) |
| `AGENT_BUDDY_TARGET` | `claude` | 따라갈 창의 프로세스 이름 |

## 문제 해결

- **캐릭터가 안 움직임**: 서버가 떠 있는지 http://127.0.0.1:47821/health 로 확인 → 이벤트가 들어오는지 `/events/recent` 확인 → Claude Code에서 `/hooks`로 등록 확인 → `claude --debug-file log.txt`로 훅 실행 로그 확인.
- **훅은 등록됐는데 이벤트가 없음**: 훅 command 경로에 역슬래시가 있는지 확인.
- **오버레이가 안 보임**: Claude 창이 맨 앞에 있어야 보입니다. 다른 창을 클릭하면 숨는 게 정상입니다.

## 프라이버시

- 훅은 프롬프트, 도구 입력·출력을 보내지 않습니다. 이벤트명, 도구명, 프로젝트 폴더명 등만 보냅니다.
- 서버는 127.0.0.1에만 바인딩하고, Host/Origin 검사와 64KB 요청 제한을 합니다.
- 토큰 수는 훅 입력에 없어서 transcript(`~/.claude` 아래 `.jsonl`만)의 usage 숫자만 읽어 집계합니다.

## 테스트

```bash
npm test
```

7개: 상태 머신, 토큰 집계, 훅→서버 통합 및 민감 정보 유출 검사, 서버가 꺼져 있을 때 훅이 조용하고 빠르게 끝나는지, HTTP 가드, SSE.

## 참고한 앱

- **Bongo Cat**: 작고 거슬리지 않게, 반응만 → 작은 크기, 작업 중엔 말 없이
- **Desktop Mate / Shimeji**: 끌어서 옮기기, 클릭 반응, 크기 선택 (동작 방식만 참고, 캐릭터는 자체 제작)
- **Clippy** (반면교사): 원치 않을 때 끼어들지 않기 → 말풍선은 필요한 순간에만
- **Clawd on Desk, ClaudePet, claude-buddy** 등 Claude Code 펫: 승인 대기 강조, 상태 색 표시

## 한계

- Claude 창 추적은 Windows 전용입니다. PowerShell로 0.2초마다 창 위치를 읽어서, 창을 끌 때 약간 늦게 따라옵니다.
- 프로토타입입니다.
