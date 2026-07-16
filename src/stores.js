import { writable } from 'svelte/store';

/**
 * captionStore — drives the visible CaptionBar for deaf/HoH players.
 * null   → bar is hidden
 * object → bar is visible with the given text and urgency
 *
 * Do NOT read this for screen-reader announcements — those go through
 * AccessibilityObserver.announce() and its aria-live regions directly.
 */
export const captionStore = writable(/** @type {{ text: string, urgency: string }|null} */ (null));

/**
 * scanStore — mirrors the current InputManager auto-scan state for the ScanBar UI.
 * Updated every 100 ms by App.svelte while in SWITCH mode.
 */
export const scanStore = writable({
  mode: /** @type {string} */ ('keyboard'),
  list: /** @type {string[]} */ ([]),
  current: /** @type {string|null} */ (null),
});

// ── Caption helpers ───────────────────────────────────────────────────────────

let captionTimer = null;

/**
 * Show a caption in the CaptionBar for `durationMs` milliseconds,
 * replacing any currently visible caption and resetting the timer.
 *
 * @param {string} text
 * @param {'polite'|'assertive'} [urgency]
 * @param {number} [durationMs]
 */
export function updateCaption(text, urgency = 'polite', durationMs = 5000) {
  clearTimeout(captionTimer);
  captionStore.set({ text, urgency });
  captionTimer = setTimeout(() => captionStore.set(null), durationMs);
}

// ── Panel helpers ─────────────────────────────────────────────────────────────

/** panelStore — true when the Accessibility Settings panel is open. */
export const panelStore = writable(false);

/** Toggle the settings panel open/closed. */
export function togglePanel() { panelStore.update(open => !open); }

// ── Scan helpers ──────────────────────────────────────────────────────────────

/**
 * Snapshot the current InputManager scan state into scanStore.
 * Called on a 100 ms interval by App.svelte.
 *
 * @param {{ mode: string, scanList: string[], currentScanCommand: string|null }} input
 */
export function syncScanStore(input) {
  scanStore.set({
    mode: input.mode,
    list: input.scanList,
    current: input.currentScanCommand,
  });
}
