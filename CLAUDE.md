# Pulse City — Claude Working Reference

## Project Vision
Open-world action-adventure web game set in a near-future cyberpunk metropolis.
Core pillar: **inclusive high-fidelity** — accessibility is a gameplay mechanic, not a settings menu.

## Tech Stack
| Layer | Choice | Why |
|---|---|---|
| 3D Engine | Babylon.js 7 (WebGPU, WebGL2 fallback) | Best-in-class web 3D with official WebGPU support |
| Physics | Havok (via `@babylonjs/havok`) | Officially integrated with Babylon.js 7 |
| Audio | Web Audio API + Babylon.js SoundTrack | 3D spatial audio for navigation cues |
| UI / DOM overlay | Svelte 5 | Compiles to direct DOM mutations — better for high-frequency game-loop updates than React's VDOM |
| Build | Vite 5 + `@sveltejs/vite-plugin-svelte` | Fast HMR, ESM-native |
| Tests | Vitest 2 + jsdom | Same config file as Vite; jsdom for DOM assertions |

## Project Structure
```
src/
  engine/
    AccessibilityObserver.js        ← DOM parallel mirror (Phase 1, COMPLETE)
    AccessibilityObserver.test.js
    InputManager.js                 ← Adaptive input layer (Phase 1, COMPLETE)
    InputManager.test.js
    PulseManager.js                 ← Multi-sensory pulse mechanic (Phase 2, COMPLETE)
    PulseManager.test.js
    pulse.glsl                      ← Post-process ring shader (Phase 2, COMPLETE)
    SpatialAudioManager.js          ← Beacon sweep after each pulse (Phase 2, COMPLETE)
    SpatialAudioManager.test.js
    CharacterController.js          ← Camera-relative movement + jump/gravity (Phase 2, COMPLETE)
    CharacterController.test.js
    ColorblindManager.js            ← Colorblind correction mode state (Phase 3, COMPLETE)
    ColorblindManager.test.js
    colorblind.glsl                 ← Viénot 1999 simulation + Fidaner daltonize correction (Phase 3, COMPLETE)
    AssetLoader.js                  ← glTF/Draco pipeline; wires meshes into A11y + Spatial (Phase 3b, COMPLETE)
    AssetLoader.test.js
    SpeechManager.js                ← Self-voicing via Web Speech API; on by default, Alt+V toggle (Phase 3, COMPLETE)
    SpeechManager.test.js
  components/
    App.svelte                      ← Root overlay: mounts CaptionBar, ScanBar, ControlPanel (Phase 1+3, COMPLETE)
    App.test.js
    CaptionBar.svelte               ← Visible caption bar for deaf/HoH players (Phase 1, COMPLETE)
    ScanBar.svelte                  ← Auto-scan action bar for single-switch users (Phase 1, COMPLETE)
    ControlPanel.svelte             ← Accessibility settings dialog (Phase 3, COMPLETE)
    ControlPanel.test.js
  stores.js                         ← captionStore, scanStore, panelStore, updateCaption(), syncScanStore(), togglePanel()
  stores.test.js
  styles/
    global.css                      ← .sr-only, focus ring, canvas/app layout
  main.js                           ← Engine init, Havok physics, scene, CharacterController, announce bridge, App mount
index.html
audit.py                            ← static accessibility auditor (run: npm run audit)
CLAUDE.md
```

## AccessibilityObserver — Core System
**File:** `src/engine/AccessibilityObserver.js`

The DOM Parallel Mirror: every critical 3D scene node gets a mirrored `<li>` element inside a visually-hidden `<div id="pulse-city-a11y">`. Screen readers navigate this DOM shadow while sighted players see the 3D canvas.

### Key design decisions
- **Throttle at 500 ms per node** — screen readers saturate above ~2 updates/sec per element.
- **`lastUpdateTime = 0` on register** — the first render tick always produces a description; subsequent updates are throttled. This avoids a flood when many meshes register at once while still giving immediate context on entry.
- **Direction uses XZ-plane angle relative to camera forward** — `atan2(dx, dz)` with Babylon's left-handed coordinate system (Z = forward). Eight 45° arc segments: ahead, ahead-right, right, behind-right, behind, behind-left, left, ahead-left.
- **Distance bands** (in Babylon units / metres): very close ≤5, nearby ≤15, moderate ≤30, far ≤60, distant >60.
- **`Date.now()` not `performance.now()`** for throttle — vitest's `vi.useFakeTimers()` fakes `Date` but not `performance` by default.
- **`aria-live` trick**: clear → 50 ms delay → set. Forces re-announcement even if the new message text is identical to the previous.

