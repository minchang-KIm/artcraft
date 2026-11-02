import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { solveTwoBoneIK } from "./two-bone-ik";

function rig() {
  const root = new Group(), upper = new Bone(), middle = new Bone(), end = new Bone(), other = new Bone();
  root.add(upper, other); upper.add(middle); middle.position.set(1, 0, 0); middle.add(end); end.position.set(1, 0, 0);
  root.rotation.set(.2, -.3, .4); root.position.set(2, 1, -1); root.updateMatrixWorld(true);
  return { root, upper, middle, end, other };
}

describe("two-bone IK", () => {
  it("reaches a target under a rotated parent and leaves unselected bones unchanged", () => {
    const { root, upper, middle, end, other } = rig(); const otherBefore = other.quaternion.clone();
    const target = root.localToWorld(new Vector3(1, 1, 0));
    const result = solveTwoBoneIK(upper, middle, end, target);
    expect(result.reached).toBe(true);
    expect(end.getWorldPosition(new Vector3()).distanceTo(target)).toBeLessThan(1e-5);
    expect(other.quaternion.equals(otherBefore)).toBe(true);
  });
  it("clamps unreachable targets and respects the joint rotation limit", () => {
    const { root, upper, middle, end } = rig();
    const target = root.localToWorld(new Vector3(0, 5, 0));
    const before = upper.quaternion.clone(); const result = solveTwoBoneIK(upper, middle, end, target, Math.PI / 8);
    expect(result.reached).toBe(false); expect(result.distance).toBeGreaterThan(1);
    expect(before.angleTo(upper.quaternion)).toBeLessThanOrEqual(Math.PI / 8 + 1e-6);
    expect(new Quaternion().angleTo(middle.quaternion)).toBeLessThanOrEqual(Math.PI / 8 + 1e-6);
  });
  it("handles straight and fully folded targets without non-finite rotations", () => {
    for (const p of [new Vector3(2, 0, 0), new Vector3(0, 0, 0)]) {
      const { root, upper, middle, end } = rig();
      solveTwoBoneIK(upper, middle, end, root.localToWorld(p));
      expect([...upper.quaternion.toArray(), ...middle.quaternion.toArray()].every(Number.isFinite)).toBe(true);
    }
  });
  it("rejects invalid chains and nonuniform transforms without changing the pose", () => {
    const { root, upper, middle, end, other } = rig(); const before = upper.quaternion.clone();
    expect(() => solveTwoBoneIK(upper, other, end, new Vector3())).toThrow();
    root.scale.set(1, 2, 1); root.updateMatrixWorld(true);
    expect(() => solveTwoBoneIK(upper, middle, end, new Vector3())).toThrow(/uniform/);
    expect(upper.quaternion.equals(before)).toBe(true);
  });
});
