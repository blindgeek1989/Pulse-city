/**
 * InputManager — Adaptive Input Layer
 *
 * Translates raw keyboard, gamepad, and single-switch (auto-scan) events
 * into a unified stream of GameCommand + value pairs. Consumers subscribe
 * via onCommand() and never touch raw input events directly.
 *
 * Usage:
 *   const input = new InputManager();
 *   input.onCommand((cmd, value) => { ... });
 *   // call input.poll() each frame for gamepad support
 *   input.dispose();
 *
 * Single-switch / auto-scan:
 *   input.setMode(InputMode.SWITCH);
 *   // The manager cycles through scanList every scanIntervalMs.
 *   // Any key press fires the currently highlighted command.
 *   // Read input.currentScanCommand to drive the UI highlight.
 */

export const GameCommand = Object.freeze({
  MOVE_FORWARD:   'move_forward',
  MOVE_BACK:      'move_back',
  STRAFE_LEFT:    'strafe_left',
  STRAFE_RIGHT:   'strafe_right',
  LOOK_LEFT:      'look_left',
  LOOK_RIGHT:     'look_right',
  LOOK_UP:        'look_up',
  LOOK_DOWN:      'look_down',
  PULSE_SCAN:     'pulse_scan',
  INTERACT:       'interact',
  SPRINT:         'sprint',
  BRAKE:          'brake',
  PAUSE:          'pause',
  JUMP:           'jump',
  ENTER_VEHICLE:  'enter_vehicle',
  EXIT_VEHICLE:   'exit_vehicle',
});

export const InputMode = Object.freeze({
  KEYBOARD: 'keyboard',
  GAMEPAD:  'gamepad',
  SWITCH:   'switch',
});

// Axis values below this magnitude are ignored (gamepad stick drift).
const DEADZONE = 0.15;

// Default keyboard → command map.
// LOOK_LEFT / LOOK_RIGHT are gamepad right-stick only — Q and E are vehicle entry/exit.
const DEFAULT_KEY_MAP = {
  'w':          GameCommand.MOVE_FORWARD,
  'ArrowUp':    GameCommand.MOVE_FORWARD,
  's':          GameCommand.MOVE_BACK,
  'ArrowDown':  GameCommand.MOVE_BACK,
  'a':          GameCommand.STRAFE_LEFT,
  'ArrowLeft':  GameCommand.STRAFE_LEFT,
  'd':          GameCommand.STRAFE_RIGHT,
  'ArrowRight': GameCommand.STRAFE_RIGHT,
  'PageUp':     GameCommand.LOOK_UP,
  'PageDown':   GameCommand.LOOK_DOWN,
  'Tab':        GameCommand.PULSE_SCAN,    // Space is now Jump
  ' ':          GameCommand.JUMP,
  'f':          GameCommand.INTERACT,
  'Shift':      GameCommand.SPRINT,
  'b':          GameCommand.BRAKE,
  'Escape':     GameCommand.PAUSE,
  'e':          GameCommand.ENTER_VEHICLE,
  'q':          GameCommand.EXIT_VEHICLE,
};

// Standard gamepad button index → command (null = unmapped).
const DEFAULT_BUTTON_MAP = [
  GameCommand.JUMP,           // 0  A / Cross
  GameCommand.BRAKE,          // 1  B / Circle
  GameCommand.PULSE_SCAN,     // 2  X / Square
  GameCommand.ENTER_VEHICLE,  // 3  Y / Triangle
  GameCommand.EXIT_VEHICLE,   // 4  LB
  GameCommand.SPRINT,         // 5  RB
  null,                       // 6  LT
  null,                       // 7  RT
  null,                       // 8  Select / Share
  GameCommand.PAUSE,          // 9  Start / Options
];

// Standard gamepad axis index → [positiveCommand, negativeCommand].
// Left stick Y: negative = forward (push up = negative Y in browser Gamepad API).
const DEFAULT_AXIS_MAP = [
  [GameCommand.STRAFE_RIGHT, GameCommand.STRAFE_LEFT],  // axis 0 — left stick X
  [GameCommand.MOVE_BACK,    GameCommand.MOVE_FORWARD], // axis 1 — left stick Y
  [GameCommand.LOOK_RIGHT,   GameCommand.LOOK_LEFT],    // axis 2 — right stick X
  [GameCommand.LOOK_DOWN,    GameCommand.LOOK_UP],      // axis 3 — right stick Y
];

export class InputManager {
  #mode;
  #keyMap;          // Map<key string, GameCommand>
  #subscribers;     // Set<(command, value) => void>
  #scanList;        // GameCommand[]
  #scanIndex;
  #scanIntervalMs;
  #scanTimer;
  #prevButtonState; // Map<string, number> — tracks last-seen gamepad state
  #getGamepads;     // () => Gamepad[] — injected for testability
  #disposed;
  #onKeyDown;
  #onKeyUp;
  #onGamepadConnected;

