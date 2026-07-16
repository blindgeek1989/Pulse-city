/**
 * Pulse City — entry point
 *
 * Initialises the Babylon.js WebGPU engine (WebGL2 fallback), creates the
 * initial scene (ground, player capsule, follow camera), wires all systems
 * together, and mounts the Svelte UI overlay.
 */

import { mount, unmount } from 'svelte';
import { AccessibilityObserver, NodeType } from './engine/AccessibilityObserver.js';
import { InputManager, InputMode, GameCommand } from './engine/InputManager.js';
import { PulseManager, PulseState } from './engine/PulseManager.js';
import { SpatialAudioManager } from './engine/SpatialAudioManager.js';
import { CharacterController } from './engine/CharacterController.js';
import { ColorblindManager, ColorblindMode } from './engine/ColorblindManager.js';
import { AssetLoader } from './engine/AssetLoader.js';
import { SpeechManager } from './engine/SpeechManager.js';
import { PerformanceMonitor } from './engine/PerformanceMonitor.js';
import pulseShaderSource     from './engine/pulse.glsl?raw';
import colorblindShaderSource from './engine/colorblind.glsl?raw';
import { updateCaption, togglePanel } from './stores.js';
import App from './components/App.svelte';

const PLAYER_HEIGHT = 1.8;
const PLAYER_RADIUS = 0.4;
const LOOK_SPEED    = 2.0;  // radians / second

