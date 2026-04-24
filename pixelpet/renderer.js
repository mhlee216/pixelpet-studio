const SPRITE_W = 20, SPRITE_H = 14, SCALE = 3;
const TICK_MS = 200;
// 펫 창은 "하우스" 박스 — 사용자가 창 자체를 drag로 옮기고, 스프라이트는 창 내부에서만 이동.
// DWM occlusion 완화를 위해 창 크기를 넉넉히.
const PET_WIN_W_DEFAULT = 400, PET_WIN_H_DEFAULT = 300;
let PET_WIN_W = PET_WIN_W_DEFAULT, PET_WIN_H = PET_WIN_H_DEFAULT;  // 전체화면 토글로 변경됨
const PET_SPRITE_W = SPRITE_W * SCALE, PET_SPRITE_H = SPRITE_H * SCALE;
const HOUSE_MARGIN = 20;
const SELECT_WIN_W = 340, SELECT_WIN_H = 280;
// 매 실행마다 URL/캐릭터 새로 선택 (자동 진입 X)
// URL 히스토리만 저장 — datalist 자동완성용. 자동 연결은 안 됨.
// (env 변수 PIXELPET_SERVER가 있으면 dev override로만 사용)
// console.log('[pixelpet] script start, window.pet:', typeof window.pet);  // debug
let SERVER_URL = (window.pet && window.pet.serverUrl) || null;
// console.log('[pixelpet] SERVER_URL:', SERVER_URL);  // debug

const LS_URLS_KEY = 'pixelpet_url_history';
const LS_LAST_PET_KEY = 'pixelpet_last_pet_id';
const URL_HISTORY_MAX = 10;

function loadUrlHistory() {
  try { return JSON.parse(localStorage.getItem(LS_URLS_KEY) || '[]'); }
  catch { return []; }
}

function saveUrlToHistory(url) {
  try {
    const urls = loadUrlHistory();
    const updated = [url, ...urls.filter(u => u !== url)].slice(0, URL_HISTORY_MAX);
    localStorage.setItem(LS_URLS_KEY, JSON.stringify(updated));
  } catch {}
}

// 마지막 선택한 pet ID — heartbeat reload 시 자동 복원용
function loadLastPetId() {
  try { return localStorage.getItem(LS_LAST_PET_KEY) || null; } catch { return null; }
}
function saveLastPetId(id) {
  try { localStorage.setItem(LS_LAST_PET_KEY, id); } catch {}
}

function populateUrlHistory() {
  const datalist = document.getElementById('urlHistory');
  if (!datalist) return;
  const urls = loadUrlHistory();
  datalist.innerHTML = '';
  for (const u of urls) {
    const opt = document.createElement('option');
    opt.value = u;
    datalist.appendChild(opt);
  }
  const clearBtn = document.getElementById('clearHistory');
  if (clearBtn) clearBtn.classList.toggle('hidden', urls.length === 0);
}

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const bubbleEl = document.getElementById('bubble');
const statusEl = document.getElementById('status');
const selectScreen = document.getElementById('selectScreen');
const selectGrid = document.getElementById('selectGrid');
const selectError = document.getElementById('selectError');
const serverScreen = document.getElementById('serverScreen');
const serverInput = document.getElementById('serverInput');
const serverConnect = document.getElementById('serverConnect');
const serverError = document.getElementById('serverError');

let pets = [];
let activePet = null;
let isOfflineMode = false;  // 서버 실패로 캐시 사용 중인지
let state = 'idle';            // idle | walk | sit | sleep | run
let frameIdx = 0;
let facingRight = true;
let targetX = 0, targetY = 0;    // 창 내부 좌표 (spriteX/Y 기준)
let spriteX = 0, spriteY = 0;    // 스프라이트 창 내부 위치 (좌상단 기준)
let winX = 0, winY = 0;          // 창의 OS 좌표 (drag 시에만 갱신)
let displays = [{ x: 0, y: 0, w: 1920, h: 1080 }];
let dragging = false;
let dragStart = null;
let winStartPos = null;
let mouseDownOnCanvas = false;
let lastClick = 0;
let stateTimer = 0;
let idleBubbleTimer = 0;
let bubbleTimer = null;
let animAcc = 0;
let mainLoopInterval = null;
let offScreenTicks = 0;
// home = 하우스 창 내부 중앙 — 창 크기 바뀔 때마다 재계산
let homeX = (PET_WIN_W - PET_SPRITE_W) / 2;
let homeY = (PET_WIN_H - PET_SPRITE_H) / 2;
let WANDER_RADIUS = Math.floor(Math.min(PET_WIN_W, PET_WIN_H) * 0.4);
let isFullscreen = false;
let savedBounds = null;  // 전체화면 진입 전 원래 크기·위치 기억