### Public API
```js
import { AccessibilityObserver, NodeType, Urgency } from './engine/AccessibilityObserver.js';

const observer = new AccessibilityObserver(scene, { camera, containerId });

observer.register(mesh, { type: NodeType.VEHICLE, label: 'Taxi', priority: 'normal' });
observer.unregister(mesh);
observer.getDOMElement(mesh);      // → HTMLElement | null
observer.announce(msg, Urgency.ASSERTIVE);
observer.trackedCount;             // → number
observer.dispose();
```

### NodeType values
`player` `vehicle` `npc` `waypoint` `obstacle` `hazard` `collectible`

## InputManager — Adaptive Input Layer
**File:** `src/engine/InputManager.js`

Unified command API. Consumers call `onCommand(cb)` and never touch raw events.

### Modes
| Mode | Behaviour |
|---|---|
| `KEYBOARD` (default) | WASD + keys → GameCommand stream; keydown = value 1, keyup = value 0 |
| `GAMEPAD` | Standard controller; call `input.poll()` each frame. Auto-activates on `gamepadconnected`. |
| `SWITCH` | Single-switch auto-scan. Cycles through `scanList` every `scanIntervalMs` ms. Any key press fires `currentScanCommand`. Eye-tracking deferred to Phase 2. |

### Key design decisions
- **Dependency-injected `getGamepads`** — constructor accepts `getGamepads` fn (defaults to `navigator.getGamepads?.() ?? []`). Lets tests inject a mock without touching the navigator.
- **Auto-scan is auto-stop** — `setMode()` always clears the previous scan timer before starting a new one, preventing leaked intervals.
- **Gamepad dead zone: 0.15** — axis values below this magnitude are silently ignored.
- **Gamepad state diffing** — `poll()` only emits when value changes from previous tick, preventing a flood of identical events at 60 fps.
- **SWITCH mode keyup is suppressed** — only keydown fires; a single switch press = one discrete activation.

### Public API
```js
import { InputManager, GameCommand, InputMode } from './engine/InputManager.js';

const input = new InputManager({ scanIntervalMs: 1000 });

const unsub = input.onCommand((command, value) => { /* ... */ });
unsub(); // unsubscribe

input.setMode(InputMode.SWITCH);       // start auto-scan
input.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
input.currentScanCommand;              // → GameCommand | null
input.scanList;                        // → GameCommand[] (copy)
input.remap(GameCommand.PULSE_SCAN, ['p']); // rebind key(s)
input.poll();                          // call each frame for gamepad
input.dispose();
```

### Default keyboard map
`w/↑` MOVE_FORWARD · `s/↓` MOVE_BACK · `a/←` STRAFE_LEFT · `d/→` STRAFE_RIGHT
`PgUp` LOOK_UP · `PgDn` LOOK_DOWN (LOOK_LEFT / LOOK_RIGHT are right-stick only)
`Tab` PULSE_SCAN · `Space` JUMP · `f` INTERACT · `Shift` SPRINT · `b` BRAKE · `Esc` PAUSE
`e` ENTER_VEHICLE · `q` EXIT_VEHICLE

### Default gamepad map
Button 0 (A) INTERACT · 1 (B) BRAKE · 2 (X) PULSE_SCAN · 3 (Y) SPRINT · 9 (Start) PAUSE
Left stick → move · Right stick → look

## PulseManager — Multi-Sensory Pulse Mechanic
**Files:** `src/engine/PulseManager.js` · `src/engine/pulse.glsl`

Triggered by `GameCommand.PULSE_SCAN` (Space / gamepad X). Fires three simultaneous outputs:

| Channel | Implementation |
|---|---|
| Visual | GLSL post-process shader (`pulse.glsl`): neon-cyan ring expands from centre, highlights objects as it sweeps through. Uniforms: `u_progress` (0–1), `u_active` (0/1), `u_resolution`. |
| Audio | Web Audio API: sine oscillator sweeping 800 Hz → 180 Hz over 0.7 s with amplitude decay. |
| Haptic | Four-step fade-out rumble via `gamepad.vibrationActuator.playEffect` at 0 ms / 180 ms / 360 ms / 540 ms, strongMagnitude 1.0 → 0.1. |

**No cooldown** — retrigger at any time; resets progress and restarts all outputs.