async function init() {
  const canvas = document.getElementById('pulse-canvas');

  // ── Babylon engine (WebGPU → WebGL2 fallback) ──────────────────────────
  const BABYLON = await import('@babylonjs/core');

  let engine;
  if (await BABYLON.WebGPUEngine.IsSupportedAsync) {
    engine = new BABYLON.WebGPUEngine(canvas);
    await engine.initAsync();
  } else {
    engine = new BABYLON.Engine(canvas, true);
  }

  const scene = new BABYLON.Scene(engine);

  // ── glTF / Draco loader setup ──────────────────────────────────────────
  // Import registers the GLTF plugin with SceneLoader as a side effect.
  await import('@babylonjs/loaders/glTF/index.js');

  // Draco decoder for KHR_draco_mesh_compression.
  // In production the files live in public/draco/ (fetched by scripts/fetch-draco.js
  // during CI) and are served from the same origin, removing the CDN dependency.
  // In dev we fall back to the Babylon CDN so local runs need no manual setup.
  const dracoBase = import.meta.env.DEV
    ? 'https://cdn.babylonjs.com/'
    : `${import.meta.env.BASE_URL}draco/`;

  BABYLON.DracoCompression.Configuration = {
    decoder: {
      wasmUrl:       `${dracoBase}draco_wasm_wrapper_gltf.js`,
      wasmBinaryUrl: `${dracoBase}draco_decoder_gltf.wasm`,
      fallbackUrl:   `${dracoBase}draco_decoder_gltf.js`,
    },
  };

  // ── Havok physics ──────────────────────────────────────────────────────
  const { default: HavokPhysics } = await import('@babylonjs/havok');
  const havokInstance = await HavokPhysics();
  const havokPlugin = new BABYLON.HavokPlugin(true, havokInstance);
  scene.enablePhysics(new BABYLON.Vector3(0, -9.81, 0), havokPlugin);

  // ── Cyberpunk atmosphere ───────────────────────────────────────────────
  // Very dark purple-blue fog — the city air glows faintly from neon scatter.
  scene.fogMode    = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.018;
  scene.fogColor   = new BABYLON.Color3(0.005, 0.002, 0.018);
  scene.clearColor = new BABYLON.Color4(0.004, 0.001, 0.012, 1.0);

  // Dim hemispheric fill — the city blocks most natural light.
  const sky = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(0.3, 1, 0.5), scene);
  sky.intensity    = 0.35;
  sky.diffuse      = new BABYLON.Color3(0.15, 0.08, 0.25);   // cool purple sky
  sky.groundColor  = new BABYLON.Color3(0.01, 0.002, 0.02);  // near-black ground bounce

  // ── Scene geometry ─────────────────────────────────────────────────────
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 100, height: 100 }, scene);
  new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  ground.isPickable = true;

  const asphaltMat = new BABYLON.PBRMaterial('asphalt', scene);
  asphaltMat.albedoColor = new BABYLON.Color3(0.025, 0.025, 0.04);  // near-black tarmac
  asphaltMat.metallic    = 0.0;
  asphaltMat.roughness   = 0.85;
  ground.material = asphaltMat;

  const playerMesh = BABYLON.MeshBuilder.CreateCapsule('player', {
    height: PLAYER_HEIGHT,
    radius: PLAYER_RADIUS,
  }, scene);
  playerMesh.position.y = PLAYER_HEIGHT / 2 + 0.1;
  playerMesh.isPickable = false;

  // Neon-cyan player shell — this emissive colour is picked up by the GlowLayer.
  const playerMat = new BABYLON.PBRMaterial('playerShell', scene);
  playerMat.albedoColor  = new BABYLON.Color3(0.0,  0.96, 1.0);   // #00f5ff
  playerMat.emissiveColor = new BABYLON.Color3(0.0, 0.45, 0.5);   // inner glow
  playerMat.metallic      = 0.7;
  playerMat.roughness     = 0.25;
  playerMesh.material = playerMat;

  const playerAggregate = new BABYLON.PhysicsAggregate(
    playerMesh,
    BABYLON.PhysicsShapeType.CAPSULE,
    { mass: 80, friction: 0.1, restitution: 0 },
    scene,
  );
  // Zero angular inertia prevents the capsule from tipping on impact.
  playerAggregate.body.setMassProperties({ inertia: BABYLON.Vector3.Zero() });

  // ── Neon glow layer ────────────────────────────────────────────────────
  // Amplifies emissive meshes with a bloom halo — the core of the neon aesthetic.
  const glow = new BABYLON.GlowLayer('neonGlow', scene);
  glow.intensity      = 1.6;
  glow.blurKernelSize = 64;

  // ── Follow camera ──────────────────────────────────────────────────────
  const camera = new BABYLON.ArcRotateCamera(
    'cam', -Math.PI / 2, Math.PI / 3, 8,
    playerMesh.position.clone(),
    scene,
  );

  // ── Cinematic post-process pipeline ───────────────────────────────────
  // Applied before our custom camera PostProcesses (pipeline runs first).
  const pipeline = new BABYLON.DefaultRenderingPipeline('cyberpunk', false, scene, [camera]);
  pipeline.fxaaEnabled             = true;
  pipeline.bloomEnabled            = true;
  pipeline.bloomThreshold          = 0.75;  // only brightest pixels bloom
  pipeline.bloomWeight             = 0.25;
  pipeline.bloomKernel             = 64;
  pipeline.bloomScale              = 0.5;
  pipeline.chromaticAberrationEnabled = true;
  pipeline.chromaticAberration.aberrationAmount = 1.0;  // subtle glitch fringe

  // ── Accessibility observer ─────────────────────────────────────────────
  const a11y = new AccessibilityObserver(scene);

  a11y.register(playerMesh, { type: NodeType.PLAYER, label: 'Player', priority: 'normal' });

  // ── Adaptive input layer ───────────────────────────────────────────────
  const input = new InputManager();

  // ── Self-voicing ───────────────────────────────────────────────────────
  // On by default. Screen-reader users who don't need it press Alt+V once.
  const speech = new SpeechManager();

  // ── Announce bridge ────────────────────────────────────────────────────
  // Routes every game event to three parallel output channels:
  //   • ARIA live region  → screen readers (terse label)
  //   • CaptionBar        → deaf/HoH players (visible text)
  //   • SpeechManager     → self-voicing (same text; pulse scan uses its own richer message below)
  function announce(text, urgency = 'polite') {
    a11y.announce(text, urgency);
    updateCaption(text, urgency);
    speech.speak(text, { interrupt: urgency === 'assertive' });
  }

  // ── Pulse mechanic ─────────────────────────────────────────────────────
  const audioContext = new AudioContext();

  const pulse = new PulseManager(scene, {
    audioContext,
    getGamepads: () => navigator.getGamepads?.() ?? [],
  });

  input.onCommand((cmd, value) => {
    if (cmd === GameCommand.PULSE_SCAN && value === 1) pulse.trigger();
    if (cmd === GameCommand.PAUSE      && value === 1) togglePanel();
  });

  // ── Spatial audio beacons ──────────────────────────────────────────────
  const spatial = new SpatialAudioManager(scene, {
    audioContext,
    getCamera: () => scene.activeCamera,
  });

  pulse.onTrigger(() => spatial.trigger());

  // Pulse scan output — each channel gets a message tuned to its audience.
  // ARIA: terse label so screen readers don't read a novel on every scan.
  // CaptionBar: same terse label.
  // Self-voicing: natural sentence with beacon count for players without a screen reader.
  pulse.onTrigger(() => {
    a11y.announce('Pulse scan', 'polite');
    updateCaption('Pulse scan');
    const n = spatial.trackedCount;
    speech.speak(
      n === 0 ? 'Pulse scan — nothing detected.'
              : `Pulse scan — ${n} ${n === 1 ? 'beacon' : 'beacons'} nearby.`,
    );
  });

  // ── Asset loader ───────────────────────────────────────────────────────
  // loadMesh wraps SceneLoader.ImportMeshAsync with the already-imported BABYLON,
  // so tests can inject a mock without touching Babylon at all.
  const loadMesh = async (url, innerScene) => {
    const lastSlash = url.lastIndexOf('/');
    const rootUrl   = url.slice(0, lastSlash + 1) || './';
    const filename  = url.slice(lastSlash + 1);
    const { meshes } = await BABYLON.SceneLoader.ImportMeshAsync('', rootUrl, filename, innerScene);
    return meshes;
  };

  const loader = new AssetLoader(scene, a11y, spatial, { loadMesh });

  // Populate with real .glb paths as assets become available:
  // await loader.loadAll([
  //   { id: 'taxi',       url: '/assets/vehicles/taxi.glb',    nodeType: NodeType.VEHICLE,
  //     label: 'Taxi',       position: { x: 10, y: 0, z: 20 } },
  //   { id: 'checkpoint', url: '/assets/props/checkpoint.glb', nodeType: NodeType.WAYPOINT,
  //     label: 'Checkpoint', position: { x:  0, y: 0, z: 30 } },
  // ]);

  // ── Custom camera PostProcesses ────────────────────────────────────────
  // These run AFTER the DefaultRenderingPipeline (Babylon's pipeline-before-camera rule).

  // Pulse ring shader
  BABYLON.Effect.ShadersStore['pulseFragmentShader'] = pulseShaderSource;
  const pulsePostProcess = new BABYLON.PostProcess(
    'pulse', 'pulse',
    ['u_progress', 'u_active', 'u_resolution'],
    null, 1.0, camera,
  );
  pulsePostProcess.onApply = (effect) => {
    effect.setFloat('u_progress', pulse.progress);
    effect.setFloat('u_active', pulse.state === PulseState.PULSING ? 1.0 : 0.0);
    effect.setFloat2('u_resolution', engine.getRenderWidth(), engine.getRenderHeight());
  };

  // Colorblind correction shader (last in chain — corrects the final composite)
  BABYLON.Effect.ShadersStore['colorblindFragmentShader'] = colorblindShaderSource;
  const cbManager = new ColorblindManager();
  const colorblindPostProcess = new BABYLON.PostProcess(
    'colorblind', 'colorblind', ['u_mode'], null, 1.0, camera,
  );
  colorblindPostProcess.onApply = (effect) => {
    effect.setInt('u_mode', cbManager.mode);
  };
  // Announce mode changes so screen readers and captions both hear it.
  cbManager.onModeChange((mode) => {
    const names = { 0: 'off', 1: 'deuteranopia', 2: 'protanopia', 3: 'tritanopia' };
    announce(`Colorblind correction: ${names[mode]}`, 'polite');
  });

  // ── CharacterController ────────────────────────────────────────────────
  function isGrounded() {
    const pos = playerMesh.getAbsolutePosition();
    const origin = new BABYLON.Vector3(pos.x, pos.y - PLAYER_HEIGHT / 2 + 0.05, pos.z);
    const ray = new BABYLON.Ray(origin, new BABYLON.Vector3(0, -1, 0), 0.12);
    const hit = scene.pickWithRay(ray, (m) => m !== playerMesh && m.isPickable);
    return hit?.hit ?? false;
  }

  const cc = new CharacterController(
    {
      setLinearVelocity: (v) =>
        playerAggregate.body.setLinearVelocity(new BABYLON.Vector3(v.x, v.y, v.z)),
      getLinearVelocity: () => {
        const v = playerAggregate.body.getLinearVelocity();
        return { x: v.x, y: v.y, z: v.z };
      },
    },
    {
      getCamera:   () => scene.activeCamera,
      getGrounded: isGrounded,
    },
  );

  // Look state for camera orbit; WASD + jump forwarded to CharacterController.
  const look = { left: 0, right: 0, up: 0, down: 0 };

  // Track which movement keys are currently held so key-repeat events don't
  // re-announce the direction every frame while the key is held down.
  const heldMoveKeys = new Set();
  const MOVE_CUE = {
    [GameCommand.MOVE_FORWARD]: 'Forward',
    [GameCommand.MOVE_BACK]:    'Back',
    [GameCommand.STRAFE_LEFT]:  'Left',
    [GameCommand.STRAFE_RIGHT]: 'Right',
    [GameCommand.JUMP]:         'Jumping',
    [GameCommand.SPRINT]:       'Sprinting',
  };

  input.onCommand((cmd, val) => {
    cc.onCommand(cmd, val);

    // Brief direction cue on the first press of each movement key.
    // Interrupt so the cue plays immediately — in-game real-time feedback
    // matters more than finishing any background narration.
    if (val === 1 && MOVE_CUE[cmd] && !heldMoveKeys.has(cmd)) {
      speech.speak(MOVE_CUE[cmd], { interrupt: true });
    }
    if (val === 1) heldMoveKeys.add(cmd);
    if (val === 0) heldMoveKeys.delete(cmd);

    if (cmd === GameCommand.LOOK_LEFT)  look.left  = val;
    if (cmd === GameCommand.LOOK_RIGHT) look.right = val;
    if (cmd === GameCommand.LOOK_UP)    look.up    = val;
    if (cmd === GameCommand.LOOK_DOWN)  look.down  = val;
  });

  // ── Svelte UI overlay ──────────────────────────────────────────────────
  const app = mount(App, {
    target: document.getElementById('app'),
    props: { a11y, input, announce, cbManager, speech },
  });

  // ── Performance monitor ────────────────────────────────────────────────
  // 60-frame rolling window; wired into the render loop below.
  const perf = new PerformanceMonitor();

  // ── Dev helpers ────────────────────────────────────────────────────────
  if (import.meta.env.DEV) {
    Object.assign(window, {
      __pulse: pulse, __input: input, __a11y: a11y,
      __cc: cc, __spatial: spatial, __cb: cbManager, __loader: loader,
      __speech: speech, __perf: perf,
      ColorblindMode, InputMode, GameCommand, PulseState,
    });

    // PerfHUD overlay — toggle with backtick (`) or F3.
    // Mounted as a sibling to #app so it never interferes with game DOM.
    const { default: PerfHUD } = await import('./components/PerfHUD.svelte');
    const perfTarget = document.createElement('div');
    document.body.appendChild(perfTarget);
    mount(PerfHUD, { target: perfTarget, props: { perf } });
  }

  // ── Full keyboard guide (spoken by H key, also used at startup) ───────────
  // Written for speech synthesis: short sentences, spelled-out key names,
  // pauses implied by full stops so the synth breathes between sections.
  const KEYBOARD_GUIDE =
    'Pulse City keyboard guide. ' +

    'Getting started. ' +
    'When you first load the game, press Tab to fire your Pulse Scan. ' +
    'You will hear a series of tones — each tone is a nearby object. ' +
    'Low rumbles are vehicles. High chimes are waypoints. Buzzes are hazards. ' +
    'Move toward the sounds you want to explore. ' +

    'Movement. ' +
    'W or Up Arrow — move forward. ' +
    'S or Down Arrow — move back. ' +
    'A or Left Arrow — strafe left. ' +
    'D or Right Arrow — strafe right. ' +
    'Page Up — look up. ' +
    'Page Down — look down. ' +
    'Hold Shift while moving to sprint. ' +
    'Press Space to jump. ' +
    'Press B to brake. ' +

    'Exploration. ' +
    'Tab — fire Pulse Scan. ' +
    'The scan sends out a wave that highlights and sounds every nearby object. ' +
    'You can retrigger the scan at any time — there is no cooldown. ' +
    'Press F to interact with an object when you are close to it. ' +
    'Press E to enter a vehicle and Q to exit. ' +

    'Accessibility settings. ' +
    'Press Escape to open the settings panel. ' +
    'Inside the panel you can change colorblind correction, input mode, and self-voicing. ' +
    'Tab and Shift Tab move between options. ' +
    'Escape or the Close button exits the panel. ' +

    'Self-voicing. ' +
    'Press Alt V to toggle this voice on or off at any time. ' +
    'If you use a screen reader, turn self-voicing off — all game events ' +
    'are also announced through ARIA live regions. ' +

    'Press H at any time to hear this guide again.';

  // ── Global keydown handlers ────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    // Alt+V — toggle self-voicing
    if (e.altKey && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      speech.toggle();
      return;
    }

    // H — replay the full keyboard guide
    if ((e.key === 'h' || e.key === 'H') && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      speech.speak(KEYBOARD_GUIDE, { interrupt: true });
      a11y.announce('Keyboard guide', 'polite');
      updateCaption('Keyboard guide — listening…');
    }
  });

  // ── Startup narration ──────────────────────────────────────────────────────
  // Chrome gates speechSynthesis.speak() behind a user gesture.  setTimeout
  // fires before any gesture and fails silently.  Instead we listen for the
  // first keydown (capture phase, ahead of all game handlers) and speak there,
  // which satisfies the gesture requirement.  AudioContext is also resumed here
  // in case it was auto-suspended before the first interaction.
  window.addEventListener('keydown', function onFirstKey() {
    audioContext.resume();
    speech.speak(
      'Welcome to Pulse City. ' +
      'Press Tab to pulse scan and hear what surrounds you. ' +
      'W A S D to move. Space to jump. F to interact. ' +
      'Screen reader users can now turn off their screen reader. ' +
      'To turn off self-voicing, press Alt V. ' +
      'Press H for the full keyboard guide.',
    );
  }, { once: true, capture: true });

  // ── Render loop ────────────────────────────────────────────────────────
  engine.runRenderLoop(() => {
    const deltaMs = scene.deltaTime || 16;
    const deltaS  = deltaMs / 1000;

    perf.record(deltaMs);
    input.poll();
    cc.update(deltaS);

    // Camera orbits the player
    camera.target.copyFrom(playerMesh.getAbsolutePosition());
    camera.alpha += (look.right - look.left) * LOOK_SPEED * deltaS;
    camera.beta  -= (look.up   - look.down)  * LOOK_SPEED * deltaS;
    camera.beta   = Math.max(0.1, Math.min(Math.PI / 2, camera.beta));

    scene.render();
  });

  window.addEventListener('resize', () => engine.resize());

  window.addEventListener('beforeunload', () => {
    perf.dispose();
    speech.dispose();
    loader.dispose();
    colorblindPostProcess.dispose();
    pulsePostProcess.dispose();
    pipeline.dispose();
    glow.dispose();
    cbManager.dispose();
    cc.dispose();
    spatial.dispose();
    pulse.dispose();
    unmount(app);
    input.dispose();
    a11y.dispose();
    scene.dispose();
    engine.dispose();
  });
}

init().catch(console.error);