// ─── 서버 ───
// 서버별로 캐시 키 분리 — 여러 Studio 서버 사용해도 충돌 없음.
const PETS_CACHE_PREFIX = 'pixelpet_cached_pets:';
function petsCacheKey() { return PETS_CACHE_PREFIX + (SERVER_URL || ''); }
function saveCachedPets(arr) {
  try { localStorage.setItem(petsCacheKey(), JSON.stringify(arr)); } catch {}
}
function loadCachedPets() {
  try { return JSON.parse(localStorage.getItem(petsCacheKey()) || '[]'); }
  catch { return []; }
}

async function loadPets() {
  if (!SERVER_URL) return false;
  try {
    pets = await window.pet.fetchPets(
      SERVER_URL.replace(/\/$/, '') + '/api/pets');
    if (Array.isArray(pets) && pets.length) {
      saveCachedPets(pets);  // 성공 시 캐시 갱신
      isOfflineMode = false;
      return true;
    }
    // 서버는 응답했지만 승인된 캐릭터 없음 → 캐시 fallback
    const cached = loadCachedPets();
    if (cached.length) {
      pets = cached;
      isOfflineMode = true;
      statusEl.textContent = '서버에 승인된 캐릭터 없음 — 캐시 사용';
      return true;
    }
    statusEl.textContent = '승인된 캐릭터 없음';
    return false;
  } catch (e) {
    // 서버 연결 실패 → 캐시 fallback
    const cached = loadCachedPets();
    if (cached.length) {
      pets = cached;
      isOfflineMode = true;
      statusEl.textContent = '오프라인 — 이전 캐시된 캐릭터 사용';
      return true;
    }
    statusEl.textContent = '서버 연결 실패';
    return false;
  }
}

// ─── 서버 입력 화면 ───
function showServerScreen() {
  stopMainLoop();
  canvas.classList.add('hidden');
  document.getElementById('petHouse').classList.add('hidden');
  ['edgeT','edgeB','edgeL','edgeR','edgeTL','edgeTR','edgeBL','edgeBR'].forEach(id => document.getElementById(id).classList.add('hidden'));
  bubbleEl.classList.add('hidden');
  selectScreen.classList.add('hidden');
  statusEl.classList.add('hidden');
  serverScreen.classList.remove('hidden');
  serverInput.value = SERVER_URL || '';
  serverError.classList.add('hidden');
  populateUrlHistory();
  window.pet.setWindowSize(SELECT_WIN_W, SELECT_WIN_H);
  window.pet.setIgnoreMouse(false);  // 입력 화면에선 전체 클릭 받기
  setTimeout(() => serverInput.focus(), 50);
}

async function tryConnectServer(rawUrl) {
  // 사용자가 실수로 `/api/pets`까지 붙여 넣어도 자동 제거
  const url = rawUrl.trim().replace(/\/api\/pets\/?$/, '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(url)) {
    serverError.textContent = 'URL은 http:// 또는 https://로 시작해야 합니다';
    serverError.style.color = '';
    serverError.classList.remove('hidden');
    return;
  }
  serverError.textContent = '연결 중...';
  serverError.style.color = '#666';
  serverError.classList.remove('hidden');
  serverConnect.disabled = true;
  serverInput.disabled = true;
  try {
    const result = await window.pet.fetchPets(url + '/api/pets');
    if (!Array.isArray(result)) throw new Error('invalid response');
    SERVER_URL = url;
    saveUrlToHistory(url);
    serverScreen.classList.add('hidden');
    init();
  } catch (e) {
    // 서버 실패 시 해당 URL의 캐시 fallback — 오프라인에서도 이전 캐릭터 사용
    SERVER_URL = url;  // 캐시 키 결정용
    if (loadCachedPets().length) {
      saveUrlToHistory(url);
      serverScreen.classList.add('hidden');
      init();  // loadPets가 캐시 fallback으로 selectScreen까지 진행
    } else {
      SERVER_URL = null;  // 복원
      serverError.textContent = '서버 연결 실패. URL을 확인하세요.';
      serverError.style.color = '';
    }
  } finally {
    serverConnect.disabled = false;
    serverInput.disabled = false;
  }
}