### Key design decisions
- **`audioContext` and `getGamepads` are injected** — same pattern as `InputManager`, keeps tests free of browser APIs.
- **Haptic steps use `setTimeout`** — predictable in tests with `vi.useFakeTimers()`; retrigger cancels pending timers before restarting.
- **Shader registered via `BABYLON.Effect.ShadersStore`** in `main.js` — `PulseManager` never imports Babylon, stays fully testable.
- **PostProcess attached on `scene.onActiveCameraChanged`** — safe if camera isn't set at startup.
- **`onTrigger(() => announce('Pulse scan'))` wires into the announce bridge** — screen readers and the caption bar both hear every pulse.

### Public API
```js
import { PulseManager, PulseState } from './engine/PulseManager.js';

const pulse = new PulseManager(scene, { durationMs: 800, audioContext, getGamepads });
pulse.onTrigger(() => { /* fires on every trigger / retrigger */ });
pulse.onProgress((p) => { /* 0-1 each render frame while PULSING */ });
pulse.trigger();         // fire / retrigger
pulse.state;             // PulseState.IDLE | PulseState.PULSING
pulse.progress;          // 0-1
pulse.dispose();
```

## SpatialAudioManager — Beacon Sweep
**File:** `src/engine/SpatialAudioManager.js`

After each Pulse scan, all registered meshes play a brief synthesised beacon tone in order, nearest-first. Players can close their eyes and hear the scene.

| NodeType | Freq (Hz) | Wave |
|---|---|---|
| WAYPOINT | 880 | sine |
| NPC | 400 | sine |
| OBSTACLE | 220 | square |
| VEHICLE | 80 | sawtooth |
| HAZARD | 150 | square |
| COLLECTIBLE | 1200 | sine |
| PLAYER | — | (skipped) |

### Key design decisions
- **No cap on objects** — all registered, visible, enabled meshes beacon; no arbitrary limit.
- **Nearest-first sort** — Euclidean distance in 3D at trigger time; allows navigation purely by listening.
- **Sequential `setTimeout` chain** — gaps between beacons (beaconDurationMs=400 + beaconGapMs=80) are distinct silence; no overlap. Retrigger cancels all pending timers and restarts.
- **PannerNode per beacon** — HRTF panning model; Web Audio handles the 3D stereo placement relative to the AudioListener.
- **Listener updated every render tick** — camera position and forward-vector written to `audioContext.listener` each frame so moving between beacons stays spatially accurate.
- **Soft amplitude envelope** — 10 ms attack + 50 ms release prevents clicks at beacon boundaries.
- **PLAYER type is never a beacon** — the player is the listener, not a target.
- **`getCamera` is injected** — defaults to `() => scene.activeCamera`; test-friendly.

### Public API
```js
import { SpatialAudioManager } from './engine/SpatialAudioManager.js';

const spatial = new SpatialAudioManager(scene, { audioContext, getCamera });
spatial.register(mesh, { type: NodeType.WAYPOINT, label: 'Checkpoint' });
spatial.unregister(mesh);
spatial.trigger();        // sweep starts; cancels any in-progress sweep
spatial.trackedCount;     // → number
spatial.dispose();
```

## Implementation Phases
| Phase | Months | Status |
|---|---|---|
| 1 — Architecture & A11y Foundation | 1–3 | AccessibilityObserver ✓  InputManager ✓  Svelte UI overlay ✓ |
| 2 — Core Gameplay & Sensory Design | 4–6 | Pulse mechanic ✓  Spatial audio ✓  CharacterController ✓  Havok physics ✓ |
| 3 — Visual Styling & Asset Pipeline | 7–9 | Cyberpunk neon aesthetic ✓  glTF/Draco pipeline ✓  SpeechManager ✓  UI control panel ✓ |
| 4 — Optimization, Testing & Deploy | 10–12 | PerformanceMonitor ✓  PerfHUD ✓  CDN deploy ✓  NVDA/VoiceOver testing (manual) |

## Running the Project
```bash
npm run dev          # dev server (Vite)
npm test             # run Vitest suite
npm run test:watch   # watch mode
npm run audit        # Python accessibility static auditor
npm run build        # production build
```

## Accessibility Conventions
- **Never** put critical game state only in the canvas — always mirror to DOM.
- **All interactive Svelte components** need `aria-label` or visible text; no icon-only buttons without labels.
- **Color contrast**: minimum 4.5:1 for body text, 3:1 for UI chrome, 7:1 target for HUD elements (players with low vision use the game without low-vision mode on).
- **Keyboard navigation**: every action must be reachable from the keyboard. No click-only handlers.
- **Closed captions**: all in-game audio dialogue must have a corresponding Svelte caption component.
- **Focus management**: on scene transitions, move `document.activeElement` to the new section's heading or first interactive element.
- Run `audit.py` before every PR; zero errors required to merge.

