/**
 * PerformanceMonitor — frame-budget tracker for Phase 4 profiling.
 *
 * Records per-frame delta times into a circular buffer and exposes rolling
 * statistics (fps, frameMs, min, max, budget status). No Babylon.js dependency
 * so it stays fully unit-testable.
 *
 * Usage in main.js render loop:
 *   const perf = new PerformanceMonitor();
 *   engine.runRenderLoop(() => {
 *     perf.record(scene.deltaTime || 16);
 *     // ...
 *   });
 *
 * Dev overlay:
 *   const unsub = perf.onUpdate(() => {
 *     console.log(perf.fps.toFixed(1), 'fps @', perf.frameMs.toFixed(2), 'ms');
 *   });
 */

export const FrameBudget = Object.freeze({
  GOOD:     'good',     // rolling avg ≤ 16.7 ms  (≥ 60 fps)
  WARNING:  'warning',  // rolling avg ≤ 33.3 ms  (30–60 fps)
  CRITICAL: 'critical', // rolling avg > 33.3 ms  (< 30 fps)
});

const BUDGET_60FPS = 1000 / 60;  // ~16.667 ms
const BUDGET_30FPS = 1000 / 30;  // ~33.333 ms

export class PerformanceMonitor {
  #windowSize;
  #samples;   // Float64Array circular buffer
  #head;      // next write position
  #count;     // samples filled so far (≤ windowSize)
  #sum;       // running sum of active samples
  #min;       // min over active window
  #max;       // max over active window
  #subscribers;
  #disposed;

  /**
   * @param {{ windowSize?: number }} [options]
   *   windowSize — number of frames in the rolling window (default 60).
   */
  constructor({ windowSize = 60 } = {}) {
    if (windowSize < 1) throw new RangeError('windowSize must be ≥ 1');
    this.#windowSize  = windowSize;
    this.#samples     = new Float64Array(windowSize);
    this.#head        = 0;
    this.#count       = 0;
    this.#sum         = 0;
    this.#min         = 0;
    this.#max         = 0;
    this.#subscribers = new Set();
    this.#disposed    = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Record a frame sample. Call once per render tick.
   * Samples ≤ 0 are silently ignored (can happen on the first engine tick).
   * @param {number} deltaMs  Frame delta time in milliseconds.
   */
  record(deltaMs) {
    if (this.#disposed || deltaMs <= 0) return;

    // Evict the oldest sample from the running sum when the buffer is full.
    if (this.#count === this.#windowSize) {
      this.#sum -= this.#samples[this.#head];
    }

    this.#samples[this.#head] = deltaMs;
    this.#head = (this.#head + 1) % this.#windowSize;
    if (this.#count < this.#windowSize) this.#count++;
    this.#sum += deltaMs;

    this.#recomputeMinMax();

    for (const cb of this.#subscribers) cb();
  }

  /** Rolling average frame time (ms) across the sample window. */
  get frameMs() {
    return this.#count > 0 ? this.#sum / this.#count : 0;
  }

  /** Rolling average frames per second. */
  get fps() {
    const ms = this.frameMs;
    return ms > 0 ? 1000 / ms : 0;
  }

  /** Minimum frame time in the current sample window (ms). */
  get min() { return this.#min; }

  /** Maximum frame time in the current sample window (ms). */
  get max() { return this.#max; }

  /** Frame budget status based on the rolling average frame time. */
  get budget() {
    const ms = this.frameMs;
    if (ms === 0)              return FrameBudget.GOOD;
    if (ms <= BUDGET_60FPS)    return FrameBudget.GOOD;
    if (ms <= BUDGET_30FPS)    return FrameBudget.WARNING;
    return FrameBudget.CRITICAL;
  }

  /** Number of frames currently in the sample window. */
  get sampleCount() { return this.#count; }

  /**
   * Subscribe to frame updates. The callback fires synchronously after every
   * record() call so the UI can stay in step with the render loop.
   * @param {() => void} callback
   * @returns {() => void} unsubscribe function
   */
  onUpdate(callback) {
    this.#subscribers.add(callback);
    return () => this.#subscribers.delete(callback);
  }

  /** Stop recording and detach all subscribers. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscribers.clear();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #recomputeMinMax() {
    const count = this.#count;
    if (count === 0) {
      this.#min = 0;
      this.#max = 0;
      return;
    }
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++) {
      // Walk backwards from #head to read active samples in insertion order.
      const idx = (this.#head - count + i + this.#windowSize) % this.#windowSize;
      const v = this.#samples[idx];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.#min = min;
    this.#max = max;
  }
}