serverConnect.addEventListener('click', () => tryConnectServer(serverInput.value));
serverInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryConnectServer(serverInput.value);
});

document.getElementById('serverClose').addEventListener('click', () => window.pet.quit());
document.getElementById('selectClose').addEventListener('click', () => window.pet.quit());

document.getElementById('clearHistory').addEventListener('click', () => {
  try { localStorage.removeItem(LS_URLS_KEY); } catch {}
  populateUrlHistory();  // 비활성 표시 + datalist 비움
});

// ─── 스프라이트 ───
function drawFrameTo(destCtx, frame, flip, scale) {
  destCtx.clearRect(0, 0, SPRITE_W * scale, SPRITE_H * scale);
  if (!frame) return;
  destCtx.imageSmoothingEnabled = false;
  for (let y = 0; y < SPRITE_H; y++) {
    const row = frame[y];
    if (!row) continue;
    for (let x = 0; x < SPRITE_W; x++) {
      const c = COLORS[row[x]];
      if (!c) continue;
      const dx = flip ? (SPRITE_W - 1 - x) : x;
      destCtx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      destCtx.fillRect(dx * scale, y * scale, scale, scale);
    }
  }
}

function drawFrame(frame, flip) {
  drawFrameTo(ctx, frame, flip, SCALE);
}

function shouldFlip() {
  if (facingRight) return false;
  if (!activePet) return false;
  const af = activePet.allow_flip;
  if (af === undefined || af === true) return true;
  if (af === false) return false;
  if (typeof af === 'object') return af[stateGroup()] !== false;
  return true;
}

function stateGroup() {
  if (state === 'run') return 'walk';
  return state;
}

function currentFrames() {
  const prefix = stateGroup().toUpperCase();
  return [activePet.frames[prefix + '_0'], activePet.frames[prefix + '_1']];
}

function animSpeed() {
  return (activePet.anim_speeds && activePet.anim_speeds[stateGroup()]) || 500;
}

// ─── 상태 ───
function changeState(s) {
  state = s;
  frameIdx = 0;
  stateTimer = 0;
  idleBubbleTimer = 0;
  animAcc = 0;
  if (s === 'walk' || s === 'run') pickTarget();
}

// 창이 화면 안에 있는지 — 사용자가 drag로 창을 화면 밖에 던진 경우 감지용
function isWindowVisible() {
  const cx = winX + PET_WIN_W / 2;
  const cy = winY + PET_WIN_H / 2;
  return displays.some(d =>
    cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h);
}

// 창 중앙이 있는 모니터 반환 — 선택 창 중앙 배치용
function getCurrentMonitor() {
  const cx = winX + PET_WIN_W / 2;
  const cy = winY + PET_WIN_H / 2;
  for (const d of displays) {
    if (cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h) return d;
  }
  return displays[0];
}

function updateSpritePos() {
  canvas.style.left = Math.round(spriteX) + 'px';
  canvas.style.top = Math.round(spriteY) + 'px';
  // 말풍선이 표시 중이면 펫 머리 위로 같이 따라오게
  if (!bubbleEl.classList.contains('hidden')) {
    const cr = canvas.getBoundingClientRect();
    const br = bubbleEl.getBoundingClientRect();
    bubbleEl.style.top = (cr.top - br.height - 4) + 'px';
    bubbleEl.style.left = (cr.left + cr.width / 2) + 'px';
  }
}

// 하우스 크기 변경 — home과 WANDER_RADIUS 재계산, 창 크기도 반영
function setHouseSize(w, h) {
  PET_WIN_W = w;
  PET_WIN_H = h;
  homeX = (w - PET_SPRITE_W) / 2;
  homeY = (h - PET_SPRITE_H) / 2;
  WANDER_RADIUS = Math.floor(Math.min(w, h) * 0.4);
  window.pet.setWindowSize(w, h);
  spriteX = homeX;
  spriteY = homeY;
  updateSpritePos();
}

