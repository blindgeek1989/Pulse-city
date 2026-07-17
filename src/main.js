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
  scene.fogDensity = 0.006;   // reduced — open world needs longer sightlines
  scene.fogColor   = new BABYLON.Color3(0.005, 0.002, 0.018);
  scene.clearColor = new BABYLON.Color4(0.004, 0.001, 0.012, 1.0);

  // Dim hemispheric fill — the city blocks most natural light.
  const sky = new BABYLON.HemisphericLight('sky', new BABYLON.Vector3(0.3, 1, 0.5), scene);
  sky.intensity    = 0.35;
  sky.diffuse      = new BABYLON.Color3(0.15, 0.08, 0.25);   // cool purple sky
  sky.groundColor  = new BABYLON.Color3(0.01, 0.002, 0.02);  // near-black ground bounce

  // ── Scene geometry ─────────────────────────────────────────────────────
  const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 600, height: 600 }, scene);
  new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.8 }, scene);
  ground.isPickable = true;

  const asphaltMat = new BABYLON.PBRMaterial('asphalt', scene);
  asphaltMat.albedoColor = new BABYLON.Color3(0.02, 0.02, 0.035);
  asphaltMat.metallic    = 0.15;   // wet road sheen
  asphaltMat.roughness   = 0.28;
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
  const glow = new BABYLON.GlowLayer('neonGlow', scene);
  glow.intensity      = 2.2;
  glow.blurKernelSize = 96;

  // ── Night sky dome ─────────────────────────────────────────────────────
  // Large inside-out sphere textured with a starfield + horizon neon glow.
  const skyDome = BABYLON.MeshBuilder.CreateSphere('skyDome',
    { diameter: 900, segments: 8, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
  skyDome.isPickable = false;
  const skyTex = new BABYLON.DynamicTexture('skyTex', { width: 1024, height: 512 }, scene, false);
  const skyCtx = skyTex.getContext();
  // Vertical gradient: near-black zenith → deep purple horizon glow.
  const skyGrad = skyCtx.createLinearGradient(0, 0, 0, 512);
  skyGrad.addColorStop(0,    '#00000a');
  skyGrad.addColorStop(0.55, '#08001c');
  skyGrad.addColorStop(0.82, '#18003c');
  skyGrad.addColorStop(1,    '#2e006e');
  skyCtx.fillStyle = skyGrad;
  skyCtx.fillRect(0, 0, 1024, 512);
  // Stars — random white dots concentrated in the upper half.
  for (let i = 0; i < 350; i++) {
    const sx = Math.random() * 1024;
    const sy = Math.random() * 380;
    const sa = Math.random() * 0.75 + 0.25;
    const ss = Math.random() < 0.08 ? 2 : 1;
    skyCtx.fillStyle = `rgba(255,255,255,${sa})`;
    skyCtx.fillRect(sx, sy, ss, ss);
  }
  // Neon city glow band at the horizon.
  const horizGrad = skyCtx.createLinearGradient(0, 370, 0, 512);
  horizGrad.addColorStop(0, 'rgba(80,0,180,0)');
  horizGrad.addColorStop(0.5, 'rgba(100,0,220,0.35)');
  horizGrad.addColorStop(1, 'rgba(20,0,80,0.6)');
  skyCtx.fillStyle = horizGrad;
  skyCtx.fillRect(0, 370, 1024, 142);
  // Distant cyan glow on one side (city core).
  skyCtx.fillStyle = 'rgba(0,180,255,0.12)';
  skyCtx.fillRect(600, 400, 424, 112);
  // Moon — soft white-cyan orb.
  skyCtx.beginPath();
  skyCtx.arc(820, 90, 22, 0, Math.PI * 2);
  skyCtx.fillStyle = 'rgba(200,230,255,0.9)';
  skyCtx.fill();
  skyCtx.beginPath();
  skyCtx.arc(820, 90, 30, 0, Math.PI * 2);
  skyCtx.fillStyle = 'rgba(150,200,255,0.15)';
  skyCtx.fill();
  skyTex.update();
  const skyMat = new BABYLON.StandardMaterial('skyMat', scene);
  skyMat.emissiveTexture = skyTex;
  skyMat.disableLighting = true;
  skyMat.backFaceCulling  = false;
  skyDome.material = skyMat;
  // Exclude sky dome from the glow layer so it doesn't bloom.
  glow.addExcludedMesh(skyDome);

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
  // Self-voicing: interrupt so the beacon count plays immediately even if the
  // welcome message is still speaking.
  pulse.onTrigger(() => {
    a11y.announce('Pulse scan', 'polite');
    updateCaption('Pulse scan');
    const n = spatial.trackedCount;
    speech.speak(
      n === 0 ? 'Pulse scan — nothing detected.'
              : `Pulse scan — ${n} ${n === 1 ? 'beacon' : 'beacons'} nearby.`,
      { interrupt: true },
    );
  });

  // ── Downtown city ──────────────────────────────────────────────────────
  // Procedural geometry: buildings, NPCs, and vehicles populate the scene
  // until real .glb assets replace them.  Every entity is registered with
  // both the AccessibilityObserver (DOM mirror) and SpatialAudioManager
  // (beacon audio) so the pulse scan can reveal the whole city.

  // Window-texture helper — draws a glowing grid of lit/unlit office windows.
  const WIN_COLORS = ['#00ffff','#ff00ff','#aaff22','#ffaa00','#6688ff','#ff5500','#00ffaa'];
  function _winTex(cols, rows) {
    const W = 512, H = 1024;
    const t  = new BABYLON.DynamicTexture('wt_' + Math.random(), { width: W, height: H }, scene, false);
    const c  = t.getContext();
    c.fillStyle = '#03030a';
    c.fillRect(0, 0, W, H);
    const cw = W / cols, rh = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let cl = 0; cl < cols; cl++) {
        if (Math.random() < 0.72) {
          c.fillStyle  = WIN_COLORS[Math.floor(Math.random() * WIN_COLORS.length)];
          c.globalAlpha = Math.random() * 0.5 + 0.5;
          c.fillRect(cl * cw + 2, r * rh + 2, cw - 4, rh - 4);
        }
      }
    }
    c.globalAlpha = 1;
    t.update();
    return t;
  }

  // Building helper — dark concrete body + window DynamicTexture emissive.
  // Returns { mesh, x, z, w, d, h, er, eg, eb } for roof-strip pass below.
  const _bData = [];
  function _building(id, x, z, w, d, h, er, eg, eb) {
    const b   = BABYLON.MeshBuilder.CreateBox(id, { width: w, height: h, depth: d }, scene);
    b.position.set(x, h / 2, z);
    new BABYLON.PhysicsAggregate(b, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
    const mat = new BABYLON.PBRMaterial(id + 'M', scene);
    mat.albedoColor   = new BABYLON.Color3(0.03, 0.03, 0.05);
    mat.metallic      = 0.35;
    mat.roughness     = 0.65;
    // Window grid as emissive texture — picked up by the GlowLayer.
    const winTex      = _winTex(Math.max(4, Math.round(w * 1.2)), Math.max(8, Math.round(h * 0.9)));
    mat.emissiveTexture = winTex;
    mat.emissiveColor   = new BABYLON.Color3(0.9, 0.9, 0.9);
    b.material = mat;
    _bData.push({ id, x, z, w, d, h, er, eg, eb });
    return b;
  }

  // NE block
  _building('bA1',  18, 25, 8, 10, 28, 0.00, 0.20, 1.00);
  _building('bA2',  28, 40, 6,  8, 42, 0.60, 0.00, 1.00);
  _building('bA3',  16, 50, 9,  7, 18, 0.00, 1.00, 0.40);

  // NW block
  _building('bB1', -20, 25, 8, 10, 32, 0.40, 0.00, 1.00);
  _building('bB2', -30, 38, 7,  9, 24, 0.00, 0.60, 1.00);
  _building('bB3', -18, 52, 9,  7, 38, 1.00, 0.30, 0.00);

  // SE block
  _building('bC1',  20, -22, 8, 12, 30, 0.00, 1.00, 0.80);
  _building('bC2',  30, -38, 6,  8, 22, 0.80, 0.00, 0.60);
  _building('bC3',  18, -50, 9,  9, 40, 0.00, 0.20, 1.00);

  // SW block
  _building('bD1', -22, -22, 9, 10, 34, 1.00, 0.00, 0.60);
  _building('bD2', -30, -36, 7,  8, 26, 0.00, 1.00, 0.60);
  _building('bD3', -18, -50, 8, 10, 44, 0.60, 0.20, 1.00);

  // ── Roof neon strips + building-top point lights ───────────────────────
  for (const { id, x, z, w, d, h, er, eg, eb } of _bData) {
    const strip = BABYLON.MeshBuilder.CreateBox(id + '_top',
      { width: w + 0.3, height: 0.4, depth: d + 0.3 }, scene);
    strip.position.set(x, h + 0.2, z);
    const sm = new BABYLON.StandardMaterial(id + '_topM', scene);
    sm.emissiveColor = new BABYLON.Color3(er, eg, eb);
    strip.material  = sm;

    const pl = new BABYLON.PointLight(id + '_pl', new BABYLON.Vector3(x, h + 1.5, z), scene);
    pl.diffuse    = new BABYLON.Color3(er * 0.8, eg * 0.8, eb * 0.8);
    pl.intensity  = 60;
    pl.range      = 22;
  }

  // ── Street-level neon signs ────────────────────────────────────────────
  function _sign(label, x, y, z, ry, r, g, b) {
    const W = 512, H = 128;
    const t  = new BABYLON.DynamicTexture('sg_' + label, { width: W, height: H }, scene, false);
    const c  = t.getContext();
    c.fillStyle = '#000000';
    c.fillRect(0, 0, W, H);
    c.font = 'bold 72px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = `rgb(${r},${g},${b})`;
    c.shadowColor = `rgb(${r},${g},${b})`;
    c.shadowBlur = 18;
    c.fillText(label, W / 2, H / 2);
    t.update();
    const p = BABYLON.MeshBuilder.CreatePlane('sp_' + label, { width: 5, height: 1.25 }, scene);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    const m = new BABYLON.StandardMaterial('sm_' + label, scene);
    m.emissiveTexture  = t;
    m.disableLighting  = true;
    m.backFaceCulling  = false;
    p.material = m;
  }

  _sign('CYBERTECH',    13,  8, 20, -Math.PI/2,  0, 255, 255);
  _sign('NEON RAMEN',  -13,  5, 18,  Math.PI/2, 255,   0, 180);
  _sign('JACK IN',       0, 12, 22,  Math.PI,     0, 255,  80);
  _sign('DARK MARKET',  13,  6, -18, -Math.PI/2, 255, 140,   0);
  _sign('SYNAPSE BAR', -13,  9, -20,  Math.PI/2,  80,  80, 255);
  _sign('CHROME CLUB',  20,  7,   0,  0,         255,   0, 100);

  // ── Road lane markings ────────────────────────────────────────────────
  // Dashed emissive strips running down the centre of each road axis.
  for (let i = -5; i <= 5; i++) {
    const dashZ = BABYLON.MeshBuilder.CreateBox('lnZ' + i,
      { width: 0.12, height: 0.01, depth: 2.4 }, scene);
    dashZ.position.set(0, 0.01, i * 9);
    const lmZ = new BABYLON.StandardMaterial('lnZm' + i, scene);
    lmZ.emissiveColor = new BABYLON.Color3(0.8, 0.6, 0.0);
    dashZ.material = lmZ;

    const dashX = BABYLON.MeshBuilder.CreateBox('lnX' + i,
      { width: 2.4, height: 0.01, depth: 0.12 }, scene);
    dashX.position.set(i * 9, 0.01, 0);
    const lmX = new BABYLON.StandardMaterial('lnXm' + i, scene);
    lmX.emissiveColor = new BABYLON.Color3(0.8, 0.6, 0.0);
    dashX.material = lmX;
  }

  // ── Street-level coloured point lights ───────────────────────────────
  const _streetLights = [
    [  6, 4,  6, 0.0, 0.6, 1.0],  [-6, 4,  6, 1.0, 0.0, 0.6],
    [  6, 4, -6, 0.0, 1.0, 0.5],  [-6, 4, -6, 0.8, 0.3, 0.0],
    [  0, 4, 12, 0.5, 0.0, 1.0],  [ 0, 4,-12, 0.0, 0.8, 1.0],
    [ 12, 4,  0, 1.0, 0.5, 0.0],  [-12, 4,  0, 0.2, 0.0, 1.0],
  ];
  for (const [i, [px, py, pz, r, g, b]] of _streetLights.entries()) {
    const sl = new BABYLON.PointLight('sl' + i, new BABYLON.Vector3(px, py, pz), scene);
    sl.diffuse   = new BABYLON.Color3(r, g, b);
    sl.intensity = 45;
    sl.range     = 18;
  }

  // Neon street barricade (obstacle) at the north cross-road
  const barricade = BABYLON.MeshBuilder.CreateBox('barricade', { width: 3, height: 1.2, depth: 0.4 }, scene);
  barricade.position.set(0, 0.6, 18);
  new BABYLON.PhysicsAggregate(barricade, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
  const barMat = new BABYLON.StandardMaterial('barMat', scene);
  barMat.emissiveColor = new BABYLON.Color3(1.0, 0.4, 0.0);
  barricade.material = barMat;
  a11y.register(barricade,    { type: NodeType.OBSTACLE, label: 'Barricade', priority: 'normal' });
  spatial.register(barricade, { type: NodeType.OBSTACLE, label: 'Barricade' });

  // ── NPCs ──────────────────────────────────────────────────────────────────
  const npcs = [];

  function _npc(id, x, z, label, dialog) {
    const mesh = BABYLON.MeshBuilder.CreateCapsule(id, { height: 1.8, radius: 0.35 }, scene);
    mesh.position.set(x, 0.9, z);
    const mat = new BABYLON.StandardMaterial(id + 'M', scene);
    mat.emissiveColor = new BABYLON.Color3(0.9, 0.0, 0.9);
    mesh.material = mat;
    a11y.register(mesh,    { type: NodeType.NPC, label, priority: 'normal' });
    spatial.register(mesh, { type: NodeType.NPC, label });
    npcs.push({ mesh, label, dialog });
    return mesh;
  }

  _npc('npc-vendor',   7, 10,
    'Street Vendor',
    'Data chips, stims, and neural upgrades — best prices on the grid. What are you looking for?');
  _npc('npc-guard',    7, 22,
    'Security Guard',
    'Keep moving, citizen. This block is under corporate surveillance. Have a productive day.');
  _npc('npc-bouncer', -7, 14,
    'Club Bouncer',
    'V I P list only tonight. Unless you have a data coin to spare, keep walking.');
  _npc('npc-courier', -7, 28,
    'Data Courier',
    'Can\'t stop — got a delivery. The net never sleeps and neither do I.');
  _npc('npc-hacker',   2, 38,
    'Street Hacker',
    'They took my rig but they can\'t take my mind. I can still see through the corporate feeds — all of it.');

  // Helper: find nearest NPC within reach and play their dialog via speech.
  function interactWithNearbyNPC() {
    let nearest = null;
    let nearestDist = 5; // metres
    for (const npc of npcs) {
      const d = BABYLON.Vector3.Distance(playerMesh.position, npc.mesh.position);
      if (d < nearestDist) { nearestDist = d; nearest = npc; }
    }
    if (nearest) {
      speech.speak(`${nearest.label} says: ${nearest.dialog}`, { interrupt: true });
      announce(`${nearest.label}: ${nearest.dialog}`);
    } else {
      speech.speak('Nobody close enough to talk to. Move toward a beacon and try again.', { interrupt: true });
    }
  }

  // ── Open world district zones ─────────────────────────────────────────────
  // Each zone uses coloured ground overlays, thematic structures, and NPCs.
  // The world extends 300+ units in each direction from downtown.

  // Coloured ground patch helper — thin box laid flat.
  function _zone(id, cx, cz, w, d, r, g, b) {
    const z = BABYLON.MeshBuilder.CreateBox(id, { width: w, height: 0.05, depth: d }, scene);
    z.position.set(cx, 0.025, cz);
    z.isPickable = false;
    const zm = new BABYLON.StandardMaterial(id + 'M', scene);
    zm.emissiveColor = new BABYLON.Color3(r, g, b);
    zm.alpha = 0.35;
    z.material = zm;
  }

  // Tree helper — dark-green pine (cone canopy + cylinder trunk).
  function _tree(id, x, z, h) {
    const trunk = BABYLON.MeshBuilder.CreateCylinder(id + 't', { height: h * 0.35, diameter: 0.4 }, scene);
    trunk.position.set(x, h * 0.175, z);
    const tm = new BABYLON.StandardMaterial(id + 'tM', scene);
    tm.emissiveColor = new BABYLON.Color3(0.25, 0.12, 0.05);
    trunk.material = tm;
    const canopy = BABYLON.MeshBuilder.CreateCylinder(id + 'c',
      { height: h * 0.8, diameterTop: 0, diameterBottom: h * 0.55 }, scene);
    canopy.position.set(x, h * 0.35 + h * 0.4, z);
    const cm = new BABYLON.StandardMaterial(id + 'cM', scene);
    cm.emissiveColor = new BABYLON.Color3(0.05, 0.28, 0.08);
    canopy.material = cm;
  }

  // Mountain peak helper — stacked rough boxes.
  function _peak(id, cx, cz, baseW, peakH) {
    for (let i = 0; i < 4; i++) {
      const frac = 1 - i * 0.22;
      const s = baseW * frac;
      const yBot = i * peakH * 0.25;
      const h = peakH * 0.3;
      const seg = BABYLON.MeshBuilder.CreateBox(id + '_s' + i,
        { width: s, height: h, depth: s }, scene);
      seg.position.set(cx + (Math.random() - 0.5) * 3, yBot + h / 2, cz + (Math.random() - 0.5) * 3);
      const pm = new BABYLON.StandardMaterial(id + '_sM' + i, scene);
      pm.emissiveColor = i === 3
        ? new BABYLON.Color3(0.95, 0.95, 1.0)      // snow cap
        : new BABYLON.Color3(0.28, 0.25, 0.30);    // dark rock
      seg.material = pm;
    }
  }

  // Suburb house helper.
  function _house(id, x, z, w, d, roofR, roofG, roofB) {
    const body = BABYLON.MeshBuilder.CreateBox(id, { width: w, height: 4, depth: d }, scene);
    body.position.set(x, 2, z);
    new BABYLON.PhysicsAggregate(body, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
    const bm = new BABYLON.StandardMaterial(id + 'M', scene);
    bm.emissiveColor = new BABYLON.Color3(0.06, 0.05, 0.08);
    body.material = bm;
    const roof = BABYLON.MeshBuilder.CreateCylinder(id + 'R',
      { height: 2.5, diameterTop: 0, diameterBottom: w * 1.1, tessellation: 4 }, scene);
    roof.position.set(x, 5.25, z);
    const rm = new BABYLON.StandardMaterial(id + 'RM', scene);
    rm.emissiveColor = new BABYLON.Color3(roofR, roofG, roofB);
    roof.material = rm;
  }

  // ── SUBURB ZONE (north, z 70–150) ─────────────────────────────────────────
  _zone('zSub', 0, 110, 160, 80, 0.04, 0.06, 0.04);   // dim green tint
  _house('h1',  15, 80,  10, 8,  0.6, 0.2, 0.1);
  _house('h2', -18, 85,  9, 7,   0.2, 0.5, 0.8);
  _house('h3',  22, 100, 10, 9,  0.8, 0.4, 0.1);
  _house('h4', -25, 105, 8,  8,  0.3, 0.7, 0.3);
  _house('h5',  10, 118, 11, 9,  0.7, 0.2, 0.5);
  _house('h6', -12, 125, 9,  8,  0.5, 0.5, 0.1);
  _house('h7',  28, 130, 10, 7,  0.2, 0.6, 0.7);
  _house('h8', -30, 138, 8,  9,  0.9, 0.3, 0.1);

  // Suburb waypoint beacon so pulse scan picks it up.
  const subWP = BABYLON.MeshBuilder.CreateSphere('subWP', { diameter: 1 }, scene);
  subWP.position.set(0, 0.5, 100);
  const subWPM = new BABYLON.StandardMaterial('subWPM', scene);
  subWPM.emissiveColor = new BABYLON.Color3(0.4, 0.9, 0.4);
  subWP.material = subWPM;
  a11y.register(subWP,    { type: NodeType.WAYPOINT, label: 'Suburbs — residential district', priority: 'normal' });
  spatial.register(subWP, { type: NodeType.WAYPOINT, label: 'Suburbs' });

  _npc('npc-sub1',  8, 90,  'Suburbanite',
    'Quiet neighbourhood — nothing like downtown. I like it that way. The kids are safer here.');
  _npc('npc-sub2', -8, 115, 'Delivery Worker',
    'Fourth run today. These suburbs go on forever. You need directions somewhere?');

  // ── FOREST ZONE (east, x 80–200, z 50–150) ───────────────────────────────
  _zone('zFor', 140, 95, 140, 120, 0.02, 0.12, 0.02);  // deep green
  for (let fi = 0; fi < 28; fi++) {
    const tx = 85 + Math.random() * 110;
    const tz = 45 + Math.random() * 105;
    const th = 6 + Math.random() * 8;
    _tree('tr' + fi, tx, tz, th);
  }
  const forWP = BABYLON.MeshBuilder.CreateSphere('forWP', { diameter: 1 }, scene);
  forWP.position.set(130, 0.5, 90);
  const forWPM = new BABYLON.StandardMaterial('forWPM', scene);
  forWPM.emissiveColor = new BABYLON.Color3(0.1, 0.8, 0.2);
  forWP.material = forWPM;
  a11y.register(forWP,    { type: NodeType.WAYPOINT, label: 'Forest — dense woodland', priority: 'normal' });
  spatial.register(forWP, { type: NodeType.WAYPOINT, label: 'Forest' });

  _npc('npc-for1', 110, 80, 'Forest Ranger',
    'Few people make it out this far. The trees are old — older than the city. Keep to the path.');
  _npc('npc-for2', 150, 110, 'Hermit',
    'Left the grid eight years ago. Best decision of my life. You should try it.');

  // ── MOUNTAIN ZONE (far north, z 160–280) ──────────────────────────────────
  _zone('zMnt', 0, 215, 200, 120, 0.15, 0.15, 0.18);  // grey rock tint
  _peak('pk1',   20, 180, 45, 60);
  _peak('pk2',  -35, 200, 50, 75);
  _peak('pk3',   50, 225, 38, 55);
  _peak('pk4',  -10, 250, 55, 80);
  _peak('pk5',   25, 265, 40, 65);

  const mntWP = BABYLON.MeshBuilder.CreateSphere('mntWP', { diameter: 1 }, scene);
  mntWP.position.set(0, 0.5, 170);
  const mntWPM = new BABYLON.StandardMaterial('mntWPM', scene);
  mntWPM.emissiveColor = new BABYLON.Color3(0.8, 0.9, 1.0);
  mntWP.material = mntWPM;
  a11y.register(mntWP,    { type: NodeType.WAYPOINT, label: 'Mountain pass — high altitude', priority: 'normal' });
  spatial.register(mntWP, { type: NodeType.WAYPOINT, label: 'Mountains' });

  _npc('npc-mnt1',  10, 175, 'Mountain Guide',
    'Altitude changes things. The air is different. People are different. Corporate signals don\'t reach this high.');
  _npc('npc-mnt2', -15, 220, 'Climber',
    'Those peaks ahead? Nobody owns them. No surveillance. No corps. Pure rock. Want to climb with me?');

  // ── FARMLAND ZONE (west, x -80 to -200, z -50 to 100) ────────────────────
  _zone('zFarm', -145, 30, 130, 160, 0.10, 0.08, 0.02);  // earth brown-yellow

  // Crop rows — long thin boxes suggesting tilled fields.
  for (let cr = 0; cr < 10; cr++) {
    const row = BABYLON.MeshBuilder.CreateBox('crop' + cr,
      { width: 60, height: 0.15, depth: 1.2 }, scene);
    row.position.set(-140, 0.08, -30 + cr * 10);
    const crm = new BABYLON.StandardMaterial('cropM' + cr, scene);
    crm.emissiveColor = new BABYLON.Color3(0.18, 0.22, 0.04);
    row.material = crm;
  }
  // Barn structure.
  const barnBody = BABYLON.MeshBuilder.CreateBox('barn', { width: 14, height: 7, depth: 22 }, scene);
  barnBody.position.set(-120, 3.5, 20);
  new BABYLON.PhysicsAggregate(barnBody, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
  const barnM = new BABYLON.StandardMaterial('barnM', scene);
  barnM.emissiveColor = new BABYLON.Color3(0.45, 0.08, 0.05);
  barnBody.material = barnM;
  const barnRoof = BABYLON.MeshBuilder.CreateCylinder('barnRoof',
    { height: 6, diameterTop: 0, diameterBottom: 16, tessellation: 4 }, scene);
  barnRoof.position.set(-120, 10, 20);
  const barnRM = new BABYLON.StandardMaterial('barnRM', scene);
  barnRM.emissiveColor = new BABYLON.Color3(0.5, 0.5, 0.1);
  barnRoof.material = barnRM;

  const farmWP = BABYLON.MeshBuilder.CreateSphere('farmWP', { diameter: 1 }, scene);
  farmWP.position.set(-110, 0.5, 0);
  const farmWPM = new BABYLON.StandardMaterial('farmWPM', scene);
  farmWPM.emissiveColor = new BABYLON.Color3(0.9, 0.8, 0.1);
  farmWP.material = farmWPM;
  a11y.register(farmWP,    { type: NodeType.WAYPOINT, label: 'Farmland — rural community', priority: 'normal' });
  spatial.register(farmWP, { type: NodeType.WAYPOINT, label: 'Farmland' });

  _npc('npc-farm1', -105, 15, 'Farmer',
    'City folk don\'t come out this way much. We grow real food here — not that printed stuff they sell downtown.');
  _npc('npc-farm2', -130, -20, 'Farm Hand',
    'Sun comes up, you work. Sun goes down, you rest. Simple life. Better than the corp grind, I\'ll tell you that.');

  // ── SECOND CITY (far east, x 150–260, z -50 to 80) ───────────────────────
  _zone('zCity2', 200, 20, 120, 140, 0.02, 0.01, 0.06);  // dark purple city tint
  const _bldg2 = (id, x, z, w, d, h, er, eg, eb) => {
    const b = BABYLON.MeshBuilder.CreateBox(id, { width: w, height: h, depth: d }, scene);
    b.position.set(x, h / 2, z);
    new BABYLON.PhysicsAggregate(b, BABYLON.PhysicsShapeType.BOX, { mass: 0 }, scene);
    const m = new BABYLON.PBRMaterial(id + 'M', scene);
    m.albedoColor = new BABYLON.Color3(0.02, 0.02, 0.04);
    m.metallic = 0.4; m.roughness = 0.6;
    m.emissiveColor = new BABYLON.Color3(er, eg, eb);
    b.material = m;
    // Roof light
    const pl = new BABYLON.PointLight(id + 'PL', new BABYLON.Vector3(x, h + 1.5, z), scene);
    pl.diffuse = new BABYLON.Color3(er, eg, eb);
    pl.intensity = 45; pl.range = 20;
  };
  _bldg2('c2A', 165, 10,  9, 11, 30, 0.0, 0.5, 1.0);
  _bldg2('c2B', 180, 35,  7,  8, 48, 0.8, 0.0, 0.6);
  _bldg2('c2C', 200, 10, 10, 12, 36, 0.0, 0.9, 0.5);
  _bldg2('c2D', 215, 40,  8,  9, 22, 1.0, 0.4, 0.0);
  _bldg2('c2E', 230, 15,  9, 10, 42, 0.4, 0.0, 1.0);
  _bldg2('c2F', 160, -20, 8,  8, 28, 0.0, 1.0, 0.7);
  _bldg2('c2G', 200, -35, 9, 11, 35, 0.7, 0.1, 0.9);

  const city2WP = BABYLON.MeshBuilder.CreateSphere('city2WP', { diameter: 1 }, scene);
  city2WP.position.set(160, 0.5, 0);
  const city2WPM = new BABYLON.StandardMaterial('city2WPM', scene);
  city2WPM.emissiveColor = new BABYLON.Color3(0.5, 0.0, 1.0);
  city2WP.material = city2WPM;
  a11y.register(city2WP,    { type: NodeType.WAYPOINT, label: 'Arcadia Heights — secondary city', priority: 'normal' });
  spatial.register(city2WP, { type: NodeType.WAYPOINT, label: 'Arcadia Heights' });

  _npc('npc-c2a', 170, 5,  'Tech Worker',
    'Arcadia Heights runs on clean energy. No neon, no noise — just pure data flow. Different vibe to downtown.');
  _npc('npc-c2b', 195, -15, 'Street Artist',
    'They tried to make this place sterile. We put the art back. See that mural on block seven? That\'s ours.');

  // ── Extended road lane markings for outer districts ────────────────────────
  // The inner road markings cover ±45. These extend the N-S and E-W roads further.
  for (const off of [-70, -55, 55, 70, 85, 100, 115, 130, 145, 160]) {
    const dZ = BABYLON.MeshBuilder.CreateBox('elZ' + off,
      { width: 0.12, height: 0.01, depth: 2.4 }, scene);
    dZ.position.set(0, 0.01, off);
    const mZ = new BABYLON.StandardMaterial('elZm' + off, scene);
    mZ.emissiveColor = new BABYLON.Color3(0.7, 0.5, 0.0);
    dZ.material = mZ;

    const dX = BABYLON.MeshBuilder.CreateBox('elX' + off,
      { width: 2.4, height: 0.01, depth: 0.12 }, scene);
    dX.position.set(off, 0.01, 0);
    const mX = new BABYLON.StandardMaterial('elXm' + off, scene);
    mX.emissiveColor = new BABYLON.Color3(0.7, 0.5, 0.0);
    dX.material = mX;
  }

  // ── Vehicles — waypoint-routed open world cars ───────────────────────────
  // Cars follow ordered Vector3 waypoint arrays.  They navigate city streets,
  // cross into suburbs, and loop through districts.  Each car has a named
  // driver the player can talk to while riding.
  const cars = [];

  // Shorthand: road-level waypoint
  const _wp = (x, z) => new BABYLON.Vector3(x, 0, z);

  // Named intersection nodes for district routing.
  // Roads run along x=0 (N-S) and z=0 (E-W) and outer ring at ±80.
  const NODE = {
    DOWNTOWN:    _wp(  0,    0),
    N_INNER:     _wp(  0,   40),
    N_OUTER:     _wp(  0,   90),
    S_INNER:     _wp(  0,  -40),
    S_OUTER:     _wp(  0,  -90),
    E_INNER:     _wp( 40,    0),
    E_OUTER:     _wp( 90,    0),
    W_INNER:     _wp(-40,    0),
    W_OUTER:     _wp(-90,    0),
    NE_CROSS:    _wp( 80,   80),
    NW_CROSS:    _wp(-80,   80),
    SE_CROSS:    _wp( 80,  -80),
    SW_CROSS:    _wp(-80,  -80),
    MOUNTAIN_RD: _wp(  0,  160),
    FARM_RD:     _wp(-160,   0),
    FOREST_RD:   _wp( 160,   0),
  };

  function _car(id, route, speed, driverName, greeting, chatLine, er, eg, eb) {
    const mesh = BABYLON.MeshBuilder.CreateBox(id, { width: 1.8, height: 1.2, depth: 4 }, scene);
    const startPt = route[0];
    mesh.position.set(startPt.x, 0.6, startPt.z);
    const mat = new BABYLON.StandardMaterial(id + 'M', scene);
    mat.emissiveColor = new BABYLON.Color3(er, eg, eb);
    mesh.material = mat;

    const panner = audioContext.createPanner();
    panner.panningModel  = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance   = 3;
    panner.maxDistance   = 120;
    panner.rolloffFactor = 1.5;
    panner.positionX.value = startPt.x;
    panner.positionY.value = 0.6;
    panner.positionZ.value = startPt.z;

    const osc = audioContext.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 55 + Math.random() * 30;
    const lpf = audioContext.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 300;
    const gn = audioContext.createGain();
    gn.gain.value = 0.45;
    osc.connect(lpf); lpf.connect(gn); gn.connect(panner);
    panner.connect(audioContext.destination);
    // osc NOT started here — deferred to startCityAmbience().

    const label = driverName + '\'s vehicle';
    a11y.register(mesh,    { type: NodeType.VEHICLE, label, priority: 'normal' });
    spatial.register(mesh, { type: NodeType.VEHICLE, label });

    // Stagger start position along the route so cars spread out naturally.
    const startOffset = Math.floor(Math.random() * route.length);
    cars.push({ mesh, panner, osc, route, wpIdx: startOffset, speed,
                driverName, greeting, chatLine });
  }

  // Tracks the car the player is currently riding (null = on foot).
  let enteredCar = null;

  // City Taxi — loops downtown through Neon District and back.
  _car('taxi-1',
    [NODE.DOWNTOWN, NODE.N_INNER, NODE.NW_CROSS, NODE.W_OUTER, NODE.W_INNER, NODE.DOWNTOWN],
    14, 'City Taxi', 'Hop in. I\'m looping through Neon District — you\'ll see the whole west side.',
    'We\'re passing through the neon market now. Wild night out there.',
    0.0, 0.9, 1.0);

  // Rideshare — east loop through Tech Quarter.
  _car('rideshare-1',
    [NODE.DOWNTOWN, NODE.E_INNER, NODE.NE_CROSS, NODE.N_OUTER, NODE.N_INNER, NODE.DOWNTOWN],
    12, 'Rideshare Driver', 'Tech Quarter run. Hop on — clean ride, no questions.',
    'Those towers on the right? Corporate servers. More data in there than the whole old internet.',
    0.8, 0.3, 1.0);

  // Industrial hauler — south circuit.
  _car('hauler-1',
    [NODE.DOWNTOWN, NODE.S_INNER, NODE.SW_CROSS, NODE.S_OUTER, NODE.SE_CROSS, NODE.E_INNER, NODE.DOWNTOWN],
    10, 'Cargo Hauler', 'Industrial zone run. I\'ve got a delivery, but you can ride along.',
    'This whole southern district used to be docks before they built the maglev overpass.',
    0.9, 0.5, 0.1);

  // Mountain express — long run north to the mountain road.
  _car('mountain-bus',
    [NODE.DOWNTOWN, NODE.N_INNER, NODE.N_OUTER, NODE.MOUNTAIN_RD, NODE.N_OUTER, NODE.N_INNER, NODE.DOWNTOWN],
    9, 'Mountain Bus Driver', 'Mountain express. Long ride — grab a seat. We go all the way to the ridge.',
    'Up ahead you\'ll start to feel the air change. Cleaner up there. Less corp surveillance too.',
    0.3, 0.7, 0.4);

  // ── City ambience audio ────────────────────────────────────────────────────
  // Called from onFirstKey after audioContext.resume() resolves.
  // Car oscillators are also started here — Chrome silently drops oscillators
  // that are started while the AudioContext is still suspended.
  function startCityAmbience() {
    // Car engine hums — start all deferred oscillators now.
    for (const car of cars) car.osc.start();

    // Layer 1 — city machinery drone: detuned sawtooth oscillators, soft lowpass to remove buzz.
    const droneOut = audioContext.createGain();
    droneOut.gain.value = 0.06;
    const droneLpf = audioContext.createBiquadFilter();
    droneLpf.type = 'lowpass';
    droneLpf.frequency.value = 180;  // cut high harmonics that cause harshness
    droneLpf.connect(audioContext.destination);
    droneOut.connect(droneLpf);
    for (const [hz, vol] of [[55, 0.5], [58.2, 0.4], [110, 0.3]]) {
      const o = audioContext.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      const g = audioContext.createGain();
      g.gain.value = vol;
      o.connect(g);
      g.connect(droneOut);
      o.start();
    }

    // Layer 2 — crowd murmur: narrow bandpass keeps it a low hum, not a hiss.
    // Q=4.0 (narrow) + low gain = defined murmur rather than broadband noise.
    const sr       = audioContext.sampleRate;
    const crowdBuf = audioContext.createBuffer(1, sr * 4, sr);
    const crowdD   = crowdBuf.getChannelData(0);
    for (let i = 0; i < crowdD.length; i++) crowdD[i] = Math.random() * 2 - 1;
    const crowd    = audioContext.createBufferSource();
    crowd.buffer   = crowdBuf;
    crowd.loop     = true;
    const crowdF   = audioContext.createBiquadFilter();
    crowdF.type    = 'bandpass';
    crowdF.frequency.value = 400;   // lower centre = voice-murmur range
    crowdF.Q.value = 4.0;           // narrow band — kills the hiss
    const crowdG   = audioContext.createGain();
    crowdG.gain.value = 0.04;       // was 0.18 — quiet background presence
    crowd.connect(crowdF);
    crowdF.connect(crowdG);
    crowdG.connect(audioContext.destination);
    crowd.start();

    // Layer 3 — distant traffic rumble: very low pass, very quiet.
    const rumbleBuf = audioContext.createBuffer(1, sr * 3, sr);
    const rumbleD   = rumbleBuf.getChannelData(0);
    for (let i = 0; i < rumbleD.length; i++) rumbleD[i] = Math.random() * 2 - 1;
    const rumble    = audioContext.createBufferSource();
    rumble.buffer   = rumbleBuf;
    rumble.loop     = true;
    const rumbleF   = audioContext.createBiquadFilter();
    rumbleF.type    = 'lowpass';
    rumbleF.frequency.value = 90;   // only sub-bass rumble passes
    const rumbleG   = audioContext.createGain();
    rumbleG.gain.value = 0.06;      // was 0.22 — felt below the engine hum
    rumble.connect(rumbleF);
    rumbleF.connect(rumbleG);
    rumbleG.connect(audioContext.destination);
    rumble.start();
  }

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
  // Restore colorblind preference saved from a previous session.
  const _savedCb = parseInt(localStorage.getItem('pulse-city-cb') ?? '0', 10);
  if (_savedCb) cbManager.setMode(_savedCb);

  // Announce mode changes and persist the choice to localStorage.
  cbManager.onModeChange((mode) => {
    localStorage.setItem('pulse-city-cb', mode);
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

  // Synthesised movement sounds via Web Audio — no audio files required.
  function playFootstep() {
    const t = audioContext.currentTime;
    // Short filtered noise burst: sounds like a quick mechanical step.
    const frames = Math.floor(audioContext.sampleRate * 0.07);
    const buf = audioContext.createBuffer(1, frames, audioContext.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = audioContext.createBufferSource();
    src.buffer = buf;

    const filter = audioContext.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 180;
    filter.Q.value = 1.2;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);
    src.start(t);
  }

  function playJump() {
    const t = audioContext.currentTime;
    // Rising sine sweep: 180 Hz → 520 Hz over 220 ms — a clear "boost" cue.
    const osc = audioContext.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.22);

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0.28, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);

    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  // ── Footstep engine ────────────────────────────────────────────────────────
  // Continuous footsteps while any directional key is held.
  // Uses recursive setTimeout so the sprint cadence (280 ms) kicks in
  // automatically on the next tick when Shift is pressed mid-walk.
  const heldMoveKeys = new Set();
  const MOVE_KEYS = new Set([
    GameCommand.MOVE_FORWARD, GameCommand.MOVE_BACK,
    GameCommand.STRAFE_LEFT,  GameCommand.STRAFE_RIGHT,
  ]);

  let _stepsRunning = false;
  function _stepTick() {
    if (!_stepsRunning) return;
    playFootstep();
    setTimeout(_stepTick, heldMoveKeys.has(GameCommand.SPRINT) ? 280 : 460);
  }
  function startFootsteps() { if (!_stepsRunning) { _stepsRunning = true;  _stepTick(); } }
  function stopFootsteps()  { _stepsRunning = false; }

  input.onCommand((cmd, val) => {
    // Movement commands only reach the CharacterController when on foot.
    if (!enteredCar) cc.onCommand(cmd, val);

    const firstPress = val === 1 && !heldMoveKeys.has(cmd);
    if (val === 1) heldMoveKeys.add(cmd);
    if (val === 0) heldMoveKeys.delete(cmd);

    // Footsteps only play while walking — not inside a vehicle.
    if (!enteredCar && [...MOVE_KEYS].some(c => heldMoveKeys.has(c))) startFootsteps();
    else stopFootsteps();

    // One-shot jump cue.
    if (cmd === GameCommand.JUMP && firstPress && !enteredCar) playJump();

    // NPC interaction — only when on foot (driver chat handled below when in vehicle).
    if (cmd === GameCommand.INTERACT && firstPress && !enteredCar) interactWithNearbyNPC();

    // Vehicle entry — E key: find nearest car within 5 m.
    if (cmd === GameCommand.ENTER_VEHICLE && firstPress && !enteredCar) {
      let nearest = null;
      let nearestDist = 5;
      for (const car of cars) {
        const d = BABYLON.Vector3.Distance(playerMesh.position, car.mesh.position);
        if (d < nearestDist) { nearestDist = d; nearest = car; }
      }
      if (nearest) {
        enteredCar = nearest;
        playerAggregate.body.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
        stopFootsteps();
        const msg = `${nearest.driverName} says: ${nearest.greeting} Press Q to exit, F to talk.`;
        speech.speak(msg, { interrupt: true });
        announce(`Entered ${nearest.driverName}'s vehicle`);
      } else {
        speech.speak('No vehicle close enough to enter. Pulse scan to find one.', { interrupt: true });
      }
    }

    // Talk to driver — F key while riding.
    if (cmd === GameCommand.INTERACT && firstPress && enteredCar) {
      speech.speak(`${enteredCar.driverName} says: ${enteredCar.chatLine}`, { interrupt: true });
      announce(`${enteredCar.driverName}: ${enteredCar.chatLine}`);
      return; // skip NPC interaction when in a vehicle
    }

    // Vehicle exit — Q key.
    if (cmd === GameCommand.EXIT_VEHICLE && firstPress && enteredCar) {
      const exitMsg = `${enteredCar.driverName} says: Safe travels. Press E near a vehicle to hop back in.`;
      enteredCar = null;
      playerAggregate.body.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
      speech.speak(exitMsg, { interrupt: true });
      announce('Exited vehicle');
    }

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
    audioContext.resume().then(startCityAmbience);
    speech.speak(
      'Welcome to Pulse City. ' +
      'Press Tab to pulse scan and hear what surrounds you. ' +
      'W A S D to move. Space to jump. F to interact with people nearby. ' +
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

    // Move cars along their waypoint routes and sync panner positions.
    for (const car of cars) {
      const target = car.route[car.wpIdx];
      const dx = target.x - car.mesh.position.x;
      const dz = target.z - car.mesh.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 2.0) {
        car.wpIdx = (car.wpIdx + 1) % car.route.length;
      } else {
        const step = car.speed * deltaS;
        car.mesh.position.x += (dx / dist) * step;
        car.mesh.position.z += (dz / dist) * step;
        car.mesh.rotation.y  = Math.atan2(dx, dz);
      }
      car.panner.positionX.value = car.mesh.position.x;
      car.panner.positionY.value = 0.6;
      car.panner.positionZ.value = car.mesh.position.z;
    }

    // When riding in a vehicle, snap the player (kinematic) to the car each frame.
    if (enteredCar) {
      const cp = enteredCar.mesh.position;
      playerMesh.position.set(cp.x, PLAYER_HEIGHT / 2 + 0.1, cp.z);
    }

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
