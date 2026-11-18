// 투명 오버레이 래퍼 (Windows 대상). 이 샌드박스(Linux)에서는 실행 검증을 못 했습니다 — README 참고.
// Claude 데스크톱 창 하단에 붙는 클릭 통과 투명 창. Claude 가 맨 앞에 있을 때만 보인다.
const { app, BrowserWindow, Menu, Tray, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

let win = null;
let tray = null;
let protect = false; // 화면 공유/캡처에서 숨기기 (Windows: 캡처 제외)
let quitting = false;

// 크기 = 캐릭터(56/72/96px) + 말풍선 공간. 페이지의 ?size= 와 짝을 이룬다.
const SIZES = { s: { label: '작게', h: 110 }, m: { label: '보통', h: 126 }, l: { label: '크게', h: 154 } };
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
let size = 's';
let pageUrl = '';
let lastRect = null; // 마지막으로 받은 Claude 창 위치 (크기 바꿀 때 재배치용)
const BOTTOM_OFFSET = Number(process.env.AGENT_BUDDY_BOTTOM_OFFSET ?? 100); // Claude 입력창(창 하단에서 ~85px) 위로 올리기(px)
const TARGET = process.env.AGENT_BUDDY_TARGET || 'claude'; // 따라갈 프로세스 이름

// Claude 창 위치/전면 여부를 200ms 마다 JSON 한 줄로 출력 (변할 때만). 물리 픽셀 기준.
// ponytail: 폴링 방식이라 창을 끌 때 최대 ~200ms 늦게 따라감. 거슬리면 SetWinEventHook 으로 교체.
const PS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
}
"@
[W]::SetProcessDPIAware() | Out-Null
$last = ''
while ($true) {
  $out = '{"show":false}'
  $p = Get-Process -Name '${TARGET}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $h = $p.MainWindowHandle
    $fp = [uint32]0
    [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$fp) | Out-Null
    if ($fp -eq $p.Id -and -not [W]::IsIconic($h) -and [W]::IsWindowVisible($h)) {
      $r = New-Object W+R
      [W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
      $out = '{{"show":true,"x":{0},"y":{1},"w":{2},"h":{3}}}' -f $r.L, $r.T, ($r.Ri - $r.L), ($r.B - $r.T)
    }
  }
  if ($out -ne $last) { [Console]::Out.WriteLine($out); [Console]::Out.Flush(); $last = $out }
  Start-Sleep -Milliseconds 200
}
`;

function place(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!win) return;
  if (!m.show) return win.hide();
  lastRect = screen.screenToDipRect(null, { x: m.x, y: m.y, width: m.w, height: m.h });
  applyBounds();
  if (!win.isVisible()) win.showInactive();
}

function applyBounds() {
  if (!win || !lastRect) return;
  const h = SIZES[size].h;
  win.setBounds({
    x: Math.round(lastRect.x),
    y: Math.round(lastRect.y + lastRect.height - h - BOTTOM_OFFSET),
    width: Math.round(lastRect.width),
    height: h,
  });
}

function setSize(next) {
  size = next;
  try { fs.writeFileSync(prefsFile(), JSON.stringify({ size })); } catch {}
  applyBounds();
  win?.loadURL(`${pageUrl}?size=${size}`);
}

// 캐릭터 위에 마우스가 있을 때만 클릭을 받고, 나머지는 아래 Claude 창으로 통과시킨다.
// Windows 에서 setIgnoreMouseEvents 의 forward(마우스 이동 전달)가 안 와서, 커서 위치를 여기서 직접 본다.
// ponytail: 40ms 폴링. 커서 판정만 하는 가벼운 작업이라 충분, 거슬리면 전역 마우스 훅으로 교체.
let hit = null; // 페이지가 알려준 캐릭터 영역 (창 기준 CSS px)
let dragging = false;
let clickable = false;
const fromPage = (e) => win && e.sender === win.webContents;
ipcMain.on('buddy:hit', (e, r) => { if (fromPage(e)) hit = r; });
ipcMain.on('buddy:drag', (e, on) => { if (fromPage(e)) dragging = on === true; });

function setClickable(on) {
  if (on === clickable || !win) return;
  clickable = on;
  if (on) win.setIgnoreMouseEvents(false); // forward 옵션을 같이 주면 Windows 에서 입력이 계속 막힘
  else win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.send('buddy:hover', on);
}

setInterval(() => {
  if (!win || !hit || !win.isVisible()) return setClickable(false);
  const p = screen.getCursorScreenPoint();
  const b = win.getContentBounds();
  const x = p.x - b.x, y = p.y - b.y, pad = 4;
  setClickable(dragging || (x >= hit.x - pad && x <= hit.x + hit.w + pad && y >= hit.y - pad && y <= hit.y + hit.h + pad));
}, 40);

function followTarget() {
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')],
    { windowsHide: true },
  );
  let buf = '';
  ps.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      place(buf.slice(0, i).trim());
      buf = buf.slice(i + 1);
    }
  });
  ps.on('exit', () => !quitting && setTimeout(followTarget, 2000)); // 죽으면 재시작
  app.once('will-quit', () => ps.kill());
}

async function createWindow(port) {
  // Windows 투명 창은 클릭 판정 영역이 "처음 만든 크기"에 고정된다(나중에 setBounds 로 키워도 그대로).
  // 그래서 가장 큰 크기(가장 넓은 화면 폭 × 큰 사이즈 높이)로 만들고 줄여서만 쓴다.
  const maxW = Math.max(...screen.getAllDisplays().map((d) => d.workArea.width));
  const maxH = Math.max(...Object.values(SIZES).map((s) => s.h));
  win = new BrowserWindow({
    width: maxW,
    height: maxH,
    show: false, // Claude 창을 찾으면 그때 보인다
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false, // 포커스를 뺏지 않는다
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      backgroundThrottling: false, // 가려졌다고 판단돼도 계속 그린다
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // 클릭 통과
  win.setContentProtection(protect);
  pageUrl = `http://127.0.0.1:${port}/`;
  await win.loadURL(`${pageUrl}?size=${size}`);
}

function buildTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray.setToolTip('agent-buddy');
  const menu = () =>
    Menu.buildFromTemplate([
      ...Object.entries(SIZES).map(([k, v]) => ({
        label: `크기: ${v.label}`,
        type: 'radio',
        checked: size === k,
        click: () => setSize(k),
      })),
      { type: 'separator' },
      {
        label: '화면 공유/캡처에서 숨기기',
        type: 'checkbox',
        checked: protect,
        click: (item) => {
          protect = item.checked;
          if (win) win.setContentProtection(protect);
        },
      },
      { label: '다시 불러오기', click: () => win && win.reload() },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
}

// 이미 server.mjs 가 떠 있으면(터미널에서 따로 띄운 경우) 그 서버에 붙고, 없으면 여기서 띄운다.
async function ensureServer() {
  const port = Number(process.env.AGENT_BUDDY_PORT || 47821);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    if (r.ok) return port;
  } catch {}
  const { start } = await import('../server.mjs');
  return (await start()).port;
}

if (!app.requestSingleInstanceLock()) app.quit(); // 중복 실행 방지

// Windows: Chromium 이 투명·최상위 창을 "가려졌다"고 오판해서 그리기를 멈춘다(visibilityState=hidden).
// 그러면 화면엔 옛 프레임이 남고, 클릭 판정도 옛 프레임 기준이라 쓰다듬기·드래그가 안 된다.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  try { size = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).size; } catch {}
  if (!SIZES[size]) size = 's';
  const port = await ensureServer();
  await createWindow(port);
  buildTray();
  followTarget();
});

app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => app.quit());