async function toggleFullscreen() {
  if (!activePet) return;
  if (!isFullscreen) {
    const [wx, wy] = await window.pet.getWindowPos();
    savedBounds = { x: wx, y: wy, w: PET_WIN_W, h: PET_WIN_H };
    const ds = await window.pet.getDisplays();
    if (Array.isArray(ds) && ds.length) displays = ds;
    const cx = wx + PET_WIN_W / 2;
    const cy = wy + PET_WIN_H / 2;
    let m = displays[0];
    for (const d of displays) {
      if (cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h) { m = d; break; }
    }
    winX = m.x; winY = m.y;
    window.pet.setWindowPos(winX, winY);
    setHouseSize(m.w, m.h);
    isFullscreen = true;
  } else {
    const b = savedBounds || { x: winX, y: winY, w: PET_WIN_W_DEFAULT, h: PET_WIN_H_DEFAULT };
    winX = b.x; winY = b.y;
    window.pet.setWindowPos(winX, winY);
    setHouseSize(b.w, b.h);
    isFullscreen = false;
  }
}

function pickTarget() {
  // 창 내부 좌표계 드리프트: home(창 중앙)에서 멀수록 귀환 확률 ↑
  const minX = HOUSE_MARGIN;
  const maxX = PET_WIN_W - PET_SPRITE_W - HOUSE_MARGIN;
  const minY = HOUSE_MARGIN;
  const maxY = PET_WIN_H - PET_SPRITE_H - HOUSE_MARGIN;
  const dx = spriteX - homeX;
  const dy = spriteY - homeY;
  const dist = Math.hypot(dx, dy);
  const homeBias = Math.min(1, dist / WANDER_RADIUS);

  let angle;
  if (Math.random() < homeBias) {
    angle = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * (Math.PI / 2);
  } else {
    angle = Math.random() * Math.PI * 2;
  }

  const moveDist = 40 + Math.random() * 80;
  targetX = Math.round(Math.max(minX, Math.min(maxX, spriteX + Math.cos(angle) * moveDist)));
  targetY = Math.round(Math.max(minY, Math.min(maxY, spriteY + Math.sin(angle) * moveDist)));
  facingRight = targetX < spriteX;
}

function randomStateChange() {
  const r = Math.random();
  if (r < 0.38) changeState('idle');
  else if (r < 0.68) changeState('walk');
  else if (r < 0.76) changeState('run');   // 8% — 가끔 자발 run (짧게 달림)
  else if (r < 0.95) changeState('sit');
  else changeState('sleep');  // 5% — 가끔만 잠듦
  if (Math.random() < 0.4) showRandomBubble(state);
}

// ─── 이동 ───
function tickMovement() {
  if (state !== 'walk' && state !== 'run') return;
  const speed = state === 'run' ? 20 : 6;
  const dx = targetX - spriteX;
  const dy = targetY - spriteY;
  const dist = Math.hypot(dx, dy);
  if (dist < speed) {
    spriteX = targetX;
    spriteY = targetY;
    updateSpritePos();
    changeState('idle');
    return;
  }
  spriteX = spriteX + (dx / dist) * speed;
  spriteY = spriteY + (dy / dist) * speed;
  if (Number.isFinite(spriteX) && Number.isFinite(spriteY)) {
    updateSpritePos();
  }
  facingRight = dx < 0;
}

// ─── 말풍선 ───
// 말풍선 max-width(240px) - padding/border(~16px) = 약 224px의 텍스트 영역
const BUBBLE_TEXT_MAX_PX = 220;
const BUBBLE_FONT = '12px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
let _bubbleMeasureCtx = null;

function fitBubbleText(text) {
  if (!_bubbleMeasureCtx) {
    _bubbleMeasureCtx = document.createElement('canvas').getContext('2d');
  }
  _bubbleMeasureCtx.font = BUBBLE_FONT;
  if (_bubbleMeasureCtx.measureText(text).width <= BUBBLE_TEXT_MAX_PX) return text;
  // 이진 탐색 — 들어가는 가장 긴 prefix + '…'
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (_bubbleMeasureCtx.measureText(text.slice(0, mid) + '…').width <= BUBBLE_TEXT_MAX_PX) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function showBubble(text, thought, durationMs) {
  text = fitBubbleText(text);
  bubbleEl.textContent = text;
  bubbleEl.className = thought ? 'bubble thought' : 'bubble';
  // 캔버스 바로 위에 배치 (4px 위, 가로 중앙)
  const cr = canvas.getBoundingClientRect();
  const br = bubbleEl.getBoundingClientRect();
  bubbleEl.style.top = (cr.top - br.height - 4) + 'px';
  bubbleEl.style.left = (cr.left + cr.width / 2) + 'px';
  if (bubbleTimer) clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubbleEl.classList.add('hidden'), durationMs);
}

