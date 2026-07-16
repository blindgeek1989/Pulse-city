/**
 * SpatialAudioManager — spatial beacon system for Pulse City's scan mechanic.
 *
 * After each Pulse scan, all registered meshes play a brief synthesised beacon
 * tone sequentially, sorted nearest-first. Each NodeType has a distinct
 * frequency and wavetype so players can identify object types by sound alone.
 *
 * The Web Audio PannerNode places each beacon in 3D space relative to the
 * camera's position and orientation, updated every render tick via the
 * AudioListener.
 *
 * Usage:
 *   const spatial = new SpatialAudioManager(scene, { audioContext, getCamera });
 *   spatial.register(mesh, { type: NodeType.WAYPOINT, label: 'Checkpoint' });
 *   pulse.onTrigger(() => spatial.trigger());
 *   spatial.dispose(); // on scene teardown
 */

import { NodeType } from './AccessibilityObserver.js';

// Frequency + waveform for each NodeType — distinct enough to identify by ear.
// null → this type never emits a beacon (e.g. PLAYER, which is the listener).
const BEACON_TONES = Object.freeze({
  [NodeType.PLAYER]:      null,
  [NodeType.VEHICLE]:     { freq: 80,   waveType: 'sawtooth' },
  [NodeType.NPC]:         { freq: 400,  waveType: 'sine'     },
  [NodeType.WAYPOINT]:    { freq: 880,  waveType: 'sine'     },
  [NodeType.OBSTACLE]:    { freq: 220,  waveType: 'square'   },
  [NodeType.HAZARD]:      { freq: 150,  waveType: 'square'   },
  [NodeType.COLLECTIBLE]: { freq: 1200, waveType: 'sine'     },
});

const BEACON_VOLUME = 0.25;
const ATTACK_S      = 0.01;  // 10 ms fade-in to avoid clicks
const RELEASE_S     = 0.05;  // 50 ms fade-out before oscillator stops

export class SpatialAudioManager {
  #scene;
  #audioContext;
  #getCamera;
  #beaconDurationMs;
  #beaconGapMs;
  #tracked;          // Map<mesh, { type, label }>
  #sequenceTimers;   // setTimeout ids for the current sweep
  #renderObserver;
  #disposed;

  /**
   * @param {object} scene  — Babylon.js Scene (needs onBeforeRenderObservable)
   * @param {{
   *   audioContext?:     AudioContext | null,
   *   getCamera?:        () => object | null,
   *   beaconDurationMs?: number,
   *   beaconGapMs?:      number,
   * }} [options]
   */
  constructor(scene, {
    audioContext     = null,
    getCamera        = () => scene.activeCamera,
    beaconDurationMs = 400,
    beaconGapMs      = 80,
  } = {}) {
    this.#scene           = scene;
    this.#audioContext    = audioContext;
    this.#getCamera       = getCamera;
    this.#beaconDurationMs = beaconDurationMs;
    this.#beaconGapMs      = beaconGapMs;
    this.#tracked          = new Map();
    this.#sequenceTimers   = [];
    this.#disposed         = false;

    this.#renderObserver = this.#scene.onBeforeRenderObservable.add(
      () => this.#onRenderTick(),
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get trackedCount()     { return this.#tracked.size; }
  get beaconDurationMs() { return this.#beaconDurationMs; }
  get beaconGapMs()      { return this.#beaconGapMs; }

  register(mesh, { type = NodeType.OBSTACLE, label = '' } = {}) {
    this.#tracked.set(mesh, { type, label });
  }

  unregister(mesh) {
    this.#tracked.delete(mesh);
  }

  /** Trigger the beacon sweep. Cancels any sweep currently in progress. */
  trigger() {
    if (this.#disposed) return;
    if (!this.#audioContext) return;

    this.#cancelSequence();

    const camera    = this.#getCamera();
    const camPos    = camera?.position ?? { x: 0, y: 0, z: 0 };
    const candidates = [];

    for (const [mesh, info] of this.#tracked) {
      if (!mesh.isVisible)  continue;
      if (!mesh.isEnabled()) continue;
      const tone = BEACON_TONES[info.type];
      if (!tone) continue; // null → PLAYER or unmapped type

      const pos  = mesh.absolutePosition ?? mesh.position;
      const dx   = pos.x - camPos.x;
      const dy   = pos.y - camPos.y;
      const dz   = pos.z - camPos.z;
      candidates.push({ mesh, info, dist: Math.sqrt(dx * dx + dy * dy + dz * dz) });
    }

    if (candidates.length === 0) return;

    candidates.sort((a, b) => a.dist - b.dist); // nearest first

    const step = this.#beaconDurationMs + this.#beaconGapMs;
    for (let i = 0; i < candidates.length; i++) {
      const { mesh, info } = candidates[i];
      const t = setTimeout(() => this.#playBeacon(mesh, info.type), i * step);
      this.#sequenceTimers.push(t);
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#scene.onBeforeRenderObservable.remove(this.#renderObserver);
    this.#renderObserver = null;

    this.#cancelSequence();
    this.#tracked.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #cancelSequence() {
    for (const t of this.#sequenceTimers) clearTimeout(t);
    this.#sequenceTimers = [];
  }

  #onRenderTick() {
    const ctx    = this.#audioContext;
    const camera = this.#getCamera();
    if (!ctx || !camera) return;

    const pos = camera.position;
    ctx.listener.setPosition(pos.x, pos.y, pos.z);

    const forward = camera.getForwardRay?.(1).direction ?? { x: 0, y: 0, z: 1 };
    ctx.listener.setOrientation(
      forward.x, forward.y, forward.z,
      0, 1, 0, // Y-up (Babylon.js left-handed coordinate system)
    );
  }

  #playBeacon(mesh, type) {
    const ctx  = this.#audioContext;
    const tone = BEACON_TONES[type];
    if (!ctx || !tone) return;

    const durationS = this.#beaconDurationMs / 1000;
    const now       = ctx.currentTime;

    // Spatial positioning
    const panner         = ctx.createPanner();
    panner.panningModel  = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance   = 5;
    panner.maxDistance   = 100;
    panner.rolloffFactor = 1;

    const pos = mesh.absolutePosition ?? mesh.position;
    panner.setPosition(pos.x, pos.y, pos.z);

    // Soft amplitude envelope — prevents clicks at start/end
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(BEACON_VOLUME, now + ATTACK_S);
    gain.gain.setValueAtTime(BEACON_VOLUME, now + durationS - RELEASE_S);
    gain.gain.linearRampToValueAtTime(0, now + durationS);

    // Tone generator
    const osc           = ctx.createOscillator();
    osc.type            = tone.waveType;
    osc.frequency.value = tone.freq;

    // osc → gain → panner → destination
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + durationS);
  }
}
