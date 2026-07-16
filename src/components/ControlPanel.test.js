import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { get } from 'svelte/store';
import { panelStore } from '../stores.js';
import ControlPanel from './ControlPanel.svelte';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockCb(mode = 0) {
  return {
    mode,
    setMode: vi.fn(),
    onModeChange: vi.fn(() => () => {}),
  };
}

function makeMockSpeech(enabled = true) {
  return {
    enabled,
    toggle: vi.fn(() => !enabled),
  };
}

function makeMockInput(mode = 'keyboard') {
  return {
    mode,
    setMode: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let target;
let component;
const announce = vi.fn();

function mountPanel(overrides = {}) {
  const cbManager = overrides.cbManager ?? makeMockCb();
  const speech    = overrides.speech    ?? makeMockSpeech();
  const input     = overrides.input     ?? makeMockInput();
  component = mount(ControlPanel, {
    target,
    props: { cbManager, speech, input, announce },
  });
  flushSync();
  return { cbManager, speech, input };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ControlPanel', () => {
  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
    panelStore.set(true);
  });

  afterEach(() => {
    if (component) {
      unmount(component);
      component = null;
    }
    target.remove();
    panelStore.set(false);
    vi.clearAllMocks();
  });

  // ── Structure ─────────────────────────────────────────────────────────────

  it('mounts without throwing', () => {
    expect(() => mountPanel()).not.toThrow();
  });

  it('has role="dialog"', () => {
    mountPanel();
    expect(target.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('has aria-modal="true"', () => {
    mountPanel();
    expect(target.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
  });

  it('has the accessible title "Accessibility Settings"', () => {
    mountPanel();
    expect(target.querySelector('#panel-title').textContent.trim()).toBe('Accessibility Settings');
  });

  it('dialog is labelled by the title element', () => {
    mountPanel();
    const dialog = target.querySelector('[role="dialog"]');
    expect(dialog.getAttribute('aria-labelledby')).toBe('panel-title');
  });

  it('renders a visible backdrop', () => {
    mountPanel();
    expect(target.querySelector('.panel-backdrop')).not.toBeNull();
  });

  // ── Colorblind section ────────────────────────────────────────────────────

  it('renders four colorblind radio buttons', () => {
    mountPanel();
    expect(target.querySelectorAll('input[name="cb-mode"]').length).toBe(4);
  });

  it('first radio (Off) is checked when cbManager.mode is 0', () => {
    mountPanel({ cbManager: makeMockCb(0) });
    const radios = target.querySelectorAll('input[name="cb-mode"]');
    expect(radios[0].checked).toBe(true);
  });

  it('checks the radio matching cbManager.mode on mount', () => {
    mountPanel({ cbManager: makeMockCb(2) }); // PROTANOPIA
    const radios = target.querySelectorAll('input[name="cb-mode"]');
    expect(radios[2].checked).toBe(true);
  });

  it('other radios are unchecked when one is selected', () => {
    mountPanel({ cbManager: makeMockCb(1) }); // DEUTERANOPIA
    const radios = target.querySelectorAll('input[name="cb-mode"]');
    expect(radios[0].checked).toBe(false);
    expect(radios[1].checked).toBe(true);
    expect(radios[2].checked).toBe(false);
    expect(radios[3].checked).toBe(false);
  });

  it('calls cbManager.setMode with the chosen value on change', () => {
    const { cbManager } = mountPanel();
    const radios = target.querySelectorAll('input[name="cb-mode"]');
    radios[1].click(); // DEUTERANOPIA = 1
    flushSync();
    expect(cbManager.setMode).toHaveBeenCalledWith(1);
  });

  it('calls cbManager.setMode with TRITANOPIA (3) when last radio clicked', () => {
    const { cbManager } = mountPanel();
    const radios = target.querySelectorAll('input[name="cb-mode"]');
    radios[3].click();
    flushSync();
    expect(cbManager.setMode).toHaveBeenCalledWith(3);
  });

  it('subscribes to cbManager.onModeChange on mount', () => {
    const { cbManager } = mountPanel();
    expect(cbManager.onModeChange).toHaveBeenCalled();
  });

  // ── Self-voicing section ──────────────────────────────────────────────────

  it('renders the self-voicing checkbox', () => {
    mountPanel();
    expect(target.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('checkbox is checked when speech.enabled is true', () => {
    mountPanel({ speech: makeMockSpeech(true) });
    expect(target.querySelector('input[type="checkbox"]').checked).toBe(true);
  });

  it('checkbox is unchecked when speech.enabled is false', () => {
    mountPanel({ speech: makeMockSpeech(false) });
    expect(target.querySelector('input[type="checkbox"]').checked).toBe(false);
  });

  it('clicking the checkbox calls speech.toggle()', () => {
    const { speech } = mountPanel();
    target.querySelector('input[type="checkbox"]').click();
    flushSync();
    expect(speech.toggle).toHaveBeenCalled();
  });

  it('checkbox reflects the new state returned by speech.toggle()', () => {
    const { speech } = mountPanel({ speech: makeMockSpeech(true) });
    // toggle() returns false (turning off)
    target.querySelector('input[type="checkbox"]').click();
    flushSync();
    expect(target.querySelector('input[type="checkbox"]').checked).toBe(false);
  });

  // ── Input mode section ────────────────────────────────────────────────────

  it('renders three input mode radio buttons', () => {
    mountPanel();
    expect(target.querySelectorAll('input[name="input-mode"]').length).toBe(3);
  });

  it('checks the keyboard radio when input.mode is "keyboard"', () => {
    mountPanel({ input: makeMockInput('keyboard') });
    const radios = target.querySelectorAll('input[name="input-mode"]');
    expect(radios[0].checked).toBe(true);
  });

  it('checks the gamepad radio when input.mode is "gamepad"', () => {
    mountPanel({ input: makeMockInput('gamepad') });
    const radios = target.querySelectorAll('input[name="input-mode"]');
    expect(radios[1].checked).toBe(true);
  });

  it('checks the switch radio when input.mode is "switch"', () => {
    mountPanel({ input: makeMockInput('switch') });
    const radios = target.querySelectorAll('input[name="input-mode"]');
    expect(radios[2].checked).toBe(true);
  });

  it('calls input.setMode with the chosen mode on change', () => {
    const { input } = mountPanel();
    const radios = target.querySelectorAll('input[name="input-mode"]');
    radios[2].click(); // 'switch'
    flushSync();
    expect(input.setMode).toHaveBeenCalledWith('switch');
  });

  it('announces the new input mode via the announce bridge', () => {
    mountPanel();
    const radios = target.querySelectorAll('input[name="input-mode"]');
    radios[1].click(); // 'gamepad'
    flushSync();
    expect(announce).toHaveBeenCalledWith('Input mode: gamepad', 'polite');
  });

  // ── Close / dismiss ───────────────────────────────────────────────────────

  it('close button sets panelStore to false', () => {
    mountPanel();
    target.querySelector('.close-btn').click();
    flushSync();
    expect(get(panelStore)).toBe(false);
  });

  it('Escape key closes the panel', () => {
    mountPanel();
    const dialog = target.querySelector('[role="dialog"]');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(get(panelStore)).toBe(false);
  });

  it('backdrop click closes the panel', () => {
    mountPanel();
    target.querySelector('.panel-backdrop').click();
    flushSync();
    expect(get(panelStore)).toBe(false);
  });

  it('Escape key stops event propagation', () => {
    mountPanel();
    const dialog = target.querySelector('[role="dialog"]');
    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(spy).not.toHaveBeenCalled();
    window.removeEventListener('keydown', spy);
  });
});