const BUBBLE_FALLBACK = { run: 'walk', pet: 'idle', feed: 'pet' };

function showRandomBubble(key) {
  if (!activePet.dialogues) return;
  let dl = activePet.dialogues[key] || [];
  if (!dl.length && BUBBLE_FALLBACK[key]) {
    dl = activePet.dialogues[BUBBLE_FALLBACK[key]] || [];
  }
  if (!dl.length) return;
  const raw = dl[Math.floor(Math.random() * dl.length)];
  const thought = raw.startsWith('(') && raw.endsWith(')');
  const text = thought ? raw.slice(1, -1) : raw;
  showBubble(text, thought, 2500);
}

// ─── 점프 애니메이션 ───
function triggerJump() {
  canvas.classList.remove('jump');
  void canvas.offsetWidth; // force reflow
  canvas.classList.add('jump');
  setTimeout(() => canvas.classList.remove('jump'), 400);
}

// ─── 입력 ───
// dragMode: 'window'(Shift+drag, 창 이동) | 'sprite'(기본, 펫만 창 내부 이동) | 'resize'(테두리 drag)
let dragMode = null;
let petDragOffset = null;
let resizeStartBounds = null;
let resizeDir = null;

const MIN_HOUSE_W = 300, MIN_HOUSE_H = 220;
const MAX_HOUSE_W = 3840, MAX_HOUSE_H = 2160;

canvas.addEventListener('mousedown', async (e) => {
  if (e.button === 2) {
    const interactionItems = state === 'sleep'
      ? []
      : [
          { id: 'feed', label: '밥주기' },
          { id: 'pet', label: '쓰다듬기' },
          { type: 'separator' },
        ];
    window.pet.showMenu([
      ...interactionItems,
      { id: 'switch', label: '캐릭터 변경' },
      { type: 'separator' },
      { id: 'fullscreen', label: isFullscreen ? '기본 크기로' : '전체화면' },
      { id: 'quit', label: '종료' },
    ]);
    return;
  }
  mouseDownOnCanvas = true;
  if (e.shiftKey) {
    // Shift + drag → 창 전체 이동 (화면 좌표 기준)
    dragMode = 'window';
    const [wx, wy] = await window.pet.getWindowPos();
    winStartPos = [wx, wy];
    dragStart = [e.screenX, e.screenY];
  } else {
    // 기본 drag → 펫을 창 내부에서 이동 (창 고정)
    dragMode = 'sprite';
    petDragOffset = [e.clientX - spriteX, e.clientY - spriteY];
    dragStart = [e.clientX, e.clientY];
  }
  dragging = false;
});

// 테두리 resize 시작 — edge strip의 mousedown이 호출
function startResize(dir, e) {
  dragMode = 'resize';
  resizeDir = dir;
  resizeStartBounds = { x: winX, y: winY, w: PET_WIN_W, h: PET_WIN_H, sx: spriteX, sy: spriteY };
  dragStart = [e.screenX, e.screenY];
  dragging = true;
  changeState('idle');
}

// resize는 60Hz+ mousemove가 IPC 큐를 쌓아 지연 유발 — requestAnimationFrame으로 1 frame에 1회로 묶음
let pendingResizeE = null;
let resizeRAF = null;
function scheduleResize(e) {
  pendingResizeE = e;
  if (resizeRAF) return;
  resizeRAF = requestAnimationFrame(() => {
    resizeRAF = null;
    const ev = pendingResizeE;
    pendingResizeE = null;
    if (ev && dragMode === 'resize') applyResize(ev);
  });
}

function applyResize(e) {
  const dx = e.screenX - dragStart[0];
  const dy = e.screenY - dragStart[1];
  let { x, y, w, h } = resizeStartBounds;
  if (resizeDir.includes('r')) w += dx;
  if (resizeDir.includes('l')) { x += dx; w -= dx; }
  if (resizeDir.includes('b')) h += dy;
  if (resizeDir.includes('t')) { y += dy; h -= dy; }
  if (w < MIN_HOUSE_W) { if (resizeDir.includes('l')) x -= (MIN_HOUSE_W - w); w = MIN_HOUSE_W; }
  if (h < MIN_HOUSE_H) { if (resizeDir.includes('t')) y -= (MIN_HOUSE_H - h); h = MIN_HOUSE_H; }
  w = Math.min(MAX_HOUSE_W, w);
  h = Math.min(MAX_HOUSE_H, h);
  window.pet.setWindowBounds({ x, y, width: w, height: h });
  const winDX = x - resizeStartBounds.x;
  const winDY = y - resizeStartBounds.y;
  winX = x; winY = y;
  PET_WIN_W = w; PET_WIN_H = h;
  homeX = (w - PET_SPRITE_W) / 2;
  homeY = (h - PET_SPRITE_H) / 2;
  WANDER_RADIUS = Math.floor(Math.min(w, h) * 0.4);
  spriteX = Math.max(HOUSE_MARGIN, Math.min(w - PET_SPRITE_W - HOUSE_MARGIN, resizeStartBounds.sx - winDX));
  spriteY = Math.max(HOUSE_MARGIN, Math.min(h - PET_SPRITE_H - HOUSE_MARGIN, resizeStartBounds.sy - winDY));
  updateSpritePos();
}

