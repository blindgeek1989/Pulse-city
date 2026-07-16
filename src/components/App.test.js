import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { captionStore, scanStore, panelStore } from '../stores.js';
import App from './App.svelte';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockA11y = { announce: vi.fn() };

const mockCbManager = {
  mode: 0,
  setMode: vi.fn(),
  onModeChange: vi.fn(() => () => {}),
};

const mockSpeech = {
  enabled: true,
  toggle: vi.fn(() => false),
};

function makeMockInput(overrides = {}) {
  return {
    mode: 'keyboard',
    scanList: [],
    currentScanCommand: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let target;
let component;

function mountApp(inputOverrides = {}) {
  component = mount(App, {
    target,
    props: {
      a11y: mockA11y,
      input: makeMockInput(inputOverrides),
      announce: vi.fn(),
      cbManager: mockCbManager,
      speech: mockSpeech,
    },
  });
  flushSync();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement('div');
    document.body.appendChild(target);
    captionStore.set(null);
    scanStore.set({ mode: 'keyboard', list: [], current: null });
    panelStore.set(false);
  });

  afterEach(() => {
    if (component) {
      unmount(component);
      component = null;
    }
    target.remove();
    vi.useRealTimers();
  });

  // ── Mount ───────────────────────────────────────────────────────────────

  describe('mount', () => {
    it('mounts without throwing', () => {
      expect(() => mountApp()).not.toThrow();
    });

    it('renders into the target element', () => {
      mountApp();
      // Svelte uses comment anchor nodes for {#if} blocks even when empty
      expect(target.childNodes.length).toBeGreaterThan(0);
    });
  });

  // ── CaptionBar ───────────────────────────────────────────────────────────

  describe('CaptionBar', () => {
    it('is not rendered when captionStore is null', () => {
      mountApp();
      expect(target.querySelector('.caption-bar')).toBeNull();
    });

    it('appears when captionStore receives a message', () => {
      mountApp();
      captionStore.set({ text: 'Objective updated', urgency: 'polite' });
      flushSync();
      expect(target.querySelector('.caption-bar')).not.toBeNull();
    });

    it('displays the caption text', () => {
      mountApp();
      captionStore.set({ text: 'Danger ahead!', urgency: 'assertive' });
      flushSync();
      expect(target.querySelector('.caption-text').textContent.trim()).toBe('Danger ahead!');
    });

    it('has aria-hidden="true" so screen readers ignore it', () => {
      mountApp();
      captionStore.set({ text: 'Hello', urgency: 'polite' });
      flushSync();
      expect(target.querySelector('.caption-bar').getAttribute('aria-hidden')).toBe('true');
    });

    it('disappears when captionStore returns to null', () => {
      mountApp();
      captionStore.set({ text: 'Hi', urgency: 'polite' });
      flushSync();
      captionStore.set(null);
      flushSync();
      expect(target.querySelector('.caption-bar')).toBeNull();
    });
  });

  // ── ScanBar ──────────────────────────────────────────────────────────────

  describe('ScanBar', () => {
    it('is not rendered in KEYBOARD mode', () => {
      mountApp();
      expect(target.querySelector('.scan-bar')).toBeNull();
    });

    it('is not rendered in GAMEPAD mode', () => {
      mountApp();
      scanStore.set({ mode: 'gamepad', list: ['pulse_scan'], current: 'pulse_scan' });
      flushSync();
      expect(target.querySelector('.scan-bar')).toBeNull();
    });

    it('appears when scanStore mode is SWITCH', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan', 'interact'], current: 'pulse_scan' });
      flushSync();
      expect(target.querySelector('.scan-bar')).not.toBeNull();
    });

    it('renders a chip for each command in the scan list', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan', 'interact', 'pause'], current: 'pulse_scan' });
      flushSync();
      expect(target.querySelectorAll('.scan-chip').length).toBe(3);
    });

    it('marks the current command chip as active', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan', 'interact'], current: 'interact' });
      flushSync();
      const chips = target.querySelectorAll('.scan-chip');
      expect(chips[0].classList.contains('active')).toBe(false);
      expect(chips[1].classList.contains('active')).toBe(true);
    });

    it('current chip has aria-current="true"', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan', 'interact'], current: 'pulse_scan' });
      flushSync();
      const chips = target.querySelectorAll('.scan-chip');
      expect(chips[0].getAttribute('aria-current')).toBe('true');
      expect(chips[1].getAttribute('aria-current')).toBeNull();
    });

    it('renders human-readable labels for commands', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan', 'move_forward'], current: 'pulse_scan' });
      flushSync();
      const chips = target.querySelectorAll('.scan-chip');
      expect(chips[0].textContent.trim()).toBe('Pulse Scan');
      expect(chips[1].textContent.trim()).toBe('Move Forward');
    });

    it('has an accessible label on the nav element', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan'], current: 'pulse_scan' });
      flushSync();
      expect(target.querySelector('.scan-bar').getAttribute('aria-label')).toBeTruthy();
    });

    it('is hidden again when mode switches back to KEYBOARD', () => {
      mountApp();
      scanStore.set({ mode: 'switch', list: ['pulse_scan'], current: 'pulse_scan' });
      flushSync();
      scanStore.set({ mode: 'keyboard', list: [], current: null });
      flushSync();
      expect(target.querySelector('.scan-bar')).toBeNull();
    });
  });

  // ── ControlPanel ──────────────────────────────────────────────────────────

  describe('ControlPanel', () => {
    it('is not rendered when panelStore is false', () => {
      mountApp();
      expect(target.querySelector('[role="dialog"]')).toBeNull();
    });

    it('appears when panelStore is set to true', () => {
      mountApp();
      panelStore.set(true);
      flushSync();
      expect(target.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it('panel has aria-modal="true"', () => {
      mountApp();
      panelStore.set(true);
      flushSync();
      expect(target.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    });

    it('is hidden again when panelStore returns to false', () => {
      mountApp();
      panelStore.set(true);
      flushSync();
      panelStore.set(false);
      flushSync();
      expect(target.querySelector('[role="dialog"]')).toBeNull();
    });
  });
});
