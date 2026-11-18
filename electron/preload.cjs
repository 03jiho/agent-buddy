// 오버레이 페이지에 딱 하나만 노출: 캐릭터 위에 마우스가 있을 때만 클릭을 받도록 전환.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('buddy', {
  setClickable: (on) => ipcRenderer.send('buddy:clickable', on === true),
});
