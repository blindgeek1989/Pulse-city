/**
 * SpeechManager — self-voicing layer using the Web Speech API.
 *
 * Wraps window.speechSynthesis so the game can narrate itself without
 * requiring an external screen reader. On by default; toggled with Alt+V
 * (wired in main.js). Screen-reader users who don't need it turn it off
 * once — the toggle speaks the confirmation so they know it worked.
 *
 * Why separate from the ARIA announce bridge:
 *   Screen readers read the ARIA live regions directly. Self-voicing is for
 *   players who don't have a screen reader — so each channel can carry a
 *   message tuned to its audience: the ARIA path stays terse, self-voicing
 *   speaks in natural, first-person sentences.
 *
 * The pulse-scan trigger is the one place where the two messages deliberately
 * differ — see main.js. All other game events use announce() which fans out
 * the same text to ARIA + caption + self-voicing.
 *
 * Usage:
 *   const speech = new SpeechManager();
 *   speech.speak('Welcome to Pulse City.');
 *   speech.speak('Warning!', { interrupt: true });
 *   speech.toggle();         // 'Self-voicing off.' then silences
 *   speech.toggle();         // 'Self-voicing on.'
 *   speech.dispose();
 *
 * Dependency injection:
 *   Pass { synth, Utterance } to replace the browser globals — keeps tests
 *   fast and deterministic without jsdom needing a Speech implementation.
 */

export class SpeechManager {
  #synth;
  #Utterance;
  #enabled;
  #disposed;

  /**
   * @param {{
   *   synth?:     SpeechSynthesis | null,
   *   Utterance?: typeof SpeechSynthesisUtterance | null,
   *   enabled?:   boolean,
   * }} [options]
   */
  constructor({
    synth     = typeof globalThis.speechSynthesis !== 'undefined'
                  ? globalThis.speechSynthesis : null,
    Utterance = typeof globalThis.SpeechSynthesisUtterance !== 'undefined'
                  ? globalThis.SpeechSynthesisUtterance : null,
    enabled   = true,
  } = {}) {
    this.#synth     = synth;
    this.#Utterance = Utterance;
    this.#enabled   = enabled;
    this.#disposed  = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Whether self-voicing is currently active. */
  get enabled() { return this.#enabled; }

  /**
   * Speak `text` if self-voicing is enabled.
   *
   * @param {string}  text
   * @param {{ interrupt?: boolean }} [options]
   *   interrupt — cancel any in-progress speech before queuing this utterance
   *               (use for assertive / safety-critical messages)
   */
  speak(text, { interrupt = false } = {}) {
    if (this.#disposed || !this.#enabled || !this.#synth || !this.#Utterance) return;
    if (interrupt) this.#synth.cancel();
    this.#synth.speak(new this.#Utterance(text));
  }

  /**
   * Toggle self-voicing on / off.
   *
   * Always speaks a confirmation so the user knows the action registered —
   * the "off" message bypasses the enabled check (it's the last utterance
   * before the system goes silent).
   *
   * @returns {boolean} The new enabled state.
   */
  toggle() {
    if (this.#disposed) return this.#enabled;

    const wasEnabled = this.#enabled;
    this.#enabled = !wasEnabled;

    if (wasEnabled) {
      // Turning off: speak one final goodbye, then silence future calls.
      // We bypass speak() because #enabled is now false.
      if (this.#synth && this.#Utterance) {
        this.#synth.cancel();
        this.#synth.speak(new this.#Utterance('Self-voicing off.'));
      }
    } else {
      this.speak('Self-voicing on.');
    }

    return this.#enabled;
  }

  /** Immediately cancel all queued and in-progress speech. */
  cancel() {
    this.#synth?.cancel();
  }

  /** Cancel speech and prevent any further output. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.cancel();
  }
}
