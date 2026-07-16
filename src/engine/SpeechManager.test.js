import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpeechManager } from './SpeechManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockUtterance {
  constructor(text) { this.text = text; }
}

function makeSynth() {
  return { speak: vi.fn(), cancel: vi.fn() };
}

function makeManager({ enabled = true, synth, Utterance } = {}) {
  synth     ??= makeSynth();
  Utterance ??= MockUtterance;
  return { manager: new SpeechManager({ synth, Utterance, enabled }), synth, Utterance };
}

// Returns the text of the last utterance passed to synth.speak().
function lastSpoken(synth) {
  const calls = synth.speak.mock.calls;
  return calls[calls.length - 1]?.[0]?.text ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpeechManager', () => {
  let manager, synth;

  afterEach(() => manager?.dispose());

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('defaults to enabled = true', () => {
      ({ manager, synth } = makeManager());
      expect(manager.enabled).toBe(true);
    });

    it('accepts enabled = false', () => {
      ({ manager, synth } = makeManager({ enabled: false }));
      expect(manager.enabled).toBe(false);
    });

    it('does not crash when synth is null', () => {
      expect(() => {
        manager = new SpeechManager({ synth: null, Utterance: MockUtterance });
      }).not.toThrow();
    });

    it('does not crash when Utterance is null', () => {
      expect(() => {
        manager = new SpeechManager({ synth: makeSynth(), Utterance: null });
      }).not.toThrow();
    });
  });

  // ── speak() ───────────────────────────────────────────────────────────────

  describe('speak()', () => {
    beforeEach(() => { ({ manager, synth } = makeManager()); });

    it('calls synth.speak() with an utterance containing the text', () => {
      manager.speak('Hello world');
      expect(synth.speak).toHaveBeenCalledOnce();
      expect(lastSpoken(synth)).toBe('Hello world');
    });

    it('does not call synth.speak() when disabled', () => {
      manager.toggle(); // → off
      synth.speak.mockClear();
      manager.speak('Should be silent');
      expect(synth.speak).not.toHaveBeenCalled();
    });

    it('interrupt=true cancels in-progress speech before speaking', () => {
      manager.speak('Urgent', { interrupt: true });
      const cancelOrder = synth.cancel.mock.invocationCallOrder[0];
      const speakOrder  = synth.speak.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(speakOrder);
    });

    it('interrupt=false (default) does not cancel', () => {
      manager.speak('Quiet');
      expect(synth.cancel).not.toHaveBeenCalled();
    });

    it('is a no-op when synth is null', () => {
      manager = new SpeechManager({ synth: null, Utterance: MockUtterance });
      expect(() => manager.speak('test')).not.toThrow();
    });

    it('is a no-op when Utterance is null', () => {
      manager = new SpeechManager({ synth: makeSynth(), Utterance: null });
      expect(() => manager.speak('test')).not.toThrow();
    });

    it('is a no-op after dispose()', () => {
      manager.dispose();
      manager.speak('Post-dispose');
      expect(synth.speak).not.toHaveBeenCalled();
    });
  });

  // ── toggle() ─────────────────────────────────────────────────────────────

  describe('toggle()', () => {
    beforeEach(() => { ({ manager, synth } = makeManager()); });

    it('switches enabled from true to false', () => {
      manager.toggle();
      expect(manager.enabled).toBe(false);
    });

    it('switches enabled from false to true', () => {
      manager.toggle(); // → false
      synth.speak.mockClear();
      manager.toggle(); // → true
      expect(manager.enabled).toBe(true);
    });

    it('returns the new enabled state', () => {
      expect(manager.toggle()).toBe(false);
    });

    it('speaks "Self-voicing on." when turning on', () => {
      manager.toggle(); // → off
      synth.speak.mockClear();
      manager.toggle(); // → on
      expect(lastSpoken(synth)).toBe('Self-voicing on.');
    });

    it('speaks "Self-voicing off." when turning off', () => {
      manager.toggle();
      expect(lastSpoken(synth)).toBe('Self-voicing off.');
    });

    it('cancels in-progress speech before speaking "Self-voicing off."', () => {
      manager.toggle();
      const cancelOrder = synth.cancel.mock.invocationCallOrder[0];
      const speakOrder  = synth.speak.mock.invocationCallOrder[0];
      expect(cancelOrder).toBeLessThan(speakOrder);
    });

    it('still speaks "Self-voicing off." even though enabled is now false', () => {
      manager.toggle();
      // synth.speak was called despite #enabled being false at that point
      expect(synth.speak).toHaveBeenCalled();
    });

    it('is a no-op after dispose()', () => {
      manager.dispose();
      synth.speak.mockClear();
      const result = manager.toggle();
      expect(result).toBe(true);           // enabled state unchanged (was true, stays true)
      expect(synth.speak).not.toHaveBeenCalled();
    });
  });

  // ── cancel() ─────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('calls synth.cancel()', () => {
      ({ manager, synth } = makeManager());
      manager.cancel();
      expect(synth.cancel).toHaveBeenCalled();
    });

    it('is safe when synth is null', () => {
      manager = new SpeechManager({ synth: null, Utterance: MockUtterance });
      expect(() => manager.cancel()).not.toThrow();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('calls cancel() to stop in-progress speech', () => {
      ({ manager, synth } = makeManager());
      manager.dispose();
      expect(synth.cancel).toHaveBeenCalled();
    });

    it('is safe to call twice', () => {
      ({ manager, synth } = makeManager());
      expect(() => { manager.dispose(); manager.dispose(); }).not.toThrow();
    });
  });
});
