/**
 * AccessibilityObserver — Babylon.js DOM Parallel Mirror
 *
 * Tracks registered 3D scene nodes and maintains a hidden, screen-reader-
 * accessible DOM layer that mirrors their existence and spatial position.
 * This is the accessibility backbone of Pulse City, enabling blind and
 * low-vision players to navigate the 3D world via spatial descriptions
 * delivered through aria-live regions.
 *
 * Usage:
 *   const observer = new AccessibilityObserver(scene);
 *   observer.register(vehicleMesh, { type: NodeType.VEHICLE, label: 'Taxi' });
 *   observer.announce('Objective updated', Urgency.POLITE);
 *   observer.dispose(); // on scene teardown
 */

export const NodeType = Object.freeze({
  PLAYER:      'player',
  VEHICLE:     'vehicle',
  NPC:         'npc',
  WAYPOINT:    'waypoint',
  OBSTACLE:    'obstacle',
  HAZARD:      'hazard',
  COLLECTIBLE: 'collectible',
});

export const Urgency = Object.freeze({
  POLITE:     'polite',
  ASSERTIVE:  'assertive',
});

const DISTANCE_BANDS = [
  { max: 5,        label: 'very close' },
  { max: 15,       label: 'nearby' },
  { max: 30,       label: 'moderate distance' },
  { max: 60,       label: 'far away' },
  { max: Infinity, label: 'distant' },
];

// Minimum milliseconds between DOM updates for any single tracked node.
// Keeps screen readers from being flooded during fast gameplay.
const UPDATE_THROTTLE_MS = 500;

// Delay between clearing and re-setting an aria-live region so screen
// readers register the change as a new announcement even if the text
// is identical to the previous value.
const ANNOUNCE_SETTLE_MS = 50;

export class AccessibilityObserver {
  #scene;
  #camera;
  #container;
  #politeRegion;
  #assertiveRegion;
  #nodeList;
  #trackedNodes;    // Map<AbstractMesh, { type, label, priority, el }>
  #lastUpdateTime;  // Map<AbstractMesh, DOMHighResTimeStamp>
  #renderObserver;
  #disposed = false;

