/**
 * CharacterController — on-foot movement for Pulse City.
 *
 * Maps InputManager commands to kinematic velocity on an injected physics
 * body. Movement is always camera-relative so WASD feels natural regardless
 * of which direction the player is looking. PhysicsManager calls onCommand()
 * from InputManager's subscriber and update() once per render frame.
 *
 * The physics body handles actual collision response; this class owns only
 * the intent (desired velocity) layer. For Havok integration in main.js,
 * pass a thin adapter around PhysicsAggregate.body.
 *
 * Usage:
 *   const cc = new CharacterController(physicsBody, { getCamera, getGrounded });
 *   input.onCommand((cmd, val) => cc.onCommand(cmd, val));
 *   scene.onBeforeRender(() => cc.update(scene.deltaTime / 1000));
 *   cc.dispose();
 */

import { GameCommand } from './InputManager.js';

export class CharacterController {
  #body;
  #getCamera;
  #getGrounded;
  #walkSpeed;
  #sprintSpeed;
  #jumpSpeed;
  #gravity;

  #commandState;   // Map<GameCommand, number>
  #verticalVel;    // accumulated Y velocity (m/s, positive = up)
  #jumpPending;    // true when JUMP pressed and waiting for ground confirmation
  #disposed;

  /**
   * @param {object} physicsBody — { setLinearVelocity({x,y,z}), getLinearVelocity() }
   * @param {{
   *   getCamera?:   () => object,
   *   getGrounded?: () => boolean,
   *   walkSpeed?:   number,
   *   sprintSpeed?: number,
   *   jumpSpeed?:   number,
   *   gravity?:     number,
   * }} [options]
   */
  constructor(physicsBody, {
    getCamera   = () => null,
    getGrounded = () => false,
    walkSpeed   = 5,
    sprintSpeed = 12,
    jumpSpeed   = 8,
    gravity     = 20,
  } = {}) {
    this.#body        = physicsBody;
    this.#getCamera   = getCamera;
    this.#getGrounded = getGrounded;
    this.#walkSpeed   = walkSpeed;
    this.#sprintSpeed = sprintSpeed;
    this.#jumpSpeed   = jumpSpeed;
    this.#gravity     = gravity;

    this.#commandState = new Map();
    this.#verticalVel  = 0;
    this.#jumpPending  = false;
    this.#disposed     = false;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get walkSpeed()   { return this.#walkSpeed; }
  get sprintSpeed() { return this.#sprintSpeed; }
  get jumpSpeed()   { return this.#jumpSpeed; }
  get gravity()     { return this.#gravity; }

  /** Called by PhysicsManager on every InputManager command event. */
  onCommand(command, value) {
    this.#commandState.set(command, value);
    if (command === GameCommand.JUMP && value === 1) {
      this.#jumpPending = true;
    }
  }

  /**
   * Apply movement for one frame.
   * @param {number} deltaS  — elapsed seconds since last frame
   */
  update(deltaS) {
    if (this.#disposed) return;

    // ── Horizontal movement (camera-relative) ────────────────────────────
    const fwdAxis    = this.#val(GameCommand.MOVE_FORWARD)  - this.#val(GameCommand.MOVE_BACK);
    const strafeAxis = this.#val(GameCommand.STRAFE_RIGHT)  - this.#val(GameCommand.STRAFE_LEFT);

    let vx = 0, vz = 0;
    const camera = this.#getCamera();
    if (camera && (fwdAxis !== 0 || strafeAxis !== 0)) {
      const dir  = camera.getForwardRay(1).direction;
      const fx   = dir.x, fz = dir.z;
      const flen = Math.sqrt(fx * fx + fz * fz) || 1;

      // Normalised XZ forward, and its 90°-clockwise perpendicular (right).
      const fwdX = fx / flen, fwdZ = fz / flen;
      const rgtX = fwdZ, rgtZ = -fwdX;   // right = (fz, 0, -fx) in left-handed XZ

      const mx   = fwdAxis * fwdX + strafeAxis * rgtX;
      const mz   = fwdAxis * fwdZ + strafeAxis * rgtZ;
      const mlen = Math.sqrt(mx * mx + mz * mz);

      if (mlen > 0) {
        const speed = this.#val(GameCommand.SPRINT) > 0 ? this.#sprintSpeed : this.#walkSpeed;
        vx = (mx / mlen) * speed;
        vz = (mz / mlen) * speed;
      }
    }

    // ── Vertical movement (jump + gravity) ───────────────────────────────
    const grounded = this.#getGrounded();
    if (grounded && this.#jumpPending) {
      this.#verticalVel = this.#jumpSpeed;
      this.#jumpPending = false;
    } else if (grounded) {
      this.#verticalVel = 0;
    } else {
      this.#verticalVel -= this.#gravity * deltaS;
    }

    this.#body.setLinearVelocity({ x: vx, y: this.#verticalVel, z: vz });
  }

  dispose() {
    this.#disposed = true;
    this.#commandState.clear();
    this.#jumpPending = false;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #val(command) { return this.#commandState.get(command) ?? 0; }
}
