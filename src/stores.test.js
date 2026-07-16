import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';

// Re-import fresh each time to reset module-level captionTimer
import { captionStore, scanStore, panelStore, updateCaption, syncScanStore, togglePanel } from './stores.js';

// ---------------------------------------------------------------------------
// captionStore + updateCaption()
// ---------------------------------------------------------------------------

describe('captionStore', () => {
  beforeEach(() => {
    captionStore.set(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts as null', () => {
    expect(get(captionStore)).toBeNull();
  });

  it('updateCaption() sets text and urgency', () => {
    updateCaption('Mission updated', 'polite');
    expect(get(captionStore)).toEqual({ text: 'Mission updated', urgency: 'polite' });
  });

  it('defaults urgency to polite', () => {
    updateCaption('Hello');
    expect(get(captionStore).urgency).toBe('polite');
  });

  it('auto-clears to null after the duration elapses', () => {
    updateCaption('Flash', 'polite', 3000);
    vi.advanceTimersByTime(3000);
    expect(get(captionStore)).toBeNull();
  });

  it('does not clear before the duration elapses', () => {
    updateCaption('Sticky', 'polite', 3000);
    vi.advanceTimersByTime(2999);
    expect(get(captionStore)).not.toBeNull();
  });

  it('a second call replaces the message and resets the timer', () => {
    updateCaption('First', 'polite', 3000);
    vi.advanceTimersByTime(2000);
    updateCaption('Second', 'polite', 3000);
    // 2000ms after Second was set — still within its own 3000ms window
    vi.advanceTimersByTime(2000);
    expect(get(captionStore)?.text).toBe('Second');
    // Now expire Second's window
    vi.advanceTimersByTime(1000);
    expect(get(captionStore)).toBeNull();
  });

  it('assertive urgency is stored correctly', () => {
    updateCaption('Danger!', 'assertive');
    expect(get(captionStore).urgency).toBe('assertive');
  });
});

// ---------------------------------------------------------------------------
// scanStore + syncScanStore()
// ---------------------------------------------------------------------------

describe('scanStore', () => {
  beforeEach(() => {
    scanStore.set({ mode: 'keyboard', list: [], current: null });
  });

  it('starts with keyboard mode and empty list', () => {
    const state = get(scanStore);
    expect(state.mode).toBe('keyboard');
    expect(state.list).toEqual([]);
    expect(state.current).toBeNull();
  });

  it('syncScanStore() copies mode from InputManager', () => {
    syncScanStore({ mode: 'switch', scanList: [], currentScanCommand: null });
    expect(get(scanStore).mode).toBe('switch');
  });

  it('syncScanStore() copies scanList as a snapshot', () => {
    const input = { mode: 'switch', scanList: ['pulse_scan', 'interact'], currentScanCommand: 'pulse_scan' };
    syncScanStore(input);
    expect(get(scanStore).list).toEqual(['pulse_scan', 'interact']);
  });

  it('syncScanStore() copies currentScanCommand', () => {
    syncScanStore({ mode: 'switch', scanList: ['pulse_scan'], currentScanCommand: 'pulse_scan' });
    expect(get(scanStore).current).toBe('pulse_scan');
  });

  it('syncScanStore() reflects null currentScanCommand', () => {
    syncScanStore({ mode: 'switch', scanList: [], currentScanCommand: null });
    expect(get(scanStore).current).toBeNull();
  });

  it('syncScanStore() overwrites previous state entirely', () => {
    syncScanStore({ mode: 'switch', scanList: ['pulse_scan'], currentScanCommand: 'pulse_scan' });
    syncScanStore({ mode: 'keyboard', scanList: [], currentScanCommand: null });
    const state = get(scanStore);
    expect(state.mode).toBe('keyboard');
    expect(state.list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// panelStore + togglePanel()
// ---------------------------------------------------------------------------

describe('panelStore', () => {
  beforeEach(() => {
    panelStore.set(false);
  });

  it('starts as false', () => {
    expect(get(panelStore)).toBe(false);
  });

  it('togglePanel() opens the panel', () => {
    togglePanel();
    expect(get(panelStore)).toBe(true);
  });

  it('togglePanel() closes the panel when already open', () => {
    panelStore.set(true);
    togglePanel();
    expect(get(panelStore)).toBe(false);
  });

  it('togglePanel() called twice returns to original state', () => {
    togglePanel();
    togglePanel();
    expect(get(panelStore)).toBe(false);
  });

  it('panelStore.set(true) opens the panel', () => {
    panelStore.set(true);
    expect(get(panelStore)).toBe(true);
  });
});
