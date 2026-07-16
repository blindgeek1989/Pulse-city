import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PulseManager, PulseState } from './PulseManager.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeObservable() {
  const subs = [];
  return {
    add:    vi.fn((cb) => { subs.push(cb); return cb; }),
    remove: vi.fn((cb) => { const i = subs.indexOf(cb); if (i !== -1) subs.splice(i, 1); }),
    _fire:  () => subs.forEach((cb) => cb()),
  };
}

function makeScene() {
  return { onBeforeRenderObservable: makeObservable() };
}

function makeHapticGamepad() {
  return {
    connected: true,
    vibrationActuator: { playEffect: vi.fn(() => Promise.resolve()) },
  };
}

function makeAudioContext() {
  const osc = {
    type: null,
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    start:   vi.fn(),
    stop:    vi.fn(),
  };
  const gain = {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  return {
    createOscillator: vi.fn(() => osc),
    createGain:       vi.fn(() => gain),
    destination:      {},
    currentTime:      0,
    _osc:  osc,
    _gain: gain,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tick(scene, ms = 0) {
  vi.advanceTimersByTime(ms);
  scene.onBeforeRenderObservable._fire();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PulseManager', () => {
  let scene, manager;

  beforeEach(() => {
    vi.useFakeTimers();
    scene = makeScene();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('starts in IDLE state', () => {
      manager = new PulseManager(scene);
      expect(manager.state).toBe(PulseState.IDLE);
    });

    it('progress is 0 when idle', () => {
      manager = new PulseManager(scene);
      expect(manager.progress).toBe(0);
    });

    it('attaches a render observer on construction', () => {
      manager = new PulseManager(scene);
      expect(scene.onBeforeRenderObservable.add).toHaveBeenCalledOnce();
    });

    it('defaults durationMs to 800', () => {
      manager = new PulseManager(scene);
      expect(manager.durationMs).toBe(800);
    });

    it('accepts a custom durationMs', () => {
      manager = new PulseManager(scene, { durationMs: 400 });
      expect(manager.durationMs).toBe(400);
    });
  });

  // ── trigger() ─────────────────────────────────────────────────────────────

  describe('trigger()', () => {
    it('transitions from IDLE to PULSING', () => {
      manager = new PulseManager(scene);
      manager.trigger();
      expect(manager.state).toBe(PulseState.PULSING);
    });

    it('resets progress to 0 immediately on trigger', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 400);
      manager.trigger(); // retrigger mid-pulse
      expect(manager.progress).toBe(0);
    });

    it('can retrigger while already PULSING', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 400);
      expect(() => manager.trigger()).not.toThrow();
      expect(manager.state).toBe(PulseState.PULSING);
    });
  });

  // ── Progress ──────────────────────────────────────────────────────────────

  describe('progress', () => {
    it('is 0 immediately after trigger (before any render tick)', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      expect(manager.progress).toBe(0);
    });

    it('advances proportionally with elapsed time', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 400); // half duration
      expect(manager.progress).toBeCloseTo(0.5, 1);
    });

    it('clamps to 1.0 at the end of the pulse', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 800);
      expect(manager.progress).toBeLessThanOrEqual(1.0);
    });

    it('transitions back to IDLE when duration elapses', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 800);
      expect(manager.state).toBe(PulseState.IDLE);
    });

    it('resets to 0 after returning to IDLE', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      manager.trigger();
      tick(scene, 800);
      expect(manager.progress).toBe(0);
    });
  });

  // ── onTrigger() ───────────────────────────────────────────────────────────

  describe('onTrigger()', () => {
    it('returns an unsubscribe function', () => {
      manager = new PulseManager(scene);
      expect(typeof manager.onTrigger(() => {})).toBe('function');
    });

    it('fires the callback when trigger() is called', () => {
      manager = new PulseManager(scene);
      const cb = vi.fn();
      manager.onTrigger(cb);
      manager.trigger();
      expect(cb).toHaveBeenCalledOnce();
    });

    it('fires again on retrigger mid-pulse', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      const cb = vi.fn();
      manager.onTrigger(cb);
      manager.trigger();
      tick(scene, 400);
      manager.trigger();
      expect(cb).toHaveBeenCalledTimes(2);
    });

    it('unsubscribed callback does not fire', () => {
      manager = new PulseManager(scene);
      const cb = vi.fn();
      const unsub = manager.onTrigger(cb);
      unsub();
      manager.trigger();
      expect(cb).not.toHaveBeenCalled();
    });

    it('notifies all registered callbacks', () => {
      manager = new PulseManager(scene);
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      manager.onTrigger(cb1);
      manager.onTrigger(cb2);
      manager.trigger();
      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });

  // ── onProgress() ──────────────────────────────────────────────────────────

  describe('onProgress()', () => {
    it('returns an unsubscribe function', () => {
      manager = new PulseManager(scene);
      expect(typeof manager.onProgress(() => {})).toBe('function');
    });

    it('fires with current progress on each render tick while PULSING', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      const cb = vi.fn();
      manager.onProgress(cb);
      manager.trigger();
      tick(scene, 400);
      expect(cb).toHaveBeenCalledWith(expect.closeTo(0.5, 1));
    });

    it('does not fire when IDLE', () => {
      manager = new PulseManager(scene);
      const cb = vi.fn();
      manager.onProgress(cb);
      tick(scene, 100);
      expect(cb).not.toHaveBeenCalled();
    });

    it('notifies multiple subscribers', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      manager.onProgress(cb1);
      manager.onProgress(cb2);
      manager.trigger();
      tick(scene, 200);
      expect(cb1).toHaveBeenCalled();
      expect(cb2).toHaveBeenCalled();
    });

    it('unsubscribed callback no longer fires', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      const cb = vi.fn();
      const unsub = manager.onProgress(cb);
      manager.trigger();
      tick(scene, 200);
      unsub();
      tick(scene, 200);
      const callCountAfterUnsub = cb.mock.calls.length;
      tick(scene, 200);
      expect(cb.mock.calls.length).toBe(callCountAfterUnsub);
    });
  });

  // ── Haptics ───────────────────────────────────────────────────────────────

  describe('haptics', () => {
    it('calls vibrationActuator.playEffect on trigger', () => {
      const gp = makeHapticGamepad();
      manager = new PulseManager(scene, { getGamepads: () => [gp] });
      manager.trigger();
      vi.advanceTimersByTime(0); // flush immediate step
      expect(gp.vibrationActuator.playEffect).toHaveBeenCalled();
    });

    it('fires multiple decreasing steps over the pulse duration', () => {
      const gp = makeHapticGamepad();
      manager = new PulseManager(scene, { getGamepads: () => [gp] });
      manager.trigger();
      vi.advanceTimersByTime(700); // cover all haptic steps
      expect(gp.vibrationActuator.playEffect.mock.calls.length).toBeGreaterThan(1);
    });

    it('each subsequent haptic step has equal or lower strongMagnitude', () => {
      const gp = makeHapticGamepad();
      manager = new PulseManager(scene, { getGamepads: () => [gp] });
      manager.trigger();
      vi.advanceTimersByTime(700);
      const strengths = gp.vibrationActuator.playEffect.mock.calls.map(
        ([, opts]) => opts.strongMagnitude,
      );
      for (let i = 1; i < strengths.length; i++) {
        expect(strengths[i]).toBeLessThanOrEqual(strengths[i - 1]);
      }
    });

    it('does nothing when no gamepad is connected', () => {
      manager = new PulseManager(scene, { getGamepads: () => [] });
      expect(() => {
        manager.trigger();
        vi.advanceTimersByTime(700);
      }).not.toThrow();
    });

    it('skips haptics when gamepad has no vibrationActuator', () => {
      manager = new PulseManager(scene, {
        getGamepads: () => [{ connected: true, vibrationActuator: null }],
      });
      expect(() => {
        manager.trigger();
        vi.advanceTimersByTime(700);
      }).not.toThrow();
    });
  });

  // ── Audio ─────────────────────────────────────────────────────────────────

  describe('audio', () => {
    it('creates an oscillator on trigger', () => {
      const ctx = makeAudioContext();
      manager = new PulseManager(scene, { audioContext: ctx });
      manager.trigger();
      expect(ctx.createOscillator).toHaveBeenCalledOnce();
    });

    it('starts the oscillator', () => {
      const ctx = makeAudioContext();
      manager = new PulseManager(scene, { audioContext: ctx });
      manager.trigger();
      expect(ctx._osc.start).toHaveBeenCalledOnce();
    });

    it('schedules the oscillator to stop', () => {
      const ctx = makeAudioContext();
      manager = new PulseManager(scene, { audioContext: ctx });
      manager.trigger();
      expect(ctx._osc.stop).toHaveBeenCalledOnce();
    });

    it('applies a downward frequency sweep', () => {
      const ctx = makeAudioContext();
      manager = new PulseManager(scene, { audioContext: ctx });
      manager.trigger();
      const rampCalls = ctx._osc.frequency.exponentialRampToValueAtTime.mock.calls;
      expect(rampCalls.length).toBeGreaterThan(0);
      // End frequency should be lower than start
      const startFreq = ctx._osc.frequency.setValueAtTime.mock.calls[0][0];
      const endFreq   = rampCalls[rampCalls.length - 1][0];
      expect(endFreq).toBeLessThan(startFreq);
    });

    it('creates a new oscillator on retrigger', () => {
      const ctx = makeAudioContext();
      manager = new PulseManager(scene, { durationMs: 800, audioContext: ctx });
      manager.trigger();
      tick(scene, 400);
      manager.trigger();
      expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    });

    it('does nothing when audioContext is null', () => {
      manager = new PulseManager(scene, { audioContext: null });
      expect(() => manager.trigger()).not.toThrow();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('removes the render observer', () => {
      manager = new PulseManager(scene);
      manager.dispose();
      expect(scene.onBeforeRenderObservable.remove).toHaveBeenCalledOnce();
    });

    it('clears all onTrigger subscribers', () => {
      manager = new PulseManager(scene);
      const cb = vi.fn();
      manager.onTrigger(cb);
      manager.dispose();
      manager.trigger();
      expect(cb).not.toHaveBeenCalled();
    });

    it('clears all onProgress subscribers', () => {
      manager = new PulseManager(scene, { durationMs: 800 });
      const cb = vi.fn();
      manager.onProgress(cb);
      manager.dispose();
      manager.trigger();
      tick(scene, 400);
      expect(cb).not.toHaveBeenCalled();
    });

    it('is safe to call twice', () => {
      manager = new PulseManager(scene);
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });

    it('trigger() after dispose does nothing', () => {
      manager = new PulseManager(scene);
      manager.dispose();
      expect(() => manager.trigger()).not.toThrow();
      expect(manager.state).toBe(PulseState.IDLE);
    });
  });
});