document.addEventListener('mousemove', (e) => {
  if (!dragStart) return;

  if (dragMode === 'resize') {
    scheduleResize(e);
    return;
  }

  if (dragMode === 'window') {
    const dx = e.screenX - dragStart[0];
    const dy = e.screenY - dragStart[1];
    if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) { dragging = true; changeState('idle'); }
    if (dragging) {
      winX = winStartPos[0] + dx;
      winY = winStartPos[1] + dy;
      window.pet.setWindowPos(winX, winY);
    }
    return;
  }

  if (dragMode === 'sprite') {
    const dx = e.clientX - dragStart[0];
    const dy = e.clientY - dragStart[1];
    if (!dragging && Math.abs(dx) + Math.abs(dy) > 4) { dragging = true; changeState('idle'); }
    if (dragging) {
      spriteX = Math.max(HOUSE_MARGIN, Math.min(PET_WIN_W - PET_SPRITE_W - HOUSE_MARGIN, e.clientX - petDragOffset[0]));
      spriteY = Math.max(HOUSE_MARGIN, Math.min(PET_WIN_H - PET_SPRITE_H - HOUSE_MARGIN, e.clientY - petDragOffset[1]));
      updateSpritePos();
    }
  }
});

document.addEventListener('mouseup', (e) => {
  if (dragMode === 'resize') {
    dragMode = null;
    resizeDir = null;
    resizeStartBounds = null;
    dragStart = null;
    dragging = false;
    return;
  }
  if (!mouseDownOnCanvas) return;
  mouseDownOnCanvas = false;
  if (e.button !== 0) { dragStart = null; dragMode = null; return; }
  const wasDragging = dragging;
  const endedDragMode = dragMode;
  dragging = false;
  dragStart = null;
  dragMode = null;
  if (wasDragging) {
    // 펫 내부 drag면 놓인 위치를 새 home으로 — 사용자가 의도한 자리에 머물도록
    if (endedDragMode === 'sprite') {
      homeX = spriteX;
      homeY = spriteY;
    }
    showRandomBubble('drag');
    return;
  }
  if (!activePet) return;
  const now = Date.now();
  const isDouble = now - lastClick < 300;
  lastClick = now;
  if (state === 'sleep') {
    if (isDouble) { changeState('idle'); showRandomBubble('pet'); }
    return;
  }
  if (isDouble) {
    changeState('run');
  } else {
    triggerJump();
    if (Math.random() < 0.25) showRandomBubble(state === 'idle' ? 'pet' : state);
  }
});

// 테두리 strip — mousedown으로 resize 시작, mouseenter/leave로 click-through 토글
function wireEdge(id, dir) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', (e) => { if (e.button === 0) startResize(dir, e); });
  el.addEventListener('mouseenter', () => { if (isInPetMode()) window.pet.setIgnoreMouse(false); });
  el.addEventListener('mouseleave', () => {
    if (!isInPetMode()) return;
    if (dragMode === 'resize' || dragging) return;
    window.pet.setIgnoreMouse(true);
  });
}
wireEdge('edgeT', 't'); wireEdge('edgeB', 'b'); wireEdge('edgeL', 'l'); wireEdge('edgeR', 'r');
wireEdge('edgeTL', 'tl'); wireEdge('edgeTR', 'tr'); wireEdge('edgeBL', 'bl'); wireEdge('edgeBR', 'br');

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// 펫 캔버스 위에 있을 때만 클릭 받음, 그 밖은 뒤 앱으로 통과
// (펫 모드일 때만 — 선택/입력 화면일 땐 화면 전체 클릭 받아야 함)
function isInPetMode() {
  return !canvas.classList.contains('hidden');
}
canvas.addEventListener('mouseenter', () => {
  if (isInPetMode()) window.pet.setIgnoreMouse(false);
});
canvas.addEventListener('mouseleave', () => {
  if (!isInPetMode()) return;  // 다른 화면일 땐 leave 무시
  if (dragging) return;  // 드래그 중엔 ignore 켜지 말기 (드래그 끊김 방지)
  window.pet.setIgnoreMouse(true);
});

