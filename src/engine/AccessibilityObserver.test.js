import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AccessibilityObserver, NodeType, Urgency } from './AccessibilityObserver.js';

// ---------------------------------------------------------------------------
// Babylon.js mock factories
// ---------------------------------------------------------------------------

function vec3(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function makeObservable() {
  const subs = [];
  return {
    add: vi.fn((cb) => { subs.push(cb); return cb; }),
    remove: vi.fn((cb) => {
      const i = subs.indexOf(cb);
      if (i !== -1) subs.splice(i, 1);
    }),
    _fire: () => subs.forEach((cb) => cb()),
  };
}

function makeCamera({ position = vec3(), forwardX = 0, forwardZ = 1 } = {}) {
  return {
    position,
    getForwardRay: vi.fn(() => ({ direction: vec3(forwardX, 0, forwardZ) })),
  };
}

function makeScene(opts = {}) {
  const scene = {
    onBeforeRenderObservable: makeObservable(),
    activeCamera: makeCamera(opts.camera),
  };
  return scene;
}

function makeMesh({
  x = 0, y = 0, z = 0,
  visible = true,
  enabled = true,
  name = 'mesh',
  uniqueId = 1,
} = {}) {
  return {
    position: vec3(x, y, z),
    absolutePosition: vec3(x, y, z),
    isVisible: visible,
    isEnabled: vi.fn(() => enabled),
    name,
    uniqueId,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fireAfterThrottle(scene) {
  // advance past the 500ms update throttle window, then fire a render tick
  vi.advanceTimersByTime(600);
  scene.onBeforeRenderObservable._fire();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AccessibilityObserver', () => {
  let scene, observer;

  beforeEach(() => {
    vi.useFakeTimers();
    scene = makeScene();
  });

  afterEach(() => {
    observer?.dispose();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  // ── DOM construction ──────────────────────────────────────────────────────

  describe('DOM construction', () => {
    it('appends a visually-hidden container to document.body', () => {
      observer = new AccessibilityObserver(scene);
      const el = document.getElementById('pulse-city-a11y');
      expect(el).not.toBeNull();
      expect(el.classList.contains('sr-only')).toBe(true);
    });

    it('uses a custom containerId when provided', () => {
      observer = new AccessibilityObserver(scene, { containerId: 'custom-layer' });
      expect(document.getElementById('custom-layer')).not.toBeNull();
    });

    it('creates a polite aria-live region', () => {
      observer = new AccessibilityObserver(scene);
      const el = document.getElementById('pulse-announcer-polite');
      expect(el?.getAttribute('aria-live')).toBe('polite');
      expect(el?.getAttribute('aria-atomic')).toBe('true');
    });

    it('creates an assertive aria-live region', () => {
      observer = new AccessibilityObserver(scene);
      const el = document.getElementById('pulse-announcer-assertive');
      expect(el?.getAttribute('aria-live')).toBe('assertive');
      expect(el?.getAttribute('aria-atomic')).toBe('true');
    });

    it('creates a labelled <ul> for nearby objects', () => {
      observer = new AccessibilityObserver(scene);
      const list = document.querySelector('ul[aria-label="Nearby objects"]');
      expect(list).not.toBeNull();
    });

    it('attaches a scene observer on construction', () => {
      observer = new AccessibilityObserver(scene);
      expect(scene.onBeforeRenderObservable.add).toHaveBeenCalledOnce();
    });
  });

  // ── register() ───────────────────────────────────────────────────────────

  describe('register()', () => {
    it('adds a <li> to the node list', () => {
      observer = new AccessibilityObserver(scene);
      observer.register(makeMesh(), { type: NodeType.VEHICLE, label: 'Taxi' });
      expect(document.querySelectorAll('[role="listitem"]').length).toBe(1);
    });

    it('increments trackedCount', () => {
      observer = new AccessibilityObserver(scene);
      observer.register(makeMesh({ uniqueId: 1 }), { type: NodeType.NPC });
      observer.register(makeMesh({ uniqueId: 2 }), { type: NodeType.WAYPOINT });
      expect(observer.trackedCount).toBe(2);
    });

    it('is idempotent — registering the same mesh twice does not duplicate', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh();
      observer.register(mesh, { type: NodeType.OBSTACLE });
      observer.register(mesh, { type: NodeType.OBSTACLE });
      expect(observer.trackedCount).toBe(1);
    });

    it('stores type on the <li> dataset', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh({ uniqueId: 42 });
      observer.register(mesh, { type: NodeType.HAZARD });
      const el = observer.getDOMElement(mesh);
      expect(el.dataset.type).toBe(NodeType.HAZARD);
    });
  });

  // ── getDOMElement() ───────────────────────────────────────────────────────

  describe('getDOMElement()', () => {
    it('returns the <li> for a registered mesh', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh();
      observer.register(mesh, { type: NodeType.WAYPOINT });
      expect(observer.getDOMElement(mesh)?.tagName).toBe('LI');
    });

    it('returns null for an unregistered mesh', () => {
      observer = new AccessibilityObserver(scene);
      expect(observer.getDOMElement(makeMesh())).toBeNull();
    });
  });

  // ── unregister() ─────────────────────────────────────────────────────────

  describe('unregister()', () => {
    it('removes the <li> from the DOM', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh();
      observer.register(mesh, { type: NodeType.VEHICLE });
      observer.unregister(mesh);
      expect(document.querySelectorAll('[role="listitem"]').length).toBe(0);
    });

    it('decrements trackedCount', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh();
      observer.register(mesh, { type: NodeType.NPC });
      observer.unregister(mesh);
      expect(observer.trackedCount).toBe(0);
    });

    it('does not throw when called on an unknown mesh', () => {
      observer = new AccessibilityObserver(scene);
      expect(() => observer.unregister(makeMesh())).not.toThrow();
    });

    it('makes getDOMElement() return null after unregistration', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh();
      observer.register(mesh, { type: NodeType.OBSTACLE });
      observer.unregister(mesh);
      expect(observer.getDOMElement(mesh)).toBeNull();
    });
  });

  // ── spatial description updates ───────────────────────────────────────────

  describe('spatial description updates', () => {
    it('updates the aria-label on a render tick after the throttle window', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh({ x: 0, z: 10 });
      observer.register(mesh, { type: NodeType.VEHICLE, label: 'Taxi' });
      fireAfterThrottle(scene);
      const label = observer.getDOMElement(mesh).getAttribute('aria-label');
      expect(label).toContain('Taxi');
    });

    it('does not update again within the throttle window after the first update', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh({ x: 0, z: 10 });
      observer.register(mesh, { label: 'Target' });

      // First fire — always produces an initial description
      fireAfterThrottle(scene);
      const firstLabel = observer.getDOMElement(mesh).getAttribute('aria-label');
      expect(firstLabel).not.toBeNull();

      // Move the mesh so a new description would differ
      mesh.absolutePosition.z = 3;
      mesh.position.z = 3;

      // Fire again before the throttle window expires
      vi.advanceTimersByTime(100);
      scene.onBeforeRenderObservable._fire();
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toBe(firstLabel);

      // Now advance past the throttle and fire — should update
      vi.advanceTimersByTime(600);
      scene.onBeforeRenderObservable._fire();
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).not.toBe(firstLabel);
    });

    it('skips disabled meshes', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh({ enabled: false });
      observer.register(mesh, { label: 'Disabled' });
      fireAfterThrottle(scene);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toBeNull();
    });

    it('skips invisible meshes', () => {
      observer = new AccessibilityObserver(scene);
      const mesh = makeMesh({ visible: false });
      observer.register(mesh, { label: 'Invisible' });
      fireAfterThrottle(scene);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toBeNull();
    });
  });

  // ── spatial direction descriptions ───────────────────────────────────────

  describe('spatial direction descriptions', () => {
    function createSceneWithCamera(forwardX, forwardZ) {
      const s = makeScene({ camera: { forwardX, forwardZ } });
      s.activeCamera = makeCamera({ position: vec3(0, 0, 0), forwardX, forwardZ });
      return s;
    }

    it('describes a mesh directly ahead as "ahead"', () => {
      const s = createSceneWithCamera(0, 1);
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: 0, z: 3 });
      observer.register(mesh, { label: 'Target' });
      fireAfterThrottle(s);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toContain('ahead');
    });

    it('describes a mesh directly behind as "behind you"', () => {
      const s = createSceneWithCamera(0, 1);
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: 0, z: -10 });
      observer.register(mesh, { label: 'Target' });
      fireAfterThrottle(s);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toContain('behind you');
    });

    it('describes a mesh to the right as "to your right"', () => {
      const s = createSceneWithCamera(0, 1);
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: 10, z: 0 });
      observer.register(mesh, { label: 'Target' });
      fireAfterThrottle(s);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toContain('to your right');
    });

    it('describes a mesh to the left as "to your left"', () => {
      const s = createSceneWithCamera(0, 1);
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: -10, z: 0 });
      observer.register(mesh, { label: 'Target' });
      fireAfterThrottle(s);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toContain('to your left');
    });

    it('computes direction correctly when camera faces east (+X)', () => {
      // Facing +X: mesh at (10, 0, 0) should be "ahead"
      const s = createSceneWithCamera(1, 0);
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: 10, z: 0 });
      observer.register(mesh, { label: 'Target' });
      fireAfterThrottle(s);
      expect(observer.getDOMElement(mesh).getAttribute('aria-label')).toContain('ahead');
    });
  });

  // ── distance bands ────────────────────────────────────────────────────────

  describe('distance bands', () => {
    function labelAtDistance(dist) {
      const s = makeScene();
      s.activeCamera = makeCamera({ position: vec3(0, 0, 0), forwardX: 0, forwardZ: 1 });
      observer = new AccessibilityObserver(s);
      const mesh = makeMesh({ x: 0, z: dist });
      observer.register(mesh, { label: 'T' });
      fireAfterThrottle(s);
      const label = observer.getDOMElement(mesh).getAttribute('aria-label');
      observer.dispose();
      observer = null;
      return label;
    }

    it('labels ≤5 units as "very close"', () => {
      expect(labelAtDistance(4)).toContain('very close');
    });

    it('labels ≤15 units as "nearby"', () => {
      expect(labelAtDistance(12)).toContain('nearby');
    });

    it('labels ≤30 units as "moderate distance"', () => {
      expect(labelAtDistance(25)).toContain('moderate distance');
    });

    it('labels ≤60 units as "far away"', () => {
      expect(labelAtDistance(50)).toContain('far away');
    });

    it('labels >60 units as "distant"', () => {
      expect(labelAtDistance(100)).toContain('distant');
    });
  });

  // ── announce() ────────────────────────────────────────────────────────────

  describe('announce()', () => {
    it('sets text in the polite region after 50ms', () => {
      observer = new AccessibilityObserver(scene);
      observer.announce('Mission updated', Urgency.POLITE);
      vi.advanceTimersByTime(100);
      expect(document.getElementById('pulse-announcer-polite').textContent)
        .toBe('Mission updated');
    });

    it('sets text in the assertive region after 50ms', () => {
      observer = new AccessibilityObserver(scene);
      observer.announce('Danger ahead!', Urgency.ASSERTIVE);
      vi.advanceTimersByTime(100);
      expect(document.getElementById('pulse-announcer-assertive').textContent)
        .toBe('Danger ahead!');
    });

    it('defaults to polite urgency', () => {
      observer = new AccessibilityObserver(scene);
      observer.announce('Hello');
      vi.advanceTimersByTime(100);
      expect(document.getElementById('pulse-announcer-polite').textContent).toBe('Hello');
    });

    it('clears the region before setting new text (forces re-announcement)', () => {
      observer = new AccessibilityObserver(scene);
      const region = document.getElementById('pulse-announcer-polite');
      region.textContent = 'Old message';
      observer.announce('New message', Urgency.POLITE);
      // Immediately after announce() — region should be cleared
      expect(region.textContent).toBe('');
      vi.advanceTimersByTime(100);
      expect(region.textContent).toBe('New message');
    });

    it('does nothing after dispose()', () => {
      observer = new AccessibilityObserver(scene);
      observer.dispose();
      expect(() => observer.announce('After dispose')).not.toThrow();
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('removes the container from the DOM', () => {
      observer = new AccessibilityObserver(scene);
      observer.dispose();
      expect(document.getElementById('pulse-city-a11y')).toBeNull();
    });

    it('removes the scene observer', () => {
      observer = new AccessibilityObserver(scene);
      observer.dispose();
      expect(scene.onBeforeRenderObservable.remove).toHaveBeenCalledOnce();
    });

    it('clears all tracked nodes', () => {
      observer = new AccessibilityObserver(scene);
      observer.register(makeMesh({ uniqueId: 1 }), { type: NodeType.NPC });
      observer.register(makeMesh({ uniqueId: 2 }), { type: NodeType.VEHICLE });
      observer.dispose();
      expect(observer.trackedCount).toBe(0);
    });

    it('is safe to call twice', () => {
      observer = new AccessibilityObserver(scene);
      observer.dispose();
      expect(() => observer.dispose()).not.toThrow();
    });

    it('register() after dispose() does nothing', () => {
      observer = new AccessibilityObserver(scene);
      observer.dispose();
      expect(() => observer.register(makeMesh(), { type: NodeType.OBSTACLE })).not.toThrow();
      expect(observer.trackedCount).toBe(0);
    });
  });
});
