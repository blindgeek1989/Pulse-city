import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpatialAudioManager } from './SpatialAudioManager.js';
import { NodeType } from './AccessibilityObserver.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeObservable() {
  const subs = [];
  return {
    add:    vi.fn((cb) => { subs.push(cb); return cb; }),
    remove: vi.fn((cb) => { const i = subs.indexOf(cb); if (i !== -1) subs.splice(i, 1); }),
    _fire:  () => subs.forEach((cb) => cb()),
  };
}

function makeScene() {
  return { onBeforeRenderObservable: makeObservable() };
}

function makeCamera({ position = { x: 0, y: 0, z: 0 }, forwardX = 0, forwardZ = 1 } = {}) {
  return {
    position,
    getForwardRay: vi.fn(() => ({ direction: { x: forwardX, y: 0, z: forwardZ } })),
  };
}

function makeAudioContext() {
  const oscs    = [];
  const panners = [];
  const gains   = [];

  return {
    currentTime: 0,
    destination: {},
    listener: {
      setPosition:    vi.fn(),
      setOrientation: vi.fn(),
    },
    createOscillator: vi.fn(() => {
      const o = {
        type:      null,
        frequency: { value: 0 },
        connect:   vi.fn(),
        start:     vi.fn(),
        stop:      vi.fn(),
      };
      oscs.push(o);
      return o;
    }),
    createGain: vi.fn(() => {
      const g = {
        gain: {
          value:                        0,
          setValueAtTime:               vi.fn(),
          linearRampToValueAtTime:      vi.fn(),
        },
        connect: vi.fn(),
      };
      gains.push(g);
      return g;
    }),
    createPanner: vi.fn(() => {
      const p = {
        panningModel:  null,
        distanceModel: null,
        refDistance:   null,
        maxDistance:   null,
        rolloffFactor: null,
        setPosition:   vi.fn(),
        connect:       vi.fn(),
      };
      panners.push(p);
      return p;
    }),
    _oscs:    oscs,
    _panners: panners,
    _gains:   gains,
  };
}

