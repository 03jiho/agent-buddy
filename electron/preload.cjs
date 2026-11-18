// 오버레이 페이지 ↔ 메인 프로세스 연결. 클릭 통과 판정은 메인이 커서 위치로 직접 한다.
const { contextBridge, ipcRenderer } = require('electron');

const num = (v) => (Number.isFinite(v) ? v : 0);

contextBridge.exposeInMainWorld('buddy', {
  // 캐릭터가 있는 영역 (창 기준 CSS px). 이 영역 위에서만 클릭을 받는다.
  setHitRect: (r) => ipcRenderer.send('buddy:hit', { x: num(r?.x), y: num(r?.y), w: num(r?.w), h: num(r?.h) }),
  // 끄는 동안엔 커서가 영역을 벗어나도 클릭 통과로 바꾸지 않는다.
  setDragging: (on) => ipcRenderer.send('buddy:drag', on === true),
  // 커서가 캐릭터 위에 올라왔는지/떠났는지 (메인 판정)
  onHover: (cb) => ipcRenderer.on('buddy:hover', (_e, on) => cb(on === true)),
});