// ─── 메뉴 ───
window.pet.onMenuClick((id) => {
  if (id === 'quit') window.pet.quit();
  else if (id === 'switch') showSelectScreen();
  else if (id === 'feed') {
    if (state === 'sleep') return;  // 메뉴에서 이미 숨겨졌지만 안전망
    showRandomBubble('feed');
  }
  else if (id === 'pet') {
    if (state === 'sleep') return;
    showRandomBubble('pet');
  }
  else if (id === 'fullscreen') toggleFullscreen();
});

// ─── 선택 화면 ───
function renderSelectCards() {
  selectGrid.innerHTML = '';
  pets.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'select-card';

    const cv = document.createElement('canvas');
    cv.width = SPRITE_W * 2;
    cv.height = SPRITE_H * 2;
    card.appendChild(cv);
    drawFrameTo(cv.getContext('2d'), p.frames.IDLE_0, false, 2);

    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = p.name || p.id;
    card.appendChild(nameEl);

    card.onclick = () => selectPet(p);
    selectGrid.appendChild(card);
  });
}

async function showSelectScreen() {
  stopMainLoop();
  canvas.classList.add('hidden');
  document.getElementById('petHouse').classList.add('hidden');
  ['edgeT','edgeB','edgeL','edgeR','edgeTL','edgeTR','edgeBL','edgeBR'].forEach(id => document.getElementById(id).classList.add('hidden'));
  bubbleEl.classList.add('hidden');
  selectScreen.classList.remove('hidden');
  selectError.classList.add('hidden');
  // 전체화면/resize 상태 리셋 — 다음 펫 모드 진입 시 기본 크기로 복원되게
  isFullscreen = false;
  savedBounds = null;
  PET_WIN_W = PET_WIN_W_DEFAULT;
  PET_WIN_H = PET_WIN_H_DEFAULT;
  homeX = (PET_WIN_W - PET_SPRITE_W) / 2;
  homeY = (PET_WIN_H - PET_SPRITE_H) / 2;
  WANDER_RADIUS = Math.floor(Math.min(PET_WIN_W, PET_WIN_H) * 0.4);
  // 선택 창은 현재 모니터 중앙 + 기본 선택 크기로 atomic 설정
  const m = getCurrentMonitor();
  winX = m.x + Math.floor(m.w / 2 - SELECT_WIN_W / 2);
  winY = m.y + Math.floor(m.h / 2 - SELECT_WIN_H / 2);
  window.pet.setWindowBounds({ x: winX, y: winY, width: SELECT_WIN_W, height: SELECT_WIN_H });
  window.pet.setIgnoreMouse(false);
  renderSelectCards();
  // 서버에서 최신 캐릭터 다시 받아 갱신
  const ok = await loadPets();
  if (ok && !isOfflineMode) {
    selectError.classList.add('hidden');
  } else {
    selectError.textContent = statusEl.textContent || '서버 갱신 실패';
    selectError.classList.remove('hidden');
  }
  renderSelectCards();
}

const EDGE_IDS = ['edgeT','edgeB','edgeL','edgeR','edgeTL','edgeTR','edgeBL','edgeBR'];

function selectPet(p) {
  activePet = p;
  saveLastPetId(p.id);
  selectScreen.classList.add('hidden');
  canvas.classList.remove('hidden');
  document.getElementById('petHouse').classList.remove('hidden');
  EDGE_IDS.forEach(id => document.getElementById(id).classList.remove('hidden'));
  window.pet.setWindowSize(PET_WIN_W, PET_WIN_H);
  window.pet.setIgnoreMouse(true);
  // 스프라이트 초기 위치 = 하우스 중앙
  spriteX = homeX;
  spriteY = homeY;
  updateSpritePos();
  changeState('idle');
  drawFrame(activePet.frames.IDLE_0, false);
  startMainLoop();
}