## Key Babylon.js Notes
- Babylon 7 uses a **left-handed coordinate system**: +X right, +Y up, +Z forward.
- WebGPU engine: `new BABYLON.WebGPUEngine(canvas)` with async `await engine.initAsync()` before scene creation.
- `scene.onBeforeRenderObservable` fires every frame — use for per-frame DOM syncs but always throttle.
- `camera.getForwardRay(1).direction` is the reliable way to get camera facing in world space.
- Havok: load via `@babylonjs/havok` and pass to `new HavokPhysics()` before any impostors.

## UI / Svelte Conventions
- Svelte components live in `src/components/`.
- The Babylon canvas and the Svelte-managed DOM overlay are **siblings**, not nested — Svelte never touches the canvas element.
- Use Svelte stores (`writable`) to push game state into the UI layer without Babylon knowing about Svelte.
- `App.svelte` receives `{ a11y, input, announce }` as props from `main.js` and provides `announce` to descendants via Svelte context (`getContext('announce')`).
- **Never call `a11y.announce()` directly from game code** — always call the `announce()` bridge in `main.js`. It writes to BOTH the aria-live regions (screen readers) AND `captionStore` (CaptionBar for deaf/HoH players).
- `CaptionBar.svelte` — `aria-hidden="true"`, fade-in CSS animation, clears automatically after 5 s (default). No Svelte transitions; CSS-only for test stability.
- `ScanBar.svelte` — only renders when `scanStore.mode === 'switch'`. Active chip uses neon cyan `#00f5ff` (4.5:1 contrast on black). `aria-live="polite"` on the nav provides a secondary screen-reader cue alongside haptic.
- Vitest needs `resolve.conditions: ['browser']` + `svelte({ hot: !process.env.VITEST })` so the client-side Svelte runtime (with `mount`) is used instead of the SSR build.

## SpeechManager — Self-Voicing
**File:** `src/engine/SpeechManager.js`

Wraps `window.speechSynthesis` to narrate the game without an external screen reader. On by default; toggled with **Alt+V** (wired in `main.js`). Screen-reader users turn it off once; they still receive the ARIA live-region announcements.

### Why a separate channel from ARIA?
The ARIA path uses terse labels tuned for screen-reader efficiency ("Pulse scan"). Self-voicing speaks in natural sentences for players without a screen reader ("Pulse scan — 3 beacons nearby."). The pulse trigger is the one event where the two messages differ intentionally.

