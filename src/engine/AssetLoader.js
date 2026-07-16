/**
 * AssetLoader — glTF / Draco-compressed asset pipeline for Pulse City.
 *
 * Loads .glb files via an injected loadMesh function, then wires each asset's
 * root mesh into the accessibility (AccessibilityObserver) and spatial-audio
 * (SpatialAudioManager) systems so that screen readers and the beacon sweep
 * automatically discover every loaded object.
 *
 * Usage:
 *   const loader = new AssetLoader(scene, a11y, spatial, { loadMesh });
 *   const map = await loader.loadAll([
 *     { id: 'taxi',  url: '/assets/vehicles/taxi.glb',
 *       nodeType: NodeType.VEHICLE,  label: 'Taxi',
 *       position: { x: 10, y: 0, z: 20 }, priority: 'normal' },
 *   ]);
 *   // map.taxi → Mesh[]
 *   loader.dispose();
 *
 * Dependency injection:
 *   The `loadMesh` option defaults to a SceneLoader.ImportMeshAsync call
 *   (dynamically imports @babylonjs/core + @babylonjs/loaders/glTF/index.js).
 *   Pass a mock in tests to keep them Babylon-free.
 *
 * Draco setup (call once in main.js before any loadAll()):
 *   BABYLON.DracoCompression.Configuration = { decoder: { wasmUrl, wasmBinaryUrl, fallbackUrl } };
 *   await import('@babylonjs/loaders/glTF/index.js');  // registers the GLTF plugin
 */

export class AssetLoader {
  #scene;
  #a11y;
  #spatial;
  #loadMesh;
  #loadedAssets;  // Map<id, { root: Mesh, meshes: Mesh[] }>
  #disposed;

  /**
   * @param {object}  scene
   * @param {object}  a11y     — { register, unregister }
   * @param {object}  spatial  — { register, unregister }
   * @param {{
   *   loadMesh?: (url: string, scene: object) => Promise<object[]>
   * }} [options]
   */
  constructor(scene, a11y, spatial, { loadMesh } = {}) {
    this.#scene       = scene;
    this.#a11y        = a11y;
    this.#spatial     = spatial;
    this.#loadMesh    = loadMesh ?? AssetLoader.#defaultLoadMesh;
    this.#loadedAssets = new Map();
    this.#disposed    = false;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Number of successfully loaded (and not yet disposed) assets. */
  get loadedCount() { return this.#loadedAssets.size; }

  /**
   * Load all entries in the manifest concurrently.
   * Failed entries are logged and skipped; they will not block other loads.
   *
   * @param {Array<{
   *   id:       string,
   *   url:      string,
   *   nodeType: string,
   *   label:    string,
   *   position?: { x?: number, y?: number, z?: number },
   *   priority?: string,
   * }>} manifest
   * @returns {Promise<{ [id: string]: object[] }>}  Map of id → mesh array
   */
  async loadAll(manifest) {
    if (this.#disposed) return {};

    const results = await Promise.all(
      manifest.map(async (entry) => ({
        id:     entry.id,
        meshes: await this.#loadOne(entry),
      })),
    );

    return Object.fromEntries(results.map(({ id, meshes }) => [id, meshes]));
  }

  /**
   * Unregister all loaded meshes from a11y and spatial, then dispose
   * the Babylon mesh objects to release GPU memory.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    for (const { root, meshes } of this.#loadedAssets.values()) {
      this.#a11y.unregister(root);
      this.#spatial.unregister(root);
      for (const mesh of meshes) mesh.dispose?.();
    }
    this.#loadedAssets.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async #loadOne(entry) {
    try {
      const meshes = await this.#loadMesh(entry.url, this.#scene);
      if (!meshes || meshes.length === 0) return [];

      const root = meshes[0];

      // Position the root node in world space if specified.
      // glTF bakes local transforms inside the file; override only when the
      // manifest gives explicit world coordinates.
      if (entry.position && root.position) {
        root.position.x = entry.position.x ?? 0;
        root.position.y = entry.position.y ?? 0;
        root.position.z = entry.position.z ?? 0;
      }

      // Wire into accessibility layer (DOM mirror + screen-reader descriptions).
      this.#a11y.register(root, {
        type:     entry.nodeType,
        label:    entry.label,
        priority: entry.priority ?? 'normal',
      });

      // Wire into spatial audio beacon sweep (heard after each Pulse scan).
      this.#spatial.register(root, {
        type:  entry.nodeType,
        label: entry.label,
      });

      this.#loadedAssets.set(entry.id, { root, meshes });
      return meshes;
    } catch (err) {
      console.warn(`[AssetLoader] Failed to load "${entry.id}" from "${entry.url}":`, err);
      return [];
    }
  }

  // Default loader: dynamically imports Babylon so tests stay BABYLON-free.
  static async #defaultLoadMesh(url, scene) {
    await import('@babylonjs/loaders/glTF/index.js');  // side-effect: registers GLTF plugin
    const { SceneLoader } = await import('@babylonjs/core');
    const lastSlash = url.lastIndexOf('/');
    const rootUrl   = url.slice(0, lastSlash + 1) || './';
    const filename  = url.slice(lastSlash + 1);
    const { meshes } = await SceneLoader.ImportMeshAsync('', rootUrl, filename, scene);
    return meshes;
  }
}
