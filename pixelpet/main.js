const { app, BrowserWindow, ipcMain, screen, Menu, net, dialog } = require('electron');
const path = require('path');

// Windows DWM이 투명 창을 occluded로 오판정해 Chromium이 합성을 스킵하는 현상 방지.
// GPU 가속은 유지 — CPU 합성은 시스템 전반을 느리게 함.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Portable 모드: userData(localStorage·cache 등)를 .exe 옆으로 redirect → APPDATA 안 씀
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, '.pixelpet-data'));
}

// 메인 프로세스 미처리 예외 → 팝업/freeze 방지, 콘솔에만 기록
// (무조건 죽지 않게 — 사용자 앱 freeze 방지)
process.on('uncaughtException', (err) => {
  console.error('[main uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main unhandledRejection]', err);
});
// Electron의 기본 에러 dialog 비활성화 (위 핸들러가 처리)
dialog.showErrorBox = (title, content) => console.error('[dialog suppressed]', title, content);

// 시작 윈도우 크기 — URL 입력 화면에 맞춤. 펫 선택 후 renderer가 280×120으로 줄임.
const WIN_W = 360;
const WIN_H = 300;

let mainWindow = null;
let autoReloadFlag = false;  // true면 renderer가 init 시 자동 복원 (URL/선택 화면 skip)

// main이 트리거한 reload만 자동 복원 대상 — 일반 실행/재시작은 기존 UX 유지
function petReload() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  autoReloadFlag = true;
  mainWindow.reload();
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.floor(width / 2 - WIN_W / 2),
    y: Math.floor(height / 2 - WIN_H / 2),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,  // setInterval throttling 방지
    },
  });
  // macOS는 'pop-up-menu' level이 메뉴바 아래로 가버려서 'floating' 사용
  mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'pop-up-menu');
  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools({ mode: 'detach' });  // debug: uncomment to inspect renderer

  // 렌더러 크래시 감지 시 자동 reload — 투명 창이 "사라지는" 증상 복구
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details);
    petReload();
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[renderer unresponsive] reloading');
    petReload();
  });

  // DWM topmost recovery — Windows Shell이 TOPMOST 플래그를 제거할 때 복구.
  // clawd-on-desk 패턴 참고: 5초 주기 watchdog + 이벤트 리스너 조합.
  const topLevel = process.platform === 'darwin' ? 'floating' : 'pop-up-menu';

  // 이벤트 리스너 — Alt/Win 키나 focus 전환 시 Electron이 즉시 알려줌
  mainWindow.on('always-on-top-changed', (_e, isOnTop) => {
    if (!isOnTop && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(true, topLevel);
    }
  });

  // topmost 유지 watchdog — Shell이 silent하게 z-order를 내릴 때 복구.
  // 하우스 테두리 도입 후 DWM occlusion이 거의 발생하지 않아 30초 간격으로 완화.
  const topmostInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(topmostInterval); return; }
    try { mainWindow.setAlwaysOnTop(true, topLevel); } catch {}
  }, 30 * 1000);

  // Heartbeat — renderer가 crash/freeze 시 복구
  let lastPong = Date.now();
  ipcMain.on('renderer-pong', () => { lastPong = Date.now(); });
  const hbInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) { clearInterval(hbInterval); return; }
    mainWindow.webContents.send('renderer-ping');
    if (Date.now() - lastPong > 10000) {
      console.warn('[heartbeat] renderer silent >10s — reloading');
      petReload();
      lastPong = Date.now();
    }
  }, 3000);
}

ipcMain.handle('get-window-pos', () => {
  if (!mainWindow) return [0, 0];
  return mainWindow.getPosition();
});

ipcMain.on('set-window-pos', (_e, x, y) => {
  if (!mainWindow) return;
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;  // NaN/Infinity 방어
  const rx = Math.round(x), ry = Math.round(y);
  mainWindow.setPosition(rx, ry);
});

ipcMain.on('set-window-size', (_e, w, h) => {
  if (!mainWindow) return;
  w = Number(w); h = Number(h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
  mainWindow.setSize(Math.round(w), Math.round(h));
});

ipcMain.on('set-window-bounds', (_e, bounds) => {
  if (!mainWindow) return;
  const { x, y, width, height } = bounds || {};
  if (![x, y, width, height].every(Number.isFinite)) return;
  if (width < 1 || height < 1) return;
  try { mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }); } catch {}
});

ipcMain.handle('get-displays', () => {
  // 모니터 전체 (bounds) — 작업표시줄/도킹 영역도 펫이 자유롭게 사용 가능
  return screen.getAllDisplays().map(d => ({
    x: d.bounds.x, y: d.bounds.y,
    w: d.bounds.width, h: d.bounds.height,
  }));
});

ipcMain.on('show-menu', (_e, items) => {
  try {
    if (!Array.isArray(items)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const template = items.map((it) => {
      if (it && it.type === 'separator') return { type: 'separator' };
      return {
        label: String((it && it.label) || ''),
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('menu-click', it && it.id);
          }
        },
      };
    });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  } catch (e) {
    console.error('[show-menu] error:', e);
  }
});

ipcMain.on('quit-app', () => app.quit());

ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (ignore) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
});

ipcMain.handle('is-auto-reload', () => {
  const r = autoReloadFlag;
  autoReloadFlag = false;  // 한 번만 true — 다음 load부터는 일반 실행으로 간주
  return r;
});

ipcMain.handle('fetch-pets', async (_e, url) => {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url });
    req.setHeader('ngrok-skip-browser-warning', 'true');
    let data = '';
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('timeout'));
    }, 15000);
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearTimeout(timer);
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