### Key design decisions
- **`synth` and `Utterance` injected** — constructor accepts `{ synth, Utterance, enabled }`. Defaults to `globalThis.speechSynthesis` / `globalThis.SpeechSynthesisUtterance`; tests inject mocks.
- **`toggle()` always speaks its confirmation** — the "off" message bypasses the enabled check (it's the final utterance before the system goes silent).
- **`speak(text, { interrupt })` — `interrupt: true` calls `synth.cancel()` first** — used for assertive urgency in the announce bridge.
- **Startup narration fires 800 ms after `init()`** — gives the engine time to settle and ensures the browser speech queue is ready.
- **Post-pulse message differs from ARIA** — beacon count gives players a quick orientation without reading the DOM mirror.

### Public API
```js
import { SpeechManager } from './engine/SpeechManager.js';

const speech = new SpeechManager({ enabled: true });
speech.speak('Welcome to Pulse City.');
speech.speak('Warning!', { interrupt: true });
speech.toggle();    // 'Self-voicing off.' → silences; returns new enabled state
speech.cancel();    // stop all speech immediately
speech.dispose();
```

## ControlPanel — Accessibility Settings Dialog
**Files:** `src/components/ControlPanel.svelte` · `src/components/ControlPanel.test.js`

In-game settings panel triggered by `Esc` / `GameCommand.PAUSE`. Lets players adjust all accessibility options without leaving the game.

| Section | Controls | API |
|---|---|---|
| Colorblind correction | Radio group: Off / Deuteranopia / Protanopia / Tritanopia | `cbManager.setMode(ColorblindMode.*)` |
| Self-voicing | Checkbox | `speech.toggle()` |
| Input mode | Radio group: Keyboard / Gamepad / Single-switch | `input.setMode(InputMode.*)` |

### Key design decisions
- **`role="dialog"` + `aria-modal="true"`** — tells screen readers the rest of the page is inert while open.
- **Focus trap** — Tab/Shift+Tab cycle within the dialog; Esc closes and restores prior focus.
- **`e.stopPropagation()` on all dialog keydown events** — prevents game commands (PULSE_SCAN, MOVE_*, etc.) from firing while the panel is open.
- **Backdrop** — dark overlay captures outside clicks to close; `aria-hidden="true"` so it's invisible to AT.
- **`untrack()` for `$state` init** — tells Svelte 5 the snapshot of prop values at mount is intentional, silencing the reactive-capture warning.
- **`cbManager.onModeChange` subscription** — keeps the colorblind radios in sync if the mode is changed externally (e.g., directly from dev console).
- **`togglePanel()` in stores.js** — `main.js` calls this on PAUSE command; the panel itself calls `panelStore.set(false)` to close.
- **Announce bridge** — input mode changes fan out via `announce()` so screen readers and captions both hear them; colorblind mode changes are announced by the existing `cbManager.onModeChange` subscriber in `main.js`.

### Public store API
```js
import { panelStore, togglePanel } from './stores.js';
togglePanel();           // open if closed, close if open
panelStore.set(false);  // always close (used inside the panel itself)
```

## CDN Deploy — GitHub Pages
**Files:** `.github/workflows/pulse-city.yml` · `scripts/fetch-draco.js` · `public/draco/`

### Pipeline (triggers on push to `master` touching `Pulse city game/**`):
1. **Test job** — `npm ci` → `npm test` → `npm run audit` (zero-tolerance AT audit)
2. **Deploy job** (master push only, after test passes) — `npm run fetch-draco` → `npm run build` → `peaceiris/actions-gh-pages@v4` pushes `dist/` to `gh-pages` branch

### Base URL
`VITE_BASE=/Pulse-city/` is set in the deploy job env. Update this if the repo is renamed.
Game is live at: `https://blindgeek1989.github.io/Pulse-city/`

### Draco decoder strategy
- **Dev**: CDN (`https://cdn.babylonjs.com/`) — no local setup needed
- **Production**: `${BASE_URL}draco/` (local files, served from same origin)
- `scripts/fetch-draco.js` downloads the three decoder files into `public/draco/` at CI build time
- `public/draco/*.js` and `public/draco/*.wasm` are gitignored; `public/draco/.gitkeep` tracks the directory
- `npm run fetch-draco` to download locally; `npm run build:ci` to fetch + build in one step

### Chunk splitting (vite.config.js)
```
vendor-babylon-core    ← @babylonjs/core    (cached separately)
vendor-babylon-loaders ← @babylonjs/loaders
vendor-babylon-havok   ← @babylonjs/havok
<entry>                ← game code + Svelte UI (small, changes often)
```

### GitHub Pages setup (one-time, in repo Settings → Pages)
- Source: **Deploy from a branch**
- Branch: `gh-pages` / `/ (root)`

## PerformanceMonitor — Frame Budget Tracker
**Files:** `src/engine/PerformanceMonitor.js` · `src/engine/PerformanceMonitor.test.js`

60-frame rolling window frame-budget tracker. No Babylon.js dependency — fully testable.

| Getter | Returns |
|---|---|
| `frameMs` | Rolling average frame time (ms) |
| `fps` | Rolling average frames per second |
| `min` / `max` | Min/max frame time in the current window |
| `budget` | `FrameBudget.GOOD` (≤16.7ms) / `WARNING` (≤33.3ms) / `CRITICAL` (>33.3ms) |
| `sampleCount` | Frames currently in the window |

```js
import { PerformanceMonitor, FrameBudget } from './engine/PerformanceMonitor.js';
const perf = new PerformanceMonitor({ windowSize: 60 });
perf.record(deltaMs);               // call once per render tick
const unsub = perf.onUpdate(() => { console.log(perf.fps.toFixed(1)); });
perf.dispose();
```

## PerfHUD — Dev Frame Overlay
**File:** `src/components/PerfHUD.svelte`

Dev-only (mounted inside `import.meta.env.DEV` block in `main.js`). Toggle with **backtick** (`` ` ``) or **F3**. Shows rolling FPS, avg frame ms, min/max spread. Colour-coded: cyan (GOOD) → amber (WARNING) → red (CRITICAL). `aria-hidden="true"` — not a game UI element.

## Questions to Resolve
- Eye-tracking input device support (deferred to Phase 2).
- Specific haptic pattern for the Pulse scan (Phase 2).
- Colorblind shader variants needed: Deuteranopia, Protanopia, Tritanopia (Phase 3).