  /**
   * @param {BABYLON.Scene} scene
   * @param {{ camera?: BABYLON.Camera, containerId?: string }} [options]
   */
  constructor(scene, { camera = null, containerId = 'pulse-city-a11y' } = {}) {
    this.#scene = scene;
    this.#camera = camera ?? scene.activeCamera;
    this.#trackedNodes = new Map();
    this.#lastUpdateTime = new Map();

    this.#buildDOM(containerId);
    this.#attachSceneObserver();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a Babylon.js mesh so it appears in the DOM mirror.
   *
   * @param {BABYLON.AbstractMesh} mesh
   * @param {{ type?: string, label?: string, priority?: string }} [opts]
   */
  register(mesh, { type = NodeType.OBSTACLE, label = '', priority = 'normal' } = {}) {
    if (this.#disposed || this.#trackedNodes.has(mesh)) return;

    const el = this.#createListItem(mesh, type, priority);
    this.#nodeList.appendChild(el);
    this.#trackedNodes.set(mesh, { type, label, priority, el });
    this.#lastUpdateTime.set(mesh, 0);
  }

  /**
   * Remove a mesh from the DOM mirror and clean up its element.
   *
   * @param {BABYLON.AbstractMesh} mesh
   */
  unregister(mesh) {
    const tracked = this.#trackedNodes.get(mesh);
    if (!tracked) return;
    tracked.el.remove();
    this.#trackedNodes.delete(mesh);
    this.#lastUpdateTime.delete(mesh);
  }

  /**
   * Returns the DOM element mirroring a tracked mesh, or null.
   *
   * @param {BABYLON.AbstractMesh} mesh
   * @returns {HTMLElement|null}
   */
  getDOMElement(mesh) {
    return this.#trackedNodes.get(mesh)?.el ?? null;
  }

  /**
   * Send a message to the screen reader via an aria-live region.
   * Clears the region first so identical repeated messages are re-announced.
   *
   * @param {string} message
   * @param {'polite'|'assertive'} [urgency]
   */
  announce(message, urgency = Urgency.POLITE) {
    if (this.#disposed) return;
    const region = urgency === Urgency.ASSERTIVE
      ? this.#assertiveRegion
      : this.#politeRegion;

    region.textContent = '';
    setTimeout(() => { region.textContent = message; }, ANNOUNCE_SETTLE_MS);
  }

  /** Number of currently tracked meshes. */
  get trackedCount() {
    return this.#trackedNodes.size;
  }

  /**
   * Detach from the scene and remove all DOM elements.
   * Call this when the scene is destroyed.
   */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;

    if (this.#renderObserver) {
      this.#scene.onBeforeRenderObservable.remove(this.#renderObserver);
      this.#renderObserver = null;
    }

    this.#container.remove();
    this.#trackedNodes.clear();
    this.#lastUpdateTime.clear();
  }

  // ---------------------------------------------------------------------------
  // Private — DOM construction
  // ---------------------------------------------------------------------------

  #buildDOM(containerId) {
    this.#container = document.createElement('div');
    this.#container.id = containerId;
    this.#container.setAttribute('aria-label', 'Pulse City Accessibility Layer');
    this.#container.className = 'sr-only';

    this.#politeRegion = document.createElement('div');
    this.#politeRegion.id = 'pulse-announcer-polite';
    this.#politeRegion.setAttribute('aria-live', 'polite');
    this.#politeRegion.setAttribute('aria-atomic', 'true');

    this.#assertiveRegion = document.createElement('div');
    this.#assertiveRegion.id = 'pulse-announcer-assertive';
    this.#assertiveRegion.setAttribute('aria-live', 'assertive');
    this.#assertiveRegion.setAttribute('aria-atomic', 'true');

    this.#nodeList = document.createElement('ul');
    this.#nodeList.setAttribute('aria-label', 'Nearby objects');
    this.#nodeList.setAttribute('role', 'list');

    this.#container.appendChild(this.#politeRegion);
    this.#container.appendChild(this.#assertiveRegion);
    this.#container.appendChild(this.#nodeList);

    document.body.appendChild(this.#container);
  }

  #createListItem(mesh, type, priority) {
    const li = document.createElement('li');
    li.setAttribute('role', 'listitem');
    li.dataset.meshId = String(mesh.uniqueId ?? mesh.name);
    li.dataset.type = type;
    li.dataset.priority = priority;
    return li;
  }

  // ---------------------------------------------------------------------------
  // Private — scene observer & spatial updates
  // ---------------------------------------------------------------------------

  #attachSceneObserver() {
    this.#renderObserver = this.#scene.onBeforeRenderObservable.add(() => {
      this.#updateDescriptions();
    });
  }

  #updateDescriptions() {
    const now = Date.now();
    const camera = this.#camera ?? this.#scene.activeCamera;
    if (!camera) return;

    for (const [mesh, tracked] of this.#trackedNodes) {
      if (now - (this.#lastUpdateTime.get(mesh) ?? 0) < UPDATE_THROTTLE_MS) continue;
      if (!mesh.isEnabled() || !mesh.isVisible) continue;

      const description = this.#computeSpatialDescription(mesh, camera);
      const label = `${tracked.label || tracked.type}: ${description}`;

      if (tracked.el.getAttribute('aria-label') !== label) {
        tracked.el.setAttribute('aria-label', label);
        tracked.el.textContent = label;
      }

      this.#lastUpdateTime.set(mesh, now);
    }
  }

  /**
   * Produces a human-readable spatial description relative to the camera.
   * Returns a string like "nearby, to your left".
   */
  #computeSpatialDescription(mesh, camera) {
    const camPos = camera.position;
    const meshPos = mesh.absolutePosition ?? mesh.position;

    const dx = meshPos.x - camPos.x;
    const dz = meshPos.z - camPos.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    const distLabel = DISTANCE_BANDS.find((b) => distance <= b.max)?.label ?? 'distant';
    const direction = this.#computeDirection(dx, dz, camera);

    return `${distLabel}, ${direction}`;
  }

  /**
   * Converts a vector (dx, dz) from camera to mesh into a clock-relative
   * direction string, taking camera orientation into account.
   */
  #computeDirection(dx, dz, camera) {
    const forward = this.#getCameraForward(camera);

    // Angle of the vector to the mesh, and angle the camera faces — both in
    // the XZ plane. Using atan2(x, z) so that +Z (Babylon forward) = angle 0.
    const toMeshAngle  = Math.atan2(dx, dz);
    const forwardAngle = Math.atan2(forward.x, forward.z);

    let relative = toMeshAngle - forwardAngle;
    // Normalize to (-π, π]
    while (relative >  Math.PI) relative -= 2 * Math.PI;
    while (relative < -Math.PI) relative += 2 * Math.PI;

    return this.#relativeAngleToLabel(relative);
  }

  #getCameraForward(camera) {
    if (typeof camera.getForwardRay === 'function') {
      const ray = camera.getForwardRay(1);
      return { x: ray.direction.x, z: ray.direction.z };
    }
    // Fallback — assume camera is looking along +Z (Babylon's default)
    return { x: 0, z: 1 };
  }

  /**
   * Maps a relative angle (radians, camera-relative) to a direction label.
   * Positive = clockwise = right. Segments of 45° each.
   */
  #relativeAngleToLabel(radians) {
    const deg = (radians * 180) / Math.PI;
    const abs = Math.abs(deg);

    if (abs <= 22.5)  return 'ahead';
    if (abs >= 157.5) return 'behind you';

    if (deg > 0) {
      if (deg <= 67.5)  return 'ahead to your right';
      if (deg <= 112.5) return 'to your right';
      return 'behind to your right';
    } else {
      if (abs <= 67.5)  return 'ahead to your left';
      if (abs <= 112.5) return 'to your left';
      return 'behind to your left';
    }
  }
}
