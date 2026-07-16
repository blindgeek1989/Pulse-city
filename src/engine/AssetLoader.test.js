import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AssetLoader } from './AssetLoader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMesh(overrides = {}) {
  return {
    position: { x: 0, y: 0, z: 0 },
    dispose:  vi.fn(),
    ...overrides,
  };
}

function makeA11y()    { return { register: vi.fn(), unregister: vi.fn() }; }
function makeSpatial() { return { register: vi.fn(), unregister: vi.fn() }; }
const SCENE = {};

function makeLoader({ meshes = [makeMesh()], rejectWith } = {}) {
  const loadMesh = rejectWith
    ? vi.fn().mockRejectedValue(rejectWith)
    : vi.fn().mockResolvedValue(meshes);
  const a11y    = makeA11y();
  const spatial = makeSpatial();
  const loader  = new AssetLoader(SCENE, a11y, spatial, { loadMesh });
  return { loader, loadMesh, a11y, spatial };
}

const ENTRY = {
  id:       'taxi',
  url:      '/assets/vehicles/taxi.glb',
  nodeType: 'vehicle',
  label:    'Taxi',
  position: { x: 10, y: 0, z: 20 },
  priority: 'normal',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssetLoader', () => {
  // ── loadAll() ─────────────────────────────────────────────────────────────

  describe('loadAll()', () => {
    it('returns {} for an empty manifest', async () => {
      const { loader } = makeLoader();
      expect(await loader.loadAll([])).toEqual({});
    });

    it('calls loadMesh with the entry url and scene', async () => {
      const { loader, loadMesh } = makeLoader();
      await loader.loadAll([ENTRY]);
      expect(loadMesh).toHaveBeenCalledWith(ENTRY.url, SCENE);
    });

    it('registers root mesh with a11y using correct type, label, and priority', async () => {
      const root = makeMesh();
      const { loader, a11y } = makeLoader({ meshes: [root] });
      await loader.loadAll([ENTRY]);
      expect(a11y.register).toHaveBeenCalledWith(root, {
        type:     'vehicle',
        label:    'Taxi',
        priority: 'normal',
      });
    });

    it('registers root mesh with spatial using correct type and label', async () => {
      const root = makeMesh();
      const { loader, spatial } = makeLoader({ meshes: [root] });
      await loader.loadAll([ENTRY]);
      expect(spatial.register).toHaveBeenCalledWith(root, {
        type:  'vehicle',
        label: 'Taxi',
      });
    });

    it('positions root mesh from entry.position', async () => {
      const root = makeMesh();
      const { loader } = makeLoader({ meshes: [root] });
      await loader.loadAll([{ ...ENTRY, position: { x: 5, y: 1, z: -3 } }]);
      expect(root.position).toEqual({ x: 5, y: 1, z: -3 });
    });

    it('defaults missing position components to 0', async () => {
      const root = makeMesh();
      const { loader } = makeLoader({ meshes: [root] });
      await loader.loadAll([{ ...ENTRY, position: { x: 7 } }]);
      expect(root.position.x).toBe(7);
      expect(root.position.y).toBe(0);
      expect(root.position.z).toBe(0);
    });

    it('does not touch position when entry.position is absent', async () => {
      const root = makeMesh({ position: { x: 99, y: 0, z: 0 } });
      const { loader } = makeLoader({ meshes: [root] });
      await loader.loadAll([{ ...ENTRY, position: undefined }]);
      expect(root.position.x).toBe(99);  // unchanged
    });

    it('returns map keyed by id', async () => {
      const root = makeMesh();
      const { loader } = makeLoader({ meshes: [root] });
      const result = await loader.loadAll([ENTRY]);
      expect(result).toHaveProperty('taxi');
      expect(result.taxi[0]).toBe(root);
    });

    it('loads multiple entries and includes all ids in result', async () => {
      const loadMesh = vi.fn().mockResolvedValue([makeMesh()]);
      const loader = new AssetLoader(SCENE, makeA11y(), makeSpatial(), { loadMesh });
      const result = await loader.loadAll([
        { ...ENTRY, id: 'a', url: '/a.glb' },
        { ...ENTRY, id: 'b', url: '/b.glb' },
      ]);
      expect(Object.keys(result)).toEqual(['a', 'b']);
      expect(loadMesh).toHaveBeenCalledTimes(2);
    });

    it('uses first mesh as root for multi-mesh assets', async () => {
      const root   = makeMesh();
      const child  = makeMesh();
      const { loader, a11y } = makeLoader({ meshes: [root, child] });
      await loader.loadAll([ENTRY]);
      expect(a11y.register.mock.calls[0][0]).toBe(root);
    });

    it('defaults priority to "normal" when not in entry', async () => {
      const { loader, a11y } = makeLoader();
      await loader.loadAll([{ ...ENTRY, priority: undefined }]);
      expect(a11y.register.mock.calls[0][1].priority).toBe('normal');
    });

    it('skips a failed entry — other entries still load', async () => {
      const goodMesh = makeMesh();
      const loadMesh = vi.fn()
        .mockRejectedValueOnce(new Error('404'))
        .mockResolvedValueOnce([goodMesh]);
      const a11y    = makeA11y();
      const spatial = makeSpatial();
      const loader  = new AssetLoader(SCENE, a11y, spatial, { loadMesh });
      await loader.loadAll([
        { ...ENTRY, id: 'bad',  url: '/missing.glb' },
        { ...ENTRY, id: 'good', url: '/good.glb'    },
      ]);
      expect(a11y.register).toHaveBeenCalledTimes(1);
      expect(a11y.register.mock.calls[0][0]).toBe(goodMesh);
    });

    it('returns empty array for a failed entry', async () => {
      const { loader } = makeLoader({ rejectWith: new Error('404') });
      const result = await loader.loadAll([ENTRY]);
      expect(result.taxi).toEqual([]);
    });

    it('returns {} immediately after dispose()', async () => {
      const { loader } = makeLoader();
      loader.dispose();
      expect(await loader.loadAll([ENTRY])).toEqual({});
    });
  });

  // ── loadedCount ───────────────────────────────────────────────────────────

  describe('loadedCount', () => {
    it('is 0 before any loads', () => {
      const { loader } = makeLoader();
      expect(loader.loadedCount).toBe(0);
    });

    it('increments after a successful load', async () => {
      const { loader } = makeLoader();
      await loader.loadAll([ENTRY]);
      expect(loader.loadedCount).toBe(1);
    });

    it('does not increment for a failed load', async () => {
      const { loader } = makeLoader({ rejectWith: new Error('404') });
      await loader.loadAll([ENTRY]);
      expect(loader.loadedCount).toBe(0);
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('unregisters root mesh from a11y', async () => {
      const root = makeMesh();
      const { loader, a11y } = makeLoader({ meshes: [root] });
      await loader.loadAll([ENTRY]);
      loader.dispose();
      expect(a11y.unregister).toHaveBeenCalledWith(root);
    });

    it('unregisters root mesh from spatial', async () => {
      const root = makeMesh();
      const { loader, spatial } = makeLoader({ meshes: [root] });
      await loader.loadAll([ENTRY]);
      loader.dispose();
      expect(spatial.unregister).toHaveBeenCalledWith(root);
    });

    it('calls dispose() on all meshes', async () => {
      const root  = makeMesh();
      const child = makeMesh();
      const { loader } = makeLoader({ meshes: [root, child] });
      await loader.loadAll([ENTRY]);
      loader.dispose();
      expect(root.dispose).toHaveBeenCalled();
      expect(child.dispose).toHaveBeenCalled();
    });

    it('is safe to call twice', async () => {
      const { loader } = makeLoader();
      await loader.loadAll([ENTRY]);
      expect(() => { loader.dispose(); loader.dispose(); }).not.toThrow();
    });
  });
});
