import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Group, NumberKeyframeTrack, QuaternionKeyframeTrack, VectorKeyframeTrack } from "three";
import { validateBoneAnimation } from "./validateBoneAnimation";

describe("bone animation validation", () => {
  const root = new Group(); const bone = new Bone(); bone.name = "pelvis"; root.add(bone);
  const check = (track: any) => validateBoneAnimation(new AnimationClip("motion", 1, [track]), root);
  it("accepts a finite direct bone rotation", () => {
    expect(check(new QuaternionKeyframeTrack("pelvis.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 1, 0]))).toBe(true);
  });
  it("rejects partial, nonfinite and degenerate transforms", () => {
    expect(check(new NumberKeyframeTrack("pelvis.position[x]", [0, 1], [0, 1]))).toBe(false);
    expect(check(new VectorKeyframeTrack("pelvis.position", [0, 1], [0, 0, 0, Infinity, 1, 0]))).toBe(false);
    expect(check(new QuaternionKeyframeTrack("pelvis.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 0]))).toBe(false);
    expect(check(new VectorKeyframeTrack("pelvis.position", [0, 0], [0, 0, 0, 1, 0, 0]))).toBe(false);
  });
});
