import { describe, expect, it } from "vitest";
import { Bone, Group } from "three";
import { BoneJSONHelper } from "./BoneJSONHelper";

function rig() {
  const root = new Group();
  root.userData.isCharacter = true;
  const group = new Group();
  const hip = new Bone(); hip.name = "pelvis";
  const arm = new Bone(); arm.name = "arm";
  hip.add(arm); group.add(hip); root.add(group);
  return { root, hip, arm };
}

describe("BoneJSONHelper", () => {
  it("round-trips non-Mixamo local bone transforms", () => {
    const source = rig();
    source.arm.rotation.set(0.2, -0.4, 0.1);
    source.hip.position.set(1, 2, 3);
    const saved = new BoneJSONHelper(source.root).toJSON();
    expect(saved.format).toBe("local-bones-v1");
    const target = rig();
    new BoneJSONHelper(target.root).poseFromBoneJSON(saved);
    expect(target.arm.quaternion.toArray()).toEqual(source.arm.quaternion.toArray());
    expect(target.hip.position.toArray()).toEqual([1, 2, 3]);
  });

  it("can copy rotations while retaining the new rig rest translations", () => {
    const source = rig(); source.arm.rotation.z = 0.7; source.hip.position.y = 2;
    const target = rig(); target.hip.position.y = 5;
    const applied = new BoneJSONHelper(target.root).poseFromBoneJSON(new BoneJSONHelper(source.root).toJSON(), { rotationsOnly: true });
    expect(applied).toBe(true);
    expect(target.hip.position.y).toBe(5);
    expect(target.arm.quaternion.z).toBeCloseTo(source.arm.quaternion.z);
  });

  it("continues to read the legacy Mixamo tree", () => {
    const source = rig(); source.hip.name = "mixamorigHips"; source.arm.rotation.z = 0.7; source.root.updateMatrixWorld(true);
    const legacy = new BoneJSONHelper(source.root).toJSON();
    const target = rig(); target.hip.name = "mixamorigHips";
    new BoneJSONHelper(target.root).poseFromBoneJSON(legacy);
    expect(target.arm.quaternion.z).toBeCloseTo(source.arm.quaternion.z);
  });

  it("does not partially apply an incompatible or malformed skeleton", () => {
    const source = rig(); source.hip.position.x = 9;
    const saved = new BoneJSONHelper(source.root).toJSON();
    const target = rig(); target.arm.name = "different";
    new BoneJSONHelper(target.root).poseFromBoneJSON(saved);
    expect(target.hip.position.x).toBe(0);
    saved.bones[1].quaternion = [0, 0, 0, 0];
    const malformedTarget = rig();
    new BoneJSONHelper(malformedTarget.root).poseFromBoneJSON(saved);
    expect(malformedTarget.hip.position.x).toBe(0);
  });
});