  /**
   * @param {{
   *   scanIntervalMs?: number,
   *   getGamepads?: () => (Gamepad|null)[]
   * }} [options]
   */
  constructor({
    scanIntervalMs = 1000,
    getGamepads = () => navigator.getGamepads?.() ?? [],
  } = {}) {
    this.#mode = InputMode.KEYBOARD;
    this.#keyMap = new Map(Object.entries(DEFAULT_KEY_MAP));
    this.#subscribers = new Set();
    this.#scanList = Object.values(GameCommand);
    this.#scanIndex = 0;
    this.#scanIntervalMs = scanIntervalMs;
    this.#scanTimer = null;
    this.#prevButtonState = new Map();
    this.#getGamepads = getGamepads;
    this.#disposed = false;

    this.#onKeyDown = (e) => this.#handleKey(e, 1);
    this.#onKeyUp = (e) => this.#handleKey(e, 0);
    this.#onGamepadConnected = () => this.setMode(InputMode.GAMEPAD);

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('gamepadconnected', this.#onGamepadConnected);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get mode() { return this.#mode; }
  get scanIntervalMs() { return this.#scanIntervalMs; }

  /** Ordered copy of the current auto-scan command list. */
  get scanList() { return [...this.#scanList]; }

  /** The command currently highlighted by the auto-scan cursor, or null. */
  get currentScanCommand() {
    return this.#scanList[this.#scanIndex] ?? null;
  }

  /**
   * Subscribe to command events.
   * @param {(command: string, value: number) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onCommand(callback) {
    this.#subscribers.add(callback);
    return () => this.#subscribers.delete(callback);
  }

  /**
   * Switch input mode.
   * Switching to SWITCH starts the auto-scan timer; leaving it stops the timer.
   * @param {'keyboard'|'gamepad'|'switch'} mode
   */
  setMode(mode) {
    this.#stopScan();
    this.#mode = mode;
    if (mode === InputMode.SWITCH) this.#startScan();
  }

  /**
   * Replace the auto-scan command list. Resets the cursor to index 0.
   * @param {string[]} commands
   */
  setScanList(commands) {
    this.#scanList = [...commands];
    this.#scanIndex = 0;
  }

  /**
   * Remap a command to a new set of keyboard keys, replacing any existing binding.
   * @param {string} command  — a GameCommand value
   * @param {string[]} keys   — e.g. ['p', 'Enter']
   */
  remap(command, keys) {
    for (const [k, cmd] of this.#keyMap) {
      if (cmd === command) this.#keyMap.delete(k);
    }
    for (const key of keys) {
      this.#keyMap.set(key, command);
    }
  }

  /**
   * Poll the Gamepad API for state changes. Call once per render frame.
   * No-op unless mode is GAMEPAD.
   */
  poll() {
    if (this.#disposed || this.#mode !== InputMode.GAMEPAD) return;

    const gamepads = this.#getGamepads();
    const gp = gamepads?.[0];
    if (!gp) return;

    this.#pollButtons(gp.buttons);
    this.#pollAxes(gp.axes);
  }

  /** Detach all listeners, stop the scan timer, and clear subscribers. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('gamepadconnected', this.#onGamepadConnected);

    this.#stopScan();
    this.#subscribers.clear();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  #handleKey(e, value) {
    if (this.#disposed) return;

    if (this.#mode === InputMode.SWITCH) {
      if (value === 1) {
        const cmd = this.currentScanCommand;
        if (cmd) this.#emit(cmd, 1);
      }
      return;
    }

    const command = this.#keyMap.get(e.key);
    if (command) {
      e.preventDefault();
      this.#emit(command, value);
    }
  }

  #pollButtons(buttons) {
    buttons.forEach((btn, i) => {
      const command = DEFAULT_BUTTON_MAP[i];
      if (!command) return;
      const key = `b${i}`;
      const prev = this.#prevButtonState.get(key) ?? 0;
      const curr = btn.value;
      if (curr !== prev) {
        this.#emit(command, curr);
        this.#prevButtonState.set(key, curr);
      }
    });
  }

  #pollAxes(axes) {
    axes.forEach((raw, i) => {
      const mapping = DEFAULT_AXIS_MAP[i];
      if (!mapping) return;
      const [posCmd, negCmd] = mapping;
      const abs = Math.abs(raw);

      if (abs < DEADZONE) {
        this.#clearAxis(i, posCmd, negCmd);
        return;
      }

      if (raw > 0) {
        this.#emitAxisChange(`a${i}p`, posCmd, abs);
        this.#clearAxis(i, null, negCmd); // release opposite
      } else {
        this.#emitAxisChange(`a${i}n`, negCmd, abs);
        this.#clearAxis(i, posCmd, null); // release opposite
      }
    });
  }

  #emitAxisChange(key, command, value) {
    const prev = this.#prevButtonState.get(key) ?? 0;
    if (value !== prev) {
      this.#emit(command, value);
      this.#prevButtonState.set(key, value);
    }
  }

  #clearAxis(i, posCmd, negCmd) {
    if (posCmd !== null) {
      const k = `a${i}p`;
      if ((this.#prevButtonState.get(k) ?? 0) > 0) {
        this.#emit(posCmd, 0);
        this.#prevButtonState.set(k, 0);
      }
    }
    if (negCmd !== null) {
      const k = `a${i}n`;
      if ((this.#prevButtonState.get(k) ?? 0) > 0) {
        this.#emit(negCmd, 0);
        this.#prevButtonState.set(k, 0);
      }
    }
  }

  #emit(command, value) {
    for (const cb of this.#subscribers) cb(command, value);
  }

  #startScan() {
    if (this.#scanList.length === 0) return;
    this.#scanTimer = setInterval(() => {
      this.#scanIndex = (this.#scanIndex + 1) % this.#scanList.length;
    }, this.#scanIntervalMs);
  }

  #stopScan() {
    if (this.#scanTimer !== null) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
    }
  }
}
