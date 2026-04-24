# PixelPet — Desktop Pet (Electron)

Electron app that renders the desktop pet. For features, requirements, and build / install instructions, see the [top-level README](../README.md). This file only covers the bits that are specific to developing the pet itself.

## Run from source (development)

Skip this unless you're modifying pet code — regular users should build the binary as documented in the root README.

```bash
cd pixelpet
npm install

# Optional — override the studio URL so the launcher skips the URL prompt every run.
export PIXELPET_SERVER=https://your-domain.ngrok-free.dev   # macOS / WSL / Linux
# $env:PIXELPET_SERVER="https://your-domain.ngrok-free.dev" # Windows PowerShell

npm start
```

## Architecture

| File | Role |
|------|------|
| `main.js` | Electron main — transparent always-on-top window, IPC handlers, portable data dir |
| `preload.js` | `contextBridge` — safe surface exposed to the renderer |
| `renderer.js` | Pet logic: state machine, animation, drag, click handlers, server fetch |
| `colors.js` | 65-color palette (shared with the studio editor) |
| `index.html` / `styles.css` | UI shell (canvas + bubble + server/character selection screens) |
| `icon.ico` | Windows build icon |
| `package.json` | Dependencies + `electron-builder` targets (`portable` .exe, `.dmg`) |

The pet is drawn as a 20×14 sprite at 3× scale (60×42 px) inside a 400×300 resizable "house" window (drag edges to resize, Shift+drag to relocate, right-click for menu). Sprite data arrives from the studio server in the same pixel-key format used by `studio/editor.html`.