function makeMesh({
  x = 0, y = 0, z = 0,
  visible  = true,
  enabled  = true,
  uniqueId = 1,
} = {}) {
  return {
    position:         { x, y, z },
    absolutePosition: { x, y, z },
    isVisible:        visible,
    isEnabled:        vi.fn(() => enabled),
    uniqueId,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpatialAudioManager', () => {
  let scene, manager;

  beforeEach(() => {
    vi.useFakeTimers();
    scene = makeScene();
  });

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('starts with trackedCount 0', () => {
      manager = new SpatialAudioManager(scene);
      expect(manager.trackedCount).toBe(0);
    });

    it('attaches a render observer', () => {
      manager = new SpatialAudioManager(scene);
      expect(scene.onBeforeRenderObservable.add).toHaveBeenCalledOnce();
    });

    it('defaults beaconDurationMs to 400', () => {
      manager = new SpatialAudioManager(scene);
      expect(manager.beaconDurationMs).toBe(400);
    });

    it('defaults beaconGapMs to 80', () => {
      manager = new SpatialAudioManager(scene);
      expect(manager.beaconGapMs).toBe(80);
    });

    it('accepts custom beaconDurationMs and beaconGapMs', () => {
      manager = new SpatialAudioManager(scene, { beaconDurationMs: 300, beaconGapMs: 50 });
      expect(manager.beaconDurationMs).toBe(300);
      expect(manager.beaconGapMs).toBe(50);
    });
  });

  // ── register() / unregister() ─────────────────────────────────────────────

  describe('register() / unregister()', () => {
    it('register() increments trackedCount', () => {
      manager = new SpatialAudioManager(scene);
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      expect(manager.trackedCount).toBe(1);
    });

    it('registering the same mesh twice is idempotent', () => {
      manager = new SpatialAudioManager(scene);
      const mesh = makeMesh();
      manager.register(mesh, { type: NodeType.WAYPOINT });
      manager.register(mesh, { type: NodeType.WAYPOINT });
      expect(manager.trackedCount).toBe(1);
    });

    it('unregister() decrements trackedCount', () => {
      manager = new SpatialAudioManager(scene);
      const mesh = makeMesh();
      manager.register(mesh, { type: NodeType.VEHICLE });
      manager.unregister(mesh);
      expect(manager.trackedCount).toBe(0);
    });

    it('unregistering an unknown mesh does not throw', () => {
      manager = new SpatialAudioManager(scene);
      expect(() => manager.unregister(makeMesh())).not.toThrow();
    });
  });

  // ── trigger() — general ───────────────────────────────────────────────────

  describe('trigger() — general', () => {
    it('is a no-op when no meshes are registered', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.trigger();
      vi.advanceTimersByTime(500);
      expect(ctx.createOscillator).not.toHaveBeenCalled();
    });

    it('is a no-op when audioContext is null', () => {
      manager = new SpatialAudioManager(scene, { audioContext: null });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      expect(() => manager.trigger()).not.toThrow();
    });

    it('skips disabled meshes', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ enabled: false }), { type: NodeType.WAYPOINT });
      manager.trigger();
      vi.advanceTimersByTime(500);
      expect(ctx.createOscillator).not.toHaveBeenCalled();
    });

    it('skips invisible meshes', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ visible: false }), { type: NodeType.WAYPOINT });
      manager.trigger();
      vi.advanceTimersByTime(500);
      expect(ctx.createOscillator).not.toHaveBeenCalled();
    });

    it('skips PLAYER type meshes', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.PLAYER });
      manager.trigger();
      vi.advanceTimersByTime(500);
      expect(ctx.createOscillator).not.toHaveBeenCalled();
    });
  });

  // ── trigger() — sequential order ─────────────────────────────────────────

  describe('trigger() — sequential order', () => {
    it('plays nearest mesh first (before gap expires)', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera({ position: { x: 0, y: 0, z: 0 } });
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });

      const near = makeMesh({ x: 0, z: 3,  uniqueId: 1 });
      const far  = makeMesh({ x: 0, z: 10, uniqueId: 2 });
      manager.register(near, { type: NodeType.WAYPOINT });
      manager.register(far,  { type: NodeType.WAYPOINT });

      manager.trigger();
      vi.advanceTimersByTime(0); // flush first setTimeout (delay 0)
      expect(ctx.createOscillator).toHaveBeenCalledOnce();
    });

    it('plays farther mesh after beaconDurationMs + beaconGapMs', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera({ position: { x: 0, y: 0, z: 0 } });
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });

      manager.register(makeMesh({ x: 0, z: 3,  uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.register(makeMesh({ x: 0, z: 10, uniqueId: 2 }), { type: NodeType.WAYPOINT });

      manager.trigger();
      vi.advanceTimersByTime(480); // 400 + 80
      expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    });

    it('positions near beacon at the near mesh world coordinates', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera({ position: { x: 0, y: 0, z: 0 } });
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });

      const near = makeMesh({ x: 2, y: 0, z: 3, uniqueId: 1 });
      const far  = makeMesh({ x: 0, y: 0, z: 10, uniqueId: 2 });
      manager.register(near, { type: NodeType.WAYPOINT });
      manager.register(far,  { type: NodeType.WAYPOINT });

      manager.trigger();
      vi.advanceTimersByTime(0);
      expect(ctx._panners[0].setPosition).toHaveBeenCalledWith(2, 0, 3);
    });

    it('plays all three meshes in a three-mesh sequence', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
        beaconDurationMs: 200,
        beaconGapMs: 50,
      });

      manager.register(makeMesh({ z: 5,  uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.register(makeMesh({ z: 15, uniqueId: 2 }), { type: NodeType.VEHICLE });
      manager.register(makeMesh({ z: 25, uniqueId: 3 }), { type: NodeType.HAZARD });

      manager.trigger();
      vi.advanceTimersByTime(2 * (200 + 50)); // time for all three to play
      expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    });

    it('retrigger cancels the in-progress sequence and restarts', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });

      manager.register(makeMesh({ z: 5,  uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.register(makeMesh({ z: 15, uniqueId: 2 }), { type: NodeType.WAYPOINT });

      manager.trigger();
      vi.advanceTimersByTime(0);              // plays mesh 1
      manager.trigger();                       // retrigger — should restart
      vi.advanceTimersByTime(0);              // plays mesh 1 again
      vi.advanceTimersByTime(480);            // plays mesh 2 again

      // Total oscillators: 1 (first trigger) + 2 (full second sequence)
      expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    });
  });

  // ── Beacon audio ──────────────────────────────────────────────────────────

  describe('beacon audio', () => {
    it('creates an oscillator for a beacon', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.trigger();
      vi.advanceTimersByTime(0);
      expect(ctx.createOscillator).toHaveBeenCalledOnce();
    });

    it('starts and schedules stop for the oscillator', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        beaconDurationMs: 400,
      });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.trigger();
      vi.advanceTimersByTime(0);
      expect(ctx._oscs[0].start).toHaveBeenCalledOnce();
      expect(ctx._oscs[0].stop).toHaveBeenCalledOnce();
    });

    it('creates a PannerNode for spatial positioning', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.trigger();
      vi.advanceTimersByTime(0);
      expect(ctx.createPanner).toHaveBeenCalledOnce();
    });

    it('different NodeTypes use different oscillator frequencies', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });
      manager.register(makeMesh({ z: 5,  uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.register(makeMesh({ z: 10, uniqueId: 2 }), { type: NodeType.HAZARD });
      manager.trigger();
      vi.advanceTimersByTime(480); // both beacons played
      const freqs = ctx._oscs.map((o) => o.frequency.value);
      expect(freqs[0]).not.toBe(freqs[1]);
    });
  });

  // ── Listener updates ──────────────────────────────────────────────────────

  describe('listener updates', () => {
    it('updates listener position on each render tick', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera({ position: { x: 5, y: 2, z: 3 } });
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
      });
      scene.onBeforeRenderObservable._fire();
      expect(ctx.listener.setPosition).toHaveBeenCalledWith(5, 2, 3);
    });

    it('updates listener orientation from camera forward', () => {
      const ctx = makeAudioContext();
      const cam = makeCamera({ forwardX: 1, forwardZ: 0 });
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => cam,
      });
      scene.onBeforeRenderObservable._fire();
      expect(ctx.listener.setOrientation).toHaveBeenCalledWith(1, 0, 0, 0, 1, 0);
    });

    it('does nothing when audioContext is null', () => {
      manager = new SpatialAudioManager(scene, { audioContext: null });
      expect(() => scene.onBeforeRenderObservable._fire()).not.toThrow();
    });

    it('does nothing when camera is unavailable', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        getCamera: () => null,
      });
      scene.onBeforeRenderObservable._fire();
      expect(ctx.listener.setPosition).not.toHaveBeenCalled();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('removes the render observer', () => {
      manager = new SpatialAudioManager(scene);
      manager.dispose();
      expect(scene.onBeforeRenderObservable.remove).toHaveBeenCalledOnce();
    });

    it('cancels any in-progress sequence', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, {
        audioContext: ctx,
        beaconDurationMs: 400,
        beaconGapMs: 80,
      });
      manager.register(makeMesh({ z: 5,  uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.register(makeMesh({ z: 15, uniqueId: 2 }), { type: NodeType.WAYPOINT });

      manager.trigger();
      vi.advanceTimersByTime(0); // plays first
      manager.dispose();
      vi.advanceTimersByTime(480); // second should NOT play
      expect(ctx.createOscillator).toHaveBeenCalledOnce();
    });

    it('clears all tracked meshes', () => {
      manager = new SpatialAudioManager(scene);
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.dispose();
      expect(manager.trackedCount).toBe(0);
    });

    it('is safe to call twice', () => {
      manager = new SpatialAudioManager(scene);
      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });

    it('trigger() after dispose does nothing', () => {
      const ctx = makeAudioContext();
      manager = new SpatialAudioManager(scene, { audioContext: ctx });
      manager.register(makeMesh({ uniqueId: 1 }), { type: NodeType.WAYPOINT });
      manager.dispose();
      manager.trigger();
      vi.advanceTimersByTime(500);
      expect(ctx.createOscillator).not.toHaveBeenCalled();
    });
  });
});
