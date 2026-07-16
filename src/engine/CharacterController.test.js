import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CharacterController } from './CharacterController.js';
import { GameCommand } from './InputManager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhysicsBody() {
  return {
    setLinearVelocity: vi.fn(),
    getLinearVelocity: vi.fn(() => ({ x: 0, y: 0, z: 0 })),
  };
}

// Returns the last velocity passed to setLinearVelocity.
function lastVel(body) {
  const calls = body.setLinearVelocity.mock.calls;
  return calls[calls.length - 1]?.[0] ?? { x: 0, y: 0, z: 0 };
}

// Camera facing direction (XZ plane only — Y is always 0 from getForwardRay).
function makeCamera({ fx = 0, fz = 1 } = {}) {
  return { getForwardRay: () => ({ direction: { x: fx, y: 0, z: fz } }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CharacterController', () => {
  let controller, body;

  afterEach(() => controller?.dispose());

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('defaults walkSpeed to 5', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body);
      expect(controller.walkSpeed).toBe(5);
    });

    it('defaults sprintSpeed to 12', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body);
      expect(controller.sprintSpeed).toBe(12);
    });

    it('defaults jumpSpeed to 8', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body);
      expect(controller.jumpSpeed).toBe(8);
    });

    it('defaults gravity to 20', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body);
      expect(controller.gravity).toBe(20);
    });

    it('accepts custom speeds', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, { walkSpeed: 3, sprintSpeed: 8, jumpSpeed: 6, gravity: 15 });
      expect(controller.walkSpeed).toBe(3);
      expect(controller.sprintSpeed).toBe(8);
      expect(controller.jumpSpeed).toBe(6);
      expect(controller.gravity).toBe(15);
    });
  });

  // ── No movement ───────────────────────────────────────────────────────────

  describe('update() — rest', () => {
    it('no commands → velocity is (0, 0, 0) when grounded', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => true,
      });
      controller.update(0.016);
      expect(lastVel(body)).toEqual({ x: 0, y: 0, z: 0 });
    });
  });

  // ── Horizontal movement (camera facing +Z) ────────────────────────────────

  describe('update() — horizontal movement, camera facing +Z', () => {
    beforeEach(() => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera({ fx: 0, fz: 1 }),
        getGrounded: () => true,
        walkSpeed:   5,
        sprintSpeed: 12,
      });
    });

    it('MOVE_FORWARD → positive Z velocity at walkSpeed', () => {
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.update(0.016);
      expect(lastVel(body).z).toBeCloseTo(5);
      expect(lastVel(body).x).toBeCloseTo(0);
    });

    it('MOVE_BACK → negative Z velocity at walkSpeed', () => {
      controller.onCommand(GameCommand.MOVE_BACK, 1);
      controller.update(0.016);
      expect(lastVel(body).z).toBeCloseTo(-5);
    });

    it('STRAFE_RIGHT → positive X velocity at walkSpeed', () => {
      controller.onCommand(GameCommand.STRAFE_RIGHT, 1);
      controller.update(0.016);
      expect(lastVel(body).x).toBeCloseTo(5);
      expect(lastVel(body).z).toBeCloseTo(0);
    });

    it('STRAFE_LEFT → negative X velocity at walkSpeed', () => {
      controller.onCommand(GameCommand.STRAFE_LEFT, 1);
      controller.update(0.016);
      expect(lastVel(body).x).toBeCloseTo(-5);
    });

    it('SPRINT + MOVE_FORWARD → Z velocity at sprintSpeed', () => {
      controller.onCommand(GameCommand.SPRINT, 1);
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.update(0.016);
      expect(lastVel(body).z).toBeCloseTo(12);
    });

    it('diagonal FORWARD + STRAFE_RIGHT is normalized to walkSpeed magnitude', () => {
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.onCommand(GameCommand.STRAFE_RIGHT, 1);
      controller.update(0.016);
      const v = lastVel(body);
      const mag = Math.sqrt(v.x * v.x + v.z * v.z);
      expect(mag).toBeCloseTo(5, 1);
    });

    it('key release (value=0) stops movement', () => {
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.update(0.016);
      controller.onCommand(GameCommand.MOVE_FORWARD, 0);
      controller.update(0.016);
      expect(lastVel(body).z).toBeCloseTo(0);
    });
  });

  // ── Camera-relative movement ──────────────────────────────────────────────

  describe('update() — camera-relative movement', () => {
    it('MOVE_FORWARD follows camera facing +X direction', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera({ fx: 1, fz: 0 }), // facing +X
        getGrounded: () => true,
        walkSpeed:   5,
      });
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.update(0.016);
      expect(lastVel(body).x).toBeCloseTo(5);
      expect(lastVel(body).z).toBeCloseTo(0);
    });

    it('STRAFE_RIGHT is perpendicular to camera forward', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera({ fx: 1, fz: 0 }), // facing +X → right is -Z
        getGrounded: () => true,
        walkSpeed:   5,
      });
      controller.onCommand(GameCommand.STRAFE_RIGHT, 1);
      controller.update(0.016);
      expect(lastVel(body).z).toBeCloseTo(-5);
      expect(lastVel(body).x).toBeCloseTo(0);
    });
  });

  // ── Vertical — gravity ────────────────────────────────────────────────────

  describe('update() — gravity', () => {
    it('applies gravity when not grounded', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => false,
        gravity:     20,
      });
      controller.update(0.1);
      expect(lastVel(body).y).toBeCloseTo(-2); // 0 - 20*0.1
    });

    it('gravity accumulates across frames', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => false,
        gravity:     20,
      });
      controller.update(0.1);
      controller.update(0.1);
      expect(lastVel(body).y).toBeCloseTo(-4); // 0 - 20*0.1 - 20*0.1
    });

    it('landing resets vertical velocity to 0', () => {
      let grounded = false;
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => grounded,
        gravity:     20,
      });
      controller.update(0.1); // falling
      grounded = true;
      controller.update(0.016); // lands
      expect(lastVel(body).y).toBeCloseTo(0);
    });
  });

  // ── Jumping ───────────────────────────────────────────────────────────────

  describe('update() — jumping', () => {
    it('JUMP when grounded sets Y to jumpSpeed', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => true,
        jumpSpeed:   8,
      });
      controller.onCommand(GameCommand.JUMP, 1);
      controller.update(0.016);
      expect(lastVel(body).y).toBeCloseTo(8);
    });

    it('JUMP when not grounded has no immediate upward effect', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => false,
        gravity:     20,
        jumpSpeed:   8,
      });
      controller.onCommand(GameCommand.JUMP, 1);
      controller.update(0.016);
      // Gravity pulls down from 0 → -0.32; should NOT be +8
      expect(lastVel(body).y).toBeLessThan(0);
    });

    it('Y velocity decays due to gravity after a jump', () => {
      let grounded = true;
      body = makePhysicsBody();
      controller = new CharacterController(body, {
        getCamera:   () => makeCamera(),
        getGrounded: () => grounded,
        jumpSpeed:   8,
        gravity:     20,
      });
      controller.onCommand(GameCommand.JUMP, 1);
      controller.update(0.016); // Y = 8

      grounded = false;
      controller.update(0.1);  // Y = 8 - 20*0.1 = 6
      expect(lastVel(body).y).toBeCloseTo(6);
    });
  });

  // ── dispose() ─────────────────────────────────────────────────────────────

  describe('dispose()', () => {
    it('is safe to call twice', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body);
      controller.dispose();
      expect(() => controller.dispose()).not.toThrow();
    });

    it('update() after dispose does nothing', () => {
      body = makePhysicsBody();
      controller = new CharacterController(body, { getGrounded: () => true });
      controller.onCommand(GameCommand.MOVE_FORWARD, 1);
      controller.dispose();
      controller.update(0.016);
      expect(body.setLinearVelocity).not.toHaveBeenCalled();
    });
  });
});
