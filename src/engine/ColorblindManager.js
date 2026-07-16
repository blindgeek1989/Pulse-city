/**
 * ColorblindManager — colorblind correction mode state.
 *
 * Owns the active correction mode and notifies subscribers when it changes.
 * The actual PostProcess is created in main.js (same pattern as PulseManager):
 *
 *   BABYLON.Effect.ShadersStore['colorblindFragmentShader'] = src;
 *   const pp = new BABYLON.PostProcess('colorblind', 'colorblind', ['u_mode'], …);
 *   pp.onApply = (effect) => effect.setInt('u_mode', cbManager.mode);
 *
 * This class has no Babylon.js dependency so it remains fully unit-testable.
 *
 * Usage:
 *   const cb = new ColorblindManager();
 *   cb.onModeChange((mode) => announce(`Colorblind mode: ${ColorblindMode[mode]}`));
 *   cb.setMode(ColorblindMode.DEUTERANOPIA);
 *   cb.mode;    // → 1
 *   cb.dispose();
 */

export const ColorblindMode = Object.freeze({
  NONE:         0,
  DEUTERANOPIA: 1,
  PROTANOPIA:   2,
  TRITANOPIA:   3,
});

const VALID_MODES = new Set(Object.values(ColorblindMode));

export class ColorblindManager {
  #mode;
  #subscribers;
  #disposed;

  constructor() {
    this.#mode        = ColorblindMode.NONE;
    this.#subscribers = new Set();
    this.#disposed    = false;
  }

  /** The active correction mode integer (0–3). Pass to effect.setInt('u_mode', …). */
  get mode() { return this.#mode; }

  /**
   * Switch correction mode.
   * @param {number} mode  — a ColorblindMode value
   * @throws {RangeError}  — if mode is not a valid ColorblindMode
   */
  setMode(mode) {
    if (this.#disposed) return;
    if (!VALID_MODES.has(mode)) {
      throw new RangeError(`Unknown ColorblindMode: ${mode}`);
    }
    this.#mode = mode;
    for (const cb of this.#subscribers) cb(mode);
  }

  /**
   * Subscribe to mode changes. Fires immediately-after every setMode() call.
   * @param {(mode: number) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onModeChange(callback) {
    this.#subscribers.add(callback);
    return () => this.#subscribers.delete(callback);
  }

  /** Detach all subscribers. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscribers.clear();
  }
}
