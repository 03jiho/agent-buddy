// 플러그인 아이콘(.claude-plugin/icon.png, 1024x1024)을 오버레이의 캐릭터 SVG 그대로 렌더링해서 만든다.
//   npm run plugin-icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.claude-plugin', 'icon.png');
const S = 1024;

const html = fs.readFileSync(path.join(ROOT, 'overlay', 'index.html'), 'utf8');
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const buddy = html
  .match(/<template id="tpl">([\s\S]*?)<\/template>/)[1]
  .replace('data-mood="idle"', 'data-mood="typing"') // 노트북 두드리는 모습 = "같이 코딩하는 동료"
  .replace(/<\/div>\s*$/, '<span class="dot"></span></div>');

const page = `<!doctype html><meta charset="utf-8"><style>${style}
  *, *::before, *::after { animation: none !important; transition: none !important; }
  html, body { width: ${S}px; height: ${S}px; margin: 0; overflow: hidden;
    background: radial-gradient(circle at 50% 40%, #fffaf0 0%, #ffeccb 62%, #ffd9a0 100%); }
  /* SVG 위쪽은 소품용 여백이라 박스를 위로 올려야 캐릭터가 가운데 온다 */
  .icon { position: absolute; left: 50%; top: 40%; width: 880px; height: 880px; transform: translate(-50%, -50%); --size: 880px; }
  .icon .buddy { position: static; width: 100%; height: 100%; }
  .icon .buddy svg { filter: none; }
  .icon .m { display: none !important; }
  .icon .m-smile { display: inline !important; } /* 아이콘은 웃는 얼굴로 */
  .icon .dot { width: 104px; height: 104px; border-width: 16px; top: 15%; right: 14%; box-shadow: 0 0 0 6px rgba(0,0,0,.18); }
</style><div class="icon">${buddy}</div>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: S, height: S, useContentSize: true, show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: S, height: S });
  fs.writeFileSync(OUT, img.resize({ width: S, height: S }).toPNG());
  console.log(`wrote ${path.relative(ROOT, OUT)} (${S}x${S})`);
  app.quit();
});