// ─── 메인 루프 ───
function tick() {
  if (!activePet) return;
  stateTimer += TICK_MS;
  idleBubbleTimer += TICK_MS;
  animAcc += TICK_MS;

  // 프레임은 animSpeed 간격으로만 교체하되, drawFrame은 매 tick 강제 호출
  // → 캔버스 painting이 lost 되어도 1 tick 안에 자동 복구 ("펫이 사라짐" 방어)
  if (animAcc >= animSpeed()) {
    animAcc = 0;
    frameIdx = (frameIdx + 1) % 2;
  }
  const frames = currentFrames();
  drawFrame(frames[frameIdx] || frames[0], shouldFlip());

  if (!dragging) tickMovement();

  // 자동 대사: idle/walk 상태에서 10-20초마다
  if ((state === 'idle' || state === 'walk') && idleBubbleTimer > 12000 + Math.random() * 8000) {
    idleBubbleTimer = 0;
    if (Math.random() < 0.7) showRandomBubble(state);
  }

  // 상태 자동 전환
  if (state === 'idle' && stateTimer > 5000 + Math.random() * 5000) {
    randomStateChange();
  } else if (state === 'sleep' && stateTimer > 25000) {
    randomStateChange();  // 한번 잠들면 평균 ~26초 (25s ÷ 0.95)
  } else if (state === 'sit' && stateTimer > 8000) {
    randomStateChange();
  } else if (state === 'run' && stateTimer > 3000) {
    changeState('idle');  // 3초 달리면 멈춤
  }

  // 화면 밖 watchdog — 사용자가 drag로 창을 화면 밖에 던진 경우 복귀.
  if (!isWindowVisible()) {
    offScreenTicks++;
    const threshold = dragging ? 50 : 5;
    if (offScreenTicks > threshold) {
      const m = displays[0];
      winX = m.x + m.w / 2 - PET_WIN_W / 2;
      winY = m.y + m.h / 2 - PET_WIN_H / 2;
      window.pet.setWindowPos(winX, winY);
      dragging = false;
      offScreenTicks = 0;
    }
  } else {
    offScreenTicks = 0;
  }
}

function startMainLoop() {
  if (mainLoopInterval) clearInterval(mainLoopInterval);
  mainLoopInterval = setInterval(tick, TICK_MS);
}

function stopMainLoop() {
  if (mainLoopInterval) { clearInterval(mainLoopInterval); mainLoopInterval = null; }
}

// ─── Heartbeat — main의 ping에 즉시 pong
// renderer가 살아있음을 증명. 10초간 응답 없으면 main이 reload 트리거.
window.pet.onRendererPing(() => window.pet.sendRendererPong());

// ─── 초기화 ───
async function init() {
  // main이 트리거한 auto reload일 때만 자동 복원 (일반 실행은 URL/선택창 띄움)
  const isAutoReload = await window.pet.isAutoReload().catch(() => false);
  if (isAutoReload && !SERVER_URL) {
    const urls = loadUrlHistory();
    if (urls.length) SERVER_URL = urls[0];
  }
  if (!SERVER_URL) {
    showServerScreen();
    return;
  }
  serverScreen.classList.add('hidden');  // env var override 시 (HTML 기본 노출 상태 → 숨김)
  statusEl.classList.remove('hidden');
  statusEl.textContent = '로딩 중...';
  const ok = await loadPets();
  if (!ok) {
    // 실패 시 URL 입력 화면으로 복귀 — 사용자가 다른 URL 입력하거나 종료 가능
    const reason = statusEl.textContent || '서버 연결 실패';
    SERVER_URL = null;
    statusEl.classList.add('hidden');
    showServerScreen();
    serverError.textContent = reason;
    serverError.style.color = '';
    serverError.classList.remove('hidden');
    return;
  }

  try {
    const ds = await window.pet.getDisplays();
    if (Array.isArray(ds) && ds.length) displays = ds;
  } catch {}
  const [wx, wy] = await window.pet.getWindowPos();
  winX = wx; winY = wy;

  statusEl.classList.add('hidden');

  // auto reload 시에만 마지막 pet 자동 재진입 (일반 실행은 선택창 노출)
  const lastId = isAutoReload ? loadLastPetId() : null;
  const lastPet = lastId ? pets.find(p => p.id === lastId) : null;
  if (lastPet) {
    selectPet(lastPet);
  } else if (pets.length === 1) {
    selectPet(pets[0]);
  } else {
    showSelectScreen();
  }
}

init();
