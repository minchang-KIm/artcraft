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

  it("holds briefly, fades to calibrated local pose on loss, and resumes smoothly", () => {
    const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    const retarget = new LandmarkBoneRetarget(point(0, 0), point(1, 0), identity(), identity(), base);
    const moved = retarget.update(point(0, 0), point(0, -1), identity(), 1, Math.PI, { timestampMs: 100, mode: "fade" });
    const missing = (timestampMs: number) => retarget.update(undefined as never, undefined as never, identity(), 0.35, Math.PI, { timestampMs, mode: "fade", holdMs: 500, fadeMs: 1000 });
    expect(missing(200).angleTo(moved)).toBeLessThan(1e-6);
    expect(missing(700).angleTo(moved)).toBeLessThan(1e-6);
    expect(retarget.getTrackingState()).toBe("holding");
    expect(missing(1200).angleTo(base)).toBeCloseTo(moved.angleTo(base) / 2, 5);
    expect(retarget.getTrackingState()).toBe("fading");
    expect(missing(1700).angleTo(base)).toBeLessThan(1e-6);
    expect(retarget.getTrackingState()).toBe("lost");
    const resumed = retarget.update(point(0, 0), point(0, -1), identity(), 0.25, Math.PI, { timestampMs: 1800, mode: "fade" });
    expect(resumed.angleTo(base)).toBeCloseTo(moved.angleTo(base) * 0.25, 5);
    expect(retarget.getTrackingState()).toBe("tracking");
    expect(() => missing(1700)).toThrow(/settings/);
  });

  it("tracks axial rotation from a secondary axis without changing the parent frame", () => {
    const origin = point(0, 0), top = point(0, -1);
    const baseline: [ReturnType<typeof point>, ReturnType<typeof point>] = [point(-1, -1), point(1, -1)];
    const parent = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3);
    const local = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2);
    const tracker = new LandmarkBoneRetarget(origin, top, identity(), parent, local, false, 0.5, baseline);
    // The primary direction stays vertical while the shoulder axis turns +90° about Y.
    const turned: [ReturnType<typeof point>, ReturnType<typeof point>] = [point(0, -1, -1), point(0, -1, 1)];
    const result = tracker.update(origin, top, parent, 1, Math.PI, undefined, turned);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2).multiply(parent).multiply(local);
    expect(parent.clone().multiply(result).angleTo(expected)).toBeLessThan(1e-6);
    const held = tracker.update(origin, top, parent, 1, Math.PI, { timestampMs: 100, mode: "hold" }, [origin, top]);
    expect(held.angleTo(result)).toBeLessThan(1e-6);
    expect(tracker.getTrackingState()).toBe("holding");
    expect(() => new LandmarkBoneRetarget(origin, top, identity(), parent, local, false, 0.5, [origin, top])).toThrow(/independent/);
    const mirrored = new LandmarkBoneRetarget(origin, top, identity(), identity(), identity(), true, 0.5, baseline);
    const limited = mirrored.update(origin, top, identity(), 1, Math.PI / 4, undefined, turned);
    const expectedMirror = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 4);
    expect(limited.angleTo(expectedMirror)).toBeLessThan(1e-6);
    const uncertain = mirrored.update(origin, top, identity(), 1, Math.PI, { timestampMs: 200, mode: "hold" }, [point(0, -1, -1, 0.1), turned[1]]);
    expect(uncertain.angleTo(limited)).toBeLessThan(1e-6);
  });

  it("produces the same smoothing at different inference frame rates", () => {
    const create = () => new LandmarkBoneRetarget(point(0, 0), point(1, 0), identity(), identity(), identity());
    const fast = create(), slow = create();
    const options = (timestampMs: number) => ({ timestampMs, mode: "hold" as const, timeScaledSmoothing: true });
    fast.update(point(0, 0), point(1, 0), identity(), 0.35, Math.PI, options(0));
    slow.update(point(0, 0), point(1, 0), identity(), 0.35, Math.PI, options(0));
    for (const time of [100 / 3, 200 / 3, 100]) fast.update(point(0, 0), point(0, -1), identity(), 0.35, Math.PI, options(time));
    const result = slow.update(point(0, 0), point(0, -1), identity(), 0.35, Math.PI, options(100));
    expect(result.angleTo(fast.update(point(0, 0), point(0, -1), identity(), 0, Math.PI, options(101)))).toBeLessThan(1e-6);
  });
});
