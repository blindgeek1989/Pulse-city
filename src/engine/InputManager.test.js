import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputManager, GameCommand, InputMode } from './InputManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireKey(type, key) {
  window.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
}

function makeGamepad({ buttons = [], axes = [] } = {}) {
  return {
    connected: true,
    buttons: buttons.map((v) => ({ pressed: v > 0, value: v })),
    axes,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InputManager', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('defaults to KEYBOARD mode', () => {
      manager = new InputManager();
      expect(manager.mode).toBe(InputMode.KEYBOARD);
    });

    it('defaults to scanIntervalMs of 1000', () => {
      manager = new InputManager();
      expect(manager.scanIntervalMs).toBe(1000);
    });

    it('accepts a custom scanIntervalMs', () => {
      manager = new InputManager({ scanIntervalMs: 750 });
      expect(manager.scanIntervalMs).toBe(750);
    });

    it('default scan list covers every GameCommand', () => {
      manager = new InputManager();
      for (const cmd of Object.values(GameCommand)) {
        expect(manager.scanList).toContain(cmd);
      }
    });
  });

  // ── onCommand() ───────────────────────────────────────────────────────────

  describe('onCommand()', () => {
    it('returns an unsubscribe function', () => {
      manager = new InputManager();
      const unsub = manager.onCommand(() => {});
      expect(typeof unsub).toBe('function');
    });

    it('fires the callback with command and value=1 on keydown', () => {
      manager = new InputManager();
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'w');
      expect(cb).toHaveBeenCalledWith(GameCommand.MOVE_FORWARD, 1);
    });

    it('fires the callback with value=0 on keyup', () => {
      manager = new InputManager();
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keyup', 'w');
      expect(cb).toHaveBeenCalledWith(GameCommand.MOVE_FORWARD, 0);
    });

    it('notifies all registered callbacks', () => {
      manager = new InputManager();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      manager.onCommand(cb1);
      manager.onCommand(cb2);
      fireKey('keydown', 'Tab');
      expect(cb1).toHaveBeenCalledWith(GameCommand.PULSE_SCAN, 1);
      expect(cb2).toHaveBeenCalledWith(GameCommand.PULSE_SCAN, 1);
    });

    it('unsubscribed callback no longer fires', () => {
      manager = new InputManager();
      const cb = vi.fn();
      const unsub = manager.onCommand(cb);
      unsub();
      fireKey('keydown', 'w');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ── Keyboard mapping ──────────────────────────────────────────────────────

  describe('keyboard mapping', () => {
    beforeEach(() => { manager = new InputManager(); });

    const keyMap = [
      ['w',          GameCommand.MOVE_FORWARD],
      ['ArrowUp',    GameCommand.MOVE_FORWARD],
      ['s',          GameCommand.MOVE_BACK],
      ['ArrowDown',  GameCommand.MOVE_BACK],
      ['a',          GameCommand.STRAFE_LEFT],
      ['ArrowLeft',  GameCommand.STRAFE_LEFT],
      ['d',          GameCommand.STRAFE_RIGHT],
      ['ArrowRight', GameCommand.STRAFE_RIGHT],
      ['PageUp',     GameCommand.LOOK_UP],
      ['PageDown',   GameCommand.LOOK_DOWN],
      ['Tab',        GameCommand.PULSE_SCAN],
      [' ',          GameCommand.JUMP],
      ['f',          GameCommand.INTERACT],
      ['Shift',      GameCommand.SPRINT],
      ['b',          GameCommand.BRAKE],
      ['Escape',     GameCommand.PAUSE],
      ['e',          GameCommand.ENTER_VEHICLE],
      ['q',          GameCommand.EXIT_VEHICLE],
    ];

    for (const [key, command] of keyMap) {
      it(`"${key === ' ' ? 'Space' : key}" maps to ${command}`, () => {
        const cb = vi.fn();
        manager.onCommand(cb);
        fireKey('keydown', key);
        expect(cb).toHaveBeenCalledWith(command, 1);
      });
    }

    it('unmapped keys do not fire any command', () => {
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'z');
      expect(cb).not.toHaveBeenCalled();
    });
  });

  // ── remap() ───────────────────────────────────────────────────────────────

  describe('remap()', () => {
    it('maps a new key to the command', () => {
      manager = new InputManager();
      manager.remap(GameCommand.PULSE_SCAN, ['p']);
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'p');
      expect(cb).toHaveBeenCalledWith(GameCommand.PULSE_SCAN, 1);
    });

    it('removes the old key binding after remap', () => {
      manager = new InputManager();
      manager.remap(GameCommand.PULSE_SCAN, ['p']);
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'Tab'); // Tab was the old PULSE_SCAN key
      expect(cb).not.toHaveBeenCalledWith(GameCommand.PULSE_SCAN, expect.anything());
    });

    it('supports multiple keys for one command', () => {
      manager = new InputManager();
      manager.remap(GameCommand.INTERACT, ['f', 'Enter']);
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'Enter');
      expect(cb).toHaveBeenCalledWith(GameCommand.INTERACT, 1);
    });
  });

  // ── Auto-scan (SWITCH mode) ───────────────────────────────────────────────

  describe('auto-scan (SWITCH mode)', () => {
    it('setMode(SWITCH) starts the scan and exposes a current command', () => {
      manager = new InputManager();
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      expect(manager.mode).toBe(InputMode.SWITCH);
      expect(manager.currentScanCommand).not.toBeNull();
    });

    it('scan advances to the next command after one interval', () => {
      manager = new InputManager({ scanIntervalMs: 1000 });
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      const first = manager.currentScanCommand;
      vi.advanceTimersByTime(1000);
      expect(manager.currentScanCommand).not.toBe(first);
    });

    it('scan wraps back to index 0 after the last item', () => {
      manager = new InputManager({ scanIntervalMs: 1000 });
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      vi.advanceTimersByTime(2000); // two ticks → back to 0
      expect(manager.currentScanCommand).toBe(GameCommand.PULSE_SCAN);
    });

    it('any keydown in SWITCH mode fires the current scan command with value=1', () => {
      manager = new InputManager({ scanIntervalMs: 1000 });
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keydown', 'Enter');
      expect(cb).toHaveBeenCalledWith(GameCommand.PULSE_SCAN, 1);
    });

    it('does NOT fire a command on keyup in SWITCH mode', () => {
      manager = new InputManager();
      manager.setScanList([GameCommand.PULSE_SCAN]);
      manager.setMode(InputMode.SWITCH);
      const cb = vi.fn();
      manager.onCommand(cb);
      fireKey('keyup', 'Enter');
      expect(cb).not.toHaveBeenCalled();
    });

    it('setScanList() updates the cycle and resets to index 0', () => {
      manager = new InputManager();
      manager.setMode(InputMode.SWITCH);
      manager.setScanList([GameCommand.BRAKE]);
      expect(manager.scanList).toEqual([GameCommand.BRAKE]);
      expect(manager.currentScanCommand).toBe(GameCommand.BRAKE);
    });

    it('setMode away from SWITCH stops the scan timer', () => {
      manager = new InputManager({ scanIntervalMs: 1000 });
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      const frozen = manager.currentScanCommand;
      manager.setMode(InputMode.KEYBOARD);
      vi.advanceTimersByTime(2000);
      expect(manager.currentScanCommand).toBe(frozen);
    });

    it('currentScanCommand returns null when the scan list is empty', () => {
      manager = new InputManager();
      manager.setScanList([]);
      manager.setMode(InputMode.SWITCH);
      expect(manager.currentScanCommand).toBeNull();
    });
  });

  // ── Gamepad input ─────────────────────────────────────────────────────────

  describe('gamepad input', () => {
    it('poll() with button 0 pressed fires JUMP', () => {
      const getGamepads = vi.fn(() => [
        makeGamepad({ buttons: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], axes: [0, 0, 0, 0] }),
      ]);
      manager = new InputManager({ getGamepads });
      manager.setMode(InputMode.GAMEPAD);
      const cb = vi.fn();
      manager.onCommand(cb);
      manager.poll();
      expect(cb).toHaveBeenCalledWith(GameCommand.JUMP, 1);
    });

    it('poll() fires value=0 when a button is released', () => {
      const getGamepads = vi.fn();
      manager = new InputManager({ getGamepads });
      manager.setMode(InputMode.GAMEPAD);
      // First poll — button pressed
      getGamepads.mockReturnValue([
        makeGamepad({ buttons: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], axes: [0, 0, 0, 0] }),
      ]);
      manager.poll();
      // Second poll — button released
      const cb = vi.fn();
      manager.onCommand(cb);
      getGamepads.mockReturnValue([
        makeGamepad({ buttons: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], axes: [0, 0, 0, 0] }),
      ]);
      manager.poll();
      expect(cb).toHaveBeenCalledWith(GameCommand.JUMP, 0);
    });

    it('poll() with left-stick Y axis pushed forward fires MOVE_FORWARD', () => {
      const getGamepads = vi.fn(() => [
        makeGamepad({ buttons: new Array(10).fill(0), axes: [0, -0.9, 0, 0] }),
      ]);
      manager = new InputManager({ getGamepads });
      manager.setMode(InputMode.GAMEPAD);
      const cb = vi.fn();
      manager.onCommand(cb);
      manager.poll();
      expect(cb).toHaveBeenCalledWith(GameCommand.MOVE_FORWARD, expect.closeTo(0.9, 1));
    });

    it('poll() within the dead zone fires no command', () => {
      const getGamepads = vi.fn(() => [
        makeGamepad({ buttons: new Array(10).fill(0), axes: [0, 0.1, 0, 0] }),
      ]);
      manager = new InputManager({ getGamepads });
      manager.setMode(InputMode.GAMEPAD);
      const cb = vi.fn();
      manager.onCommand(cb);
      manager.poll();
      expect(cb).not.toHaveBeenCalled();
    });

    it('switches to GAMEPAD mode automatically on gamepadconnected', () => {
      manager = new InputManager();
      window.dispatchEvent(new Event('gamepadconnected'));
      expect(manager.mode).toBe(InputMode.GAMEPAD);
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('keyboard events no longer fire commands after dispose', () => {
      manager = new InputManager();
      const cb = vi.fn();
      manager.onCommand(cb);
      manager.dispose();
      fireKey('keydown', 'w');
      expect(cb).not.toHaveBeenCalled();
    });

    it('stops the scan timer on dispose', () => {
      manager = new InputManager({ scanIntervalMs: 1000 });
      manager.setScanList([GameCommand.PULSE_SCAN, GameCommand.INTERACT]);
      manager.setMode(InputMode.SWITCH);
      const frozen = manager.currentScanCommand;
      manager.dispose();
      vi.advanceTimersByTime(2000);
      expect(manager.currentScanCommand).toBe(frozen);
    });

    it('clears all command subscribers', () => {
      manager = new InputManager();
      const cb = vi.fn();
      manager.onCommand(cb);
      manager.dispose();
      fireKey('keydown', 'w');
      expect(cb).not.toHaveBeenCalled();
    });

    it('is safe to call twice', () => {
      manager = new InputManager();
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });
  });
});
