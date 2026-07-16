import { describe, it, expect, vi } from 'vitest';
import { PerformanceMonitor, FrameBudget } from './PerformanceMonitor.js';

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — initial state', () => {
  it('frameMs is 0 before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.frameMs).toBe(0);
  });

  it('fps is 0 before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.fps).toBe(0);
  });

  it('budget is GOOD before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.budget).toBe(FrameBudget.GOOD);
  });

  it('min is 0 before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.min).toBe(0);
  });

  it('max is 0 before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.max).toBe(0);
  });

  it('sampleCount is 0 before any samples', () => {
    const pm = new PerformanceMonitor();
    expect(pm.sampleCount).toBe(0);
  });

  it('throws RangeError for windowSize < 1', () => {
    expect(() => new PerformanceMonitor({ windowSize: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Single sample
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — single sample', () => {
  it('frameMs equals the recorded delta', () => {
    const pm = new PerformanceMonitor();
    pm.record(20);
    expect(pm.frameMs).toBeCloseTo(20);
  });

  it('fps is 1000 / frameMs', () => {
    const pm = new PerformanceMonitor();
    pm.record(20);
    expect(pm.fps).toBeCloseTo(50);
  });

  it('sampleCount becomes 1', () => {
    const pm = new PerformanceMonitor();
    pm.record(16);
    expect(pm.sampleCount).toBe(1);
  });

  it('min and max both equal the single sample', () => {
    const pm = new PerformanceMonitor();
    pm.record(25);
    expect(pm.min).toBeCloseTo(25);
    expect(pm.max).toBeCloseTo(25);
  });
});

// ---------------------------------------------------------------------------
// Rolling average
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — rolling average', () => {
  it('averages multiple samples', () => {
    const pm = new PerformanceMonitor({ windowSize: 4 });
    pm.record(10); // sum=10
    pm.record(20); // sum=30
    pm.record(30); // sum=60
    pm.record(40); // sum=100
    expect(pm.frameMs).toBeCloseTo(25); // 100/4
  });

  it('evicts the oldest sample when the window is full', () => {
    const pm = new PerformanceMonitor({ windowSize: 3 });
    pm.record(10);
    pm.record(20);
    pm.record(30); // window = [10, 20, 30], avg = 20
    pm.record(40); // window = [20, 30, 40], avg = 30 (10 evicted)
    expect(pm.frameMs).toBeCloseTo(30);
  });

  it('sampleCount caps at windowSize', () => {
    const pm = new PerformanceMonitor({ windowSize: 3 });
    pm.record(10);
    pm.record(10);
    pm.record(10);
    pm.record(10); // 4th record — window still 3
    expect(pm.sampleCount).toBe(3);
  });

  it('tracks min correctly across all samples in window', () => {
    const pm = new PerformanceMonitor({ windowSize: 4 });
    pm.record(30);
    pm.record(10);
    pm.record(20);
    expect(pm.min).toBeCloseTo(10);
  });

  it('tracks max correctly across all samples in window', () => {
    const pm = new PerformanceMonitor({ windowSize: 4 });
    pm.record(10);
    pm.record(50);
    pm.record(20);
    expect(pm.max).toBeCloseTo(50);
  });

  it('min updates when the minimum sample is evicted', () => {
    const pm = new PerformanceMonitor({ windowSize: 3 });
    pm.record(5);  // min candidate
    pm.record(20);
    pm.record(20);
    pm.record(20); // evicts the 5; new window = [20, 20, 20]
    expect(pm.min).toBeCloseTo(20);
  });

  it('max updates when the maximum sample is evicted', () => {
    const pm = new PerformanceMonitor({ windowSize: 3 });
    pm.record(100); // max candidate
    pm.record(20);
    pm.record(20);
    pm.record(20); // evicts 100; new window = [20, 20, 20]
    expect(pm.max).toBeCloseTo(20);
  });
});

// ---------------------------------------------------------------------------
// Budget thresholds
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — budget', () => {
  it('GOOD for frame time ≤ 16.7ms (60 fps target)', () => {
    const pm = new PerformanceMonitor();
    pm.record(16);
    expect(pm.budget).toBe(FrameBudget.GOOD);
  });

  it('GOOD for exactly 16.667ms', () => {
    const pm = new PerformanceMonitor();
    pm.record(1000 / 60);
    expect(pm.budget).toBe(FrameBudget.GOOD);
  });

  it('WARNING for frame time just above 60fps threshold', () => {
    const pm = new PerformanceMonitor();
    pm.record(20);
    expect(pm.budget).toBe(FrameBudget.WARNING);
  });

  it('WARNING for exactly 33.3ms (30 fps threshold)', () => {
    const pm = new PerformanceMonitor();
    pm.record(1000 / 30);
    expect(pm.budget).toBe(FrameBudget.WARNING);
  });

  it('CRITICAL for frame time above 33.3ms', () => {
    const pm = new PerformanceMonitor();
    pm.record(40);
    expect(pm.budget).toBe(FrameBudget.CRITICAL);
  });

  it('budget reflects the rolling average not just the latest sample', () => {
    const pm = new PerformanceMonitor({ windowSize: 4 });
    // Three fast frames, one slow
    pm.record(10); pm.record(10); pm.record(10); pm.record(40);
    // avg = (10+10+10+40)/4 = 17.5ms → WARNING
    expect(pm.budget).toBe(FrameBudget.WARNING);
  });
});

// ---------------------------------------------------------------------------
// Guard conditions
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — guards', () => {
  it('ignores deltaMs = 0', () => {
    const pm = new PerformanceMonitor();
    pm.record(0);
    expect(pm.sampleCount).toBe(0);
    expect(pm.frameMs).toBe(0);
  });

  it('ignores negative deltaMs', () => {
    const pm = new PerformanceMonitor();
    pm.record(-5);
    expect(pm.sampleCount).toBe(0);
  });

  it('record() does nothing after dispose()', () => {
    const pm = new PerformanceMonitor();
    pm.record(16);
    pm.dispose();
    pm.record(100); // should be ignored
    expect(pm.sampleCount).toBe(1);
    expect(pm.frameMs).toBeCloseTo(16);
  });
});

// ---------------------------------------------------------------------------
// Subscriber / onUpdate
// ---------------------------------------------------------------------------

describe('PerformanceMonitor — onUpdate', () => {
  it('fires the callback after each record()', () => {
    const pm = new PerformanceMonitor();
    const cb = vi.fn();
    pm.onUpdate(cb);
    pm.record(16);
    pm.record(16);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe function', () => {
    const pm = new PerformanceMonitor();
    const cb = vi.fn();
    const unsub = pm.onUpdate(cb);
    pm.record(16);
    unsub();
    pm.record(16);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers each fire after record()', () => {
    const pm = new PerformanceMonitor();
    const a = vi.fn();
    const b = vi.fn();
    pm.onUpdate(a);
    pm.onUpdate(b);
    pm.record(16);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('dispose() prevents callbacks from firing', () => {
    const pm = new PerformanceMonitor();
    const cb = vi.fn();
    pm.onUpdate(cb);
    pm.dispose();
    pm.record(16);
    expect(cb).not.toHaveBeenCalled();
  });

  it('callback not called for ignored (≤ 0) samples', () => {
    const pm = new PerformanceMonitor();
    const cb = vi.fn();
    pm.onUpdate(cb);
    pm.record(0);
    pm.record(-1);
    expect(cb).not.toHaveBeenCalled();
  });
});
