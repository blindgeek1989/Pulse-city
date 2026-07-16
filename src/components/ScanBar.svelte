<script>
  import { scanStore } from '../stores.js';
  import { InputMode } from '../engine/InputManager.js';

  const COMMAND_LABELS = {
    move_forward:  'Move Forward',
    move_back:     'Move Back',
    strafe_left:   'Strafe Left',
    strafe_right:  'Strafe Right',
    look_left:     'Look Left',
    look_right:    'Look Right',
    look_up:       'Look Up',
    look_down:     'Look Down',
    pulse_scan:    'Pulse Scan',
    interact:      'Interact',
    sprint:        'Sprint',
    brake:         'Brake',
    pause:         'Pause',
  };
</script>

<!--
  Only renders in SWITCH (single-switch auto-scan) mode.
  The active chip tracks currentScanCommand from InputManager.
  aria-live="polite" announces the active item to screen readers
  as the scan advances — a secondary cue alongside the haptic pulse.
-->
{#if $scanStore.mode === InputMode.SWITCH && $scanStore.list.length > 0}
  <nav
    class="scan-bar"
    aria-label="Switch scan — press your switch to activate the highlighted action"
    aria-live="polite"
  >
    <ul class="scan-list" role="list">
      {#each $scanStore.list as command (command)}
        {@const isActive = command === $scanStore.current}
        <li
          class="scan-chip"
          class:active={isActive}
          role="listitem"
          aria-current={isActive ? 'true' : undefined}
        >
          {COMMAND_LABELS[command] ?? command}
        </li>
      {/each}
    </ul>
  </nav>
{/if}

<style>
  .scan-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 0.5rem 1rem;
    background: rgba(0, 0, 0, 0.8);
    z-index: 20;
    pointer-events: none;
  }

  .scan-list {
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 0.5rem;
    list-style: none;
    padding: 0;
    margin: 0;
    /* hide scrollbar — sighted users see the chips, not the overflow mechanism */
    scrollbar-width: none;
  }

  .scan-list::-webkit-scrollbar {
    display: none;
  }

  .scan-chip {
    flex-shrink: 0;
    padding: 0.3rem 0.875rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.55);
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    transition:
      background 120ms ease,
      color 120ms ease,
      box-shadow 120ms ease;
  }

  /* Active chip uses the Pulse City neon cyan — 4.5:1 contrast on black */
  .scan-chip.active {
    background: #00f5ff;
    color: #000000;
    box-shadow: 0 0 14px #00f5ffaa;
  }
</style>
