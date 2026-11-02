import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { LandmarkBoneRetarget } from "./landmark-retarget";

const point = (x: number, y: number, z = 0, visibility = 1) => ({ x, y, z, visibility });
const identity = () => new Quaternion();
const expectDirection = (actual: Vector3, expected: Vector3) => expect(actual.distanceTo(expected)).toBeLessThan(1e-6);

describe("single bone landmark retarget", () => {
  it("uses calibration and the current parent frame without touching unrelated transforms", () => {
    const parent = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 3);
    const local = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.3);
    const other = local.clone();
    const retarget = new LandmarkBoneRetarget(point(0, 0), point(1, 0), identity(), parent, local);
    const rotatedParent = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 4);
    const result = retarget.update(point(0, 0), point(0, -1), rotatedParent, 1);
    const actualWorld = rotatedParent.clone().multiply(result);
    const expectedWorld = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).multiply(parent).multiply(local);
    expect(actualWorld.angleTo(expectedWorld)).toBeLessThan(1e-6);
    expect(other.equals(local)).toBe(true);
  });

  it("maps the calibrated camera frame and mirror, and limits sudden motion", () => {
    const camera = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const retarget = new LandmarkBoneRetarget(point(0, 0), point(1, 0), camera, identity(), identity(), true);
    const result = retarget.update(point(0, 0), point(0, -1), identity(), 1, Math.PI / 4);
    expect(result.angleTo(identity())).toBeCloseTo(Math.PI / 4);
    const source = new Vector3(-1, 0, 0).applyQuaternion(camera);
    const target = source.clone().applyQuaternion(result);
    expectDirection(target, source.clone().lerp(new Vector3(0, 1, 0), 0.5).normalize());
  });

  it("holds the previous result for missing, low confidence and degenerate observations", () => {
    const retarget = new LandmarkBoneRetarget(point(0, 0), point(1, 0), identity(), identity(), identity());
    const previous = retarget.update(point(0, 0), point(0, -1), identity(), 1);
    expect(retarget.update(point(0, 0, 0, 0.1), point(1, 0), identity()).angleTo(previous)).toBeLessThan(1e-6);
    expect(retarget.update(point(0, 0), point(0, 0), identity()).angleTo(previous)).toBeLessThan(1e-6);
    expect(retarget.update(undefined as never, point(1, 0), identity()).angleTo(previous)).toBeLessThan(1e-6);
  });

  it("rejects invalid calibration and update settings", () => {
    expect(() => new LandmarkBoneRetarget(point(0, 0), point(0, 0), identity(), identity(), identity())).toThrow();
    const retarget = new LandmarkBoneRetarget(point(0, 0), point(1, 0), identity(), identity(), identity());
    expect(() => retarget.update(point(0, 0), point(1, 0), identity(), NaN)).toThrow();
  });
});
