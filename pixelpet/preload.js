const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  getWindowPos: () => ipcRenderer.invoke('get-window-pos'),
  setWindowPos: (x, y) => ipcRenderer.send('set-window-pos', x, y),
  setWindowSize: (w, h) => ipcRenderer.send('set-window-size', w, h),
  setWindowBounds: (b) => ipcRenderer.send('set-window-bounds', b),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  showMenu: (items) => ipcRenderer.send('show-menu', items),
  onMenuClick: (cb) => ipcRenderer.on('menu-click', (_e, id) => cb(id)),
  quit: () => ipcRenderer.send('quit-app'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  fetchPets: (url) => ipcRenderer.invoke('fetch-pets', url),
  isAutoReload: () => ipcRenderer.invoke('is-auto-reload'),
  onRendererPing: (cb) => ipcRenderer.on('renderer-ping', () => cb()),
  sendRendererPong: () => ipcRenderer.send('renderer-pong'),
  serverUrl: process.env.PIXELPET_SERVER || null,
});
