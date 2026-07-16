/**
 * PulseManager — Pulse City's signature multi-sensory mechanic.
 *
 * A single trigger() call fires three simultaneous outputs:
 *   • Visual  — exposes u_progress / u_active for the post-process shader
 *               via onProgress() callbacks (wired in main.js)
 *   • Audio   — synthesised downward frequency sweep via Web Audio API
 *   • Haptic  — four-step fade-out rumble via the Gamepad Vibration API
 *
 * Retrigger at any time: resets progress and restarts all three outputs.
 * No cooldown.
 *
 * Usage:
 *   const pulse = new PulseManager(scene, { audioContext, getGamepads });
 *   pulse.onTrigger(() => announce('Pulse scan activated'));
 *   pulse.onProgress((p) => shaderEffect.setFloat('u_progress', p));
 *   input.onCommand((cmd, val) => { if (cmd === 'pulse_scan' && val) pulse.trigger(); });
 *   pulse.dispose(); // on scene teardown
 */

export const PulseState = Object.freeze({
  IDLE:    'idle',
  PULSING: 'pulsing',
});

// Haptic fade-out: four steps with linearly decreasing intensity.
const HAPTIC_STEPS = [
  { delay:   0, duration: 180, strong: 1.0,  weak: 0.6  },
  { delay: 180, duration: 180, strong: 0.7,  weak: 0.35 },
  { delay: 360, duration: 180, strong: 0.35, weak: 0.15 },
  { delay: 540, duration: 150, strong: 0.1,  weak: 0.04 },
];

// Audio sweep parameters.
const AUDIO_START_HZ  = 800;
const AUDIO_END_HZ    = 180;
const AUDIO_DURATION  = 0.7;   // seconds
const AUDIO_START_AMP = 0.28;
const AUDIO_END_AMP   = 0.001; // must be > 0 for exponentialRamp

export class PulseManager {
  #scene;
  #durationMs;
  #getGamepads;
  #audioContext;

  #state;
  #triggerTime;   // Date.now() when last triggered
  #progress;      // 0-1

  #triggerSubs;   // Set<() => void>
  #progressSubs;  // Set<(number) => void>

  #renderObserver;
  #hapticTimers;
  #disposed;

  /**
   * @param {object} scene  — Babylon.js Scene (only shape needed: onBeforeRenderObservable)
   * @param {{
   *   durationMs?: number,
   *   getGamepads?: () => (Gamepad|null)[],
   *   audioContext?: AudioContext|null,
   * }} [options]
   */
  constructor(scene, {
    durationMs   = 800,
    getGamepads  = () => navigator.getGamepads?.() ?? [],
    audioContext = null,
  } = {}) {
    this.#scene        = scene;
    this.#durationMs   = durationMs;
    this.#getGamepads  = getGamepads;
    this.#audioContext = audioContext;

    this.#state       = PulseState.IDLE;
    this.#triggerTime = 0;
    this.#progress    = 0;

    this.#triggerSubs  = new Set();
    this.#progressSubs = new Set();
    this.#hapticTimers = [];
    this.#disposed     = false;

    this.#renderObserver = this.#scene.onBeforeRenderObservable.add(
      () => this.#onRenderTick(),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get state()      { return this.#state; }
  get progress()   { return this.#progress; }
  get durationMs() { return this.#durationMs; }

  /**
   * Fire (or retrigger) the pulse. Always resets progress and restarts
   * all sensory outputs immediately.
   */
  trigger() {
    if (this.#disposed) return;

    this.#state       = PulseState.PULSING;
    this.#triggerTime = Date.now();
    this.#progress    = 0;

    this.#startHaptics();
    this.#playSweep();

    for (const cb of this.#triggerSubs) cb();
  }

  /**
   * Subscribe to trigger events.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe
   */
  onTrigger(callback) {
    this.#triggerSubs.add(callback);
    return () => this.#triggerSubs.delete(callback);
  }

  /**
   * Subscribe to per-frame progress updates (fires only while PULSING).
   * @param {(progress: number) => void} callback
   * @returns {() => void} unsubscribe
   */
  onProgress(callback) {
    this.#progressSubs.add(callback);
    return () => this.#progressSubs.delete(callback);
  }

  /** Detach from the scene, stop pending haptics, clear all subscribers. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    this.#scene.onBeforeRenderObservable.remove(this.#renderObserver);
    this.#renderObserver = null;

    this.#clearHapticTimers();
    this.#triggerSubs.clear();
    this.#progressSubs.clear();

    this.#state    = PulseState.IDLE;
    this.#progress = 0;
  }

  // ---------------------------------------------------------------------------
  // Private — render loop
  // ---------------------------------------------------------------------------

  #onRenderTick() {
    if (this.#state !== PulseState.PULSING) return;

    const elapsed = Date.now() - this.#triggerTime;
    this.#progress = Math.min(elapsed / this.#durationMs, 1.0);

    for (const cb of this.#progressSubs) cb(this.#progress);

    if (this.#progress >= 1.0) {
      this.#state    = PulseState.IDLE;
      this.#progress = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Private — haptics
  // ---------------------------------------------------------------------------

  #clearHapticTimers() {
    for (const t of this.#hapticTimers) clearTimeout(t);
    this.#hapticTimers = [];
  }

  #startHaptics() {
    this.#clearHapticTimers();

    for (const step of HAPTIC_STEPS) {
      const t = setTimeout(() => {
        const gp = this.#getGamepads()[0];
        if (!gp?.vibrationActuator) return;
        gp.vibrationActuator.playEffect('dual-rumble', {
          startDelay:      0,
          duration:        step.duration,
          weakMagnitude:   step.weak,
          strongMagnitude: step.strong,
        });
      }, step.delay);
      this.#hapticTimers.push(t);
    }
  }

  // ---------------------------------------------------------------------------
  // Private — audio
  // ---------------------------------------------------------------------------

  #playSweep() {
    const ctx = this.#audioContext;
    if (!ctx) return;

    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(AUDIO_START_HZ, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      AUDIO_END_HZ,
      ctx.currentTime + AUDIO_DURATION,
    );

    gain.gain.setValueAtTime(AUDIO_START_AMP, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      AUDIO_END_AMP,
      ctx.currentTime + AUDIO_DURATION,
    );

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + AUDIO_DURATION);
  }
}
