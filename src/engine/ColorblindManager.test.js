import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ColorblindManager, ColorblindMode } from './ColorblindManager.js';

describe('ColorblindManager', () => {
  let cb;

  beforeEach(() => { cb = new ColorblindManager(); });
  afterEach(() => cb?.dispose());

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('defaults to NONE mode (0)', () => {
      expect(cb.mode).toBe(ColorblindMode.NONE);
    });

    it('ColorblindMode.NONE is 0', () => {
      expect(ColorblindMode.NONE).toBe(0);
    });

    it('ColorblindMode values are 0–3', () => {
      expect(ColorblindMode.NONE).toBe(0);
      expect(ColorblindMode.DEUTERANOPIA).toBe(1);
      expect(ColorblindMode.PROTANOPIA).toBe(2);
      expect(ColorblindMode.TRITANOPIA).toBe(3);
    });
  });

  // ── setMode() ─────────────────────────────────────────────────────────────

  describe('setMode()', () => {
    it('sets DEUTERANOPIA', () => {
      cb.setMode(ColorblindMode.DEUTERANOPIA);
      expect(cb.mode).toBe(1);
    });

    it('sets PROTANOPIA', () => {
      cb.setMode(ColorblindMode.PROTANOPIA);
      expect(cb.mode).toBe(2);
    });

    it('sets TRITANOPIA', () => {
      cb.setMode(ColorblindMode.TRITANOPIA);
      expect(cb.mode).toBe(3);
    });

    it('resets to NONE', () => {
      cb.setMode(ColorblindMode.DEUTERANOPIA);
      cb.setMode(ColorblindMode.NONE);
      expect(cb.mode).toBe(0);
    });

    it('throws RangeError for unknown mode value', () => {
      expect(() => cb.setMode(99)).toThrow(RangeError);
    });

    it('throws RangeError for non-integer input', () => {
      expect(() => cb.setMode('deuteranopia')).toThrow(RangeError);
    });
  });

  // ── onModeChange() ────────────────────────────────────────────────────────

  describe('onModeChange()', () => {
    it('fires callback on mode change', () => {
      const spy = vi.fn();
      cb.onModeChange(spy);
      cb.setMode(ColorblindMode.DEUTERANOPIA);
      expect(spy).toHaveBeenCalledWith(ColorblindMode.DEUTERANOPIA);
    });

    it('fires on every subsequent change', () => {
      const spy = vi.fn();
      cb.onModeChange(spy);
      cb.setMode(ColorblindMode.PROTANOPIA);
      cb.setMode(ColorblindMode.TRITANOPIA);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('notifies multiple subscribers', () => {
      const a = vi.fn();
      const b = vi.fn();
      cb.onModeChange(a);
      cb.onModeChange(b);
      cb.setMode(ColorblindMode.TRITANOPIA);
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it('returns an unsubscribe function', () => {
      const spy = vi.fn();
      const unsub = cb.onModeChange(spy);
      unsub();
      cb.setMode(ColorblindMode.DEUTERANOPIA);
      expect(spy).not.toHaveBeenCalled();
    });

    it('only removes the specific subscriber on unsub', () => {
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = cb.onModeChange(a);
      cb.onModeChange(b);
      unsubA();
      cb.setMode(ColorblindMode.PROTANOPIA);
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
    });

    it('does not fire for invalid setMode (throws instead)', () => {
      const spy = vi.fn();
      cb.onModeChange(spy);
      expect(() => cb.setMode(42)).toThrow();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('is safe to call twice', () => {
      expect(() => { cb.dispose(); cb.dispose(); }).not.toThrow();
    });

    it('clears subscribers — mode changes are no-ops', () => {
      const spy = vi.fn();
      cb.onModeChange(spy);
      cb.dispose();
      cb.setMode(ColorblindMode.DEUTERANOPIA);  // should not throw or call spy
      expect(spy).not.toHaveBeenCalled();
    });

    it('mode getter still returns last set value after dispose', () => {
      cb.setMode(ColorblindMode.TRITANOPIA);
      cb.dispose();
      expect(cb.mode).toBe(3);
    });

    it('setMode() after dispose is a no-op and does not change mode', () => {
      cb.dispose();
      cb.setMode(ColorblindMode.PROTANOPIA);
      expect(cb.mode).toBe(ColorblindMode.NONE);
    });
  });
});
