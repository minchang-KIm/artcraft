import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, Vector3 } from "three";
import { resolveBonePath, sampleBoneRotation, sampleBoneVector } from "./boneRotation";
import { EASING_PRESETS, type BoneRotationTrack } from "./types";

const track = (): BoneRotationTrack => ({
  objectUuid: "character",
  path: [{ index: 0, name: "arm", type: "Bone" }],
  keyframes: [
    { id: "a", time: 0, rotation: [0, 0, 0, 1], easing: EASING_PRESETS.linear },
    { id: "b", time: 2, rotation: [0, 0, 1, 0], easing: EASING_PRESETS.linear },
  ],
});

describe("bone rotation tracks", () => {
  it("resolves exact indexed paths and refuses changed hierarchy or non-bones", () => {
    const root = new Group(), arm = new Bone(), wrong = new Group();
    arm.name = "arm"; wrong.name = "arm"; root.add(arm, wrong);
    expect(resolveBonePath(root, track().path)).toBe(arm);
    expect(resolveBonePath(root, [{ index: 1, name: "arm", type: "Group" }])).toBeNull();
    expect(resolveBonePath(root, [{ index: 0, name: "other", type: "Bone" }])).toBeNull();
    expect(resolveBonePath(root, [])).toBeNull();
  });

  it("clamps outside the range and slerps halfway along the shortest arc", () => {
    const t = track();
    expect(sampleBoneRotation(t, -1)?.angleTo(new Quaternion())).toBeCloseTo(0);
    const middle = sampleBoneRotation(t, 1)!;
    const direction = new Vector3(1, 0, 0).applyQuaternion(middle);
    expect(direction.x).toBeCloseTo(0); expect(direction.y).toBeCloseTo(1);
    expect(sampleBoneRotation(t, 3)?.angleTo(new Quaternion(0, 0, 1, 0))).toBeCloseTo(0);
    t.keyframes[1].rotation = [0, 0, -1, 0];
    expect(sampleBoneRotation(t, 1)?.angleTo(new Quaternion(0, 0, -Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0);
  });

  it("rejects invalid quaternions, time order and easing", () => {
    const t = track(); t.keyframes[1].rotation = [0, 0, 0, 0];
    expect(sampleBoneRotation(t, 1)).toBeNull();
    t.keyframes[1].rotation = [0, 0, 1, 0]; t.keyframes[1].time = 0;
    expect(sampleBoneRotation(t, 1)).toBeNull();
    t.keyframes[1].time = 2; t.keyframes[0].easing = { ...EASING_PRESETS.linear, p1x: 2 };
    expect(sampleBoneRotation(t, 1)).toBeNull();
  });
  it("samples sparse position and scale channels without changing legacy rotations", () => {
    const t = track();
    expect(sampleBoneVector(t, 1, "position")).toBeUndefined();
    t.keyframes[0].position = [0, 1, 2]; t.keyframes[1].position = [2, 3, 4];
    t.keyframes[0].scale = [1, 1, 1]; t.keyframes[1].scale = [3, 3, 3];
    expect(sampleBoneVector(t, 1, "position")?.toArray()).toEqual([1, 2, 3]);
    expect(sampleBoneVector(t, 1, "scale")?.toArray()).toEqual([2, 2, 2]);
    t.keyframes[1].position = [NaN, 0, 0];
    expect(sampleBoneVector(t, 1, "position")).toBeNull();
  });
});
