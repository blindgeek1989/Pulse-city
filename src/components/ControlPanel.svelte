<script>
  import { onMount, onDestroy, untrack } from 'svelte';
  import { panelStore } from '../stores.js';
  import { ColorblindMode } from '../engine/ColorblindManager.js';
  import { InputMode } from '../engine/InputManager.js';

  let { cbManager, speech, input, announce } = $props();

  // untrack: intentional one-time snapshot of prop values at mount; cbMode is
  // kept live via the onModeChange subscription set up inside onMount.
  let cbMode      = $state(untrack(() => cbManager.mode));
  let voicingOn   = $state(untrack(() => speech.enabled));
  let currentMode = $state(untrack(() => input.mode));

  let dialog;
  let previousFocus;
  let unsubCb;

  onMount(() => {
    previousFocus = document.activeElement;
    unsubCb = cbManager.onModeChange(m => { cbMode = m; });

    const focusable = () =>
      Array.from(dialog?.querySelectorAll(
        'button, input[type="radio"], input[type="checkbox"]'
      ) ?? []);

    focusable()[0]?.focus();

    function onKeydown(e) {
      // Block all game input while the settings panel is open.
      e.stopPropagation();

      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key === 'Tab') {
        const els = focusable();
        const first = els[0];
        const last  = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    dialog?.addEventListener('keydown', onKeydown);
    return () => dialog?.removeEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    unsubCb?.();
    previousFocus?.focus();
  });

  function close() {
    panelStore.set(false);
  }

  function selectCbMode(mode) {
    cbManager.setMode(mode);
    // announce fires via cbManager.onModeChange → main.js subscriber
  }

  function handleVoicingChange() {
    voicingOn = speech.toggle();
  }

  function selectInputMode(mode) {
    input.setMode(mode);
    currentMode = mode;
    announce?.(`Input mode: ${mode}`, 'polite');
  }
</script>

<!-- Backdrop captures outside clicks to close -->
<div class="panel-backdrop" onclick={close} aria-hidden="true"></div>

<div
  bind:this={dialog}
  role="dialog"
  aria-modal="true"
  aria-labelledby="panel-title"
  class="panel"
>
  <h2 id="panel-title" class="panel-title">Accessibility Settings</h2>

  <!-- Colorblind correction -->
  <fieldset class="panel-section">
    <legend class="section-legend">Colorblind correction</legend>
    {#each [
      { value: ColorblindMode.NONE,         label: 'Off' },
      { value: ColorblindMode.DEUTERANOPIA, label: 'Deuteranopia (red-green)' },
      { value: ColorblindMode.PROTANOPIA,   label: 'Protanopia (red-green)' },
      { value: ColorblindMode.TRITANOPIA,   label: 'Tritanopia (blue-yellow)' },
    ] as opt (opt.value)}
      <label class="radio-label">
        <input
          type="radio"
          name="cb-mode"
          value={opt.value}
          checked={cbMode === opt.value}
          onchange={() => selectCbMode(opt.value)}
        />
        {opt.label}
      </label>
    {/each}
  </fieldset>

  <!-- Self-voicing toggle -->
  <div class="panel-section">
    <label class="checkbox-label">
      <input
        type="checkbox"
        checked={voicingOn}
        onchange={handleVoicingChange}
      />
      Self-voicing (Alt+V)
    </label>
  </div>

  <!-- Input mode -->
  <fieldset class="panel-section">
    <legend class="section-legend">Input mode</legend>
    {#each [
      { value: InputMode.KEYBOARD, label: 'Keyboard' },
      { value: InputMode.GAMEPAD,  label: 'Gamepad' },
      { value: InputMode.SWITCH,   label: 'Single-switch' },
    ] as opt (opt.value)}
      <label class="radio-label">
        <input
          type="radio"
          name="input-mode"
          value={opt.value}
          checked={currentMode === opt.value}
          onchange={() => selectInputMode(opt.value)}
        />
        {opt.label}
      </label>
    {/each}
  </fieldset>

  <button class="close-btn" onclick={close}>Close</button>
</div>

<style>
  .panel-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 40;
  }

  .panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 50;
    background: #0a0010;
    border: 2px solid #00f5ff;
    box-shadow: 0 0 40px rgba(0, 245, 255, 0.25);
    border-radius: 8px;
    padding: 2rem;
    min-width: 320px;
    max-width: 480px;
    color: #e0e0f0;
    font-family: inherit;
  }

  .panel-title {
    color: #00f5ff;
    font-size: 1.25rem;
    margin-bottom: 1.5rem;
    letter-spacing: 0.05em;
  }

  .panel-section {
    margin-bottom: 1.5rem;
    border: none;
    padding: 0;
  }

  .section-legend {
    color: #aaa8c8;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.75rem;
  }

  .radio-label,
  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.25rem 0;
    cursor: pointer;
    font-size: 0.9375rem;
    color: #ccc8e8;
  }

  .radio-label:hover,
  .checkbox-label:hover {
    color: #ffffff;
  }

  input[type="radio"],
  input[type="checkbox"] {
    accent-color: #00f5ff;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
  }

  .close-btn {
    display: block;
    margin-left: auto;
    padding: 0.5rem 1.5rem;
    background: transparent;
    border: 1px solid #00f5ff;
    border-radius: 4px;
    color: #00f5ff;
    font-size: 0.9375rem;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .close-btn:hover {
    background: rgba(0, 245, 255, 0.12);
  }
</style>
