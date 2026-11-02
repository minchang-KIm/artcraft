import { describe, expect, it } from "vitest";
import { Bone, Group, Quaternion, Scene } from "three";
import { TimelineController } from "./TimelineController";
import type Editor from "../editor";

function fixture() {
  const scene = new Scene(), character = new Group(), bone = new Bone();
  character.userData.isCharacter = true; bone.name = "arm"; character.add(bone); scene.add(character);
  const editor = { activeScene: { scene }, characterAnimationManager: { sync() {}, evaluateAt() {}, clear() {} },
    cameraController: { getCameraPersonMode: () => false }, bus: { emit() {} }, history: { record() {} } } as unknown as Editor;
  const timeline = new TimelineController(editor); timeline.create();
  const path = [{ index: 0, name: "arm", type: "Bone" }];
  return { timeline, character, bone, path };
}

describe("bone timeline playback", () => {
  it("captures two poses and interpolates on seek, preserving root translation", () => {
    const { timeline, character, bone, path } = fixture();
    character.position.x = 5;
    timeline.addBoneRotationKeys(character.uuid, [path]);
    timeline.seekTo(2); bone.quaternion.set(0, 0, 1, 0);
    timeline.addBoneRotationKeys(character.uuid, [path]);
    timeline.seekTo(1);
    expect(bone.quaternion.angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0);
    expect(character.position.x).toBe(5);
    const saved = JSON.parse(JSON.stringify(timeline.getTimeline()));
    bone.quaternion.identity(); timeline.loadTimeline(saved);
    expect(bone.quaternion.angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0);
  });

  it("rejects invalid paths atomically and refuses overlapping clip lanes", () => {
    const { timeline, character, path } = fixture();
    expect(() => timeline.addBoneRotationKeys(character.uuid, [path, [{ ...path[0], name: "wrong" }]])).toThrow();
    expect(timeline.getTimeline()?.boneTracks).toBeUndefined();
    timeline.addBoneRotationKeys(character.uuid, [path]);
    expect(timeline.addClipLane(character.uuid, { sourceMediaId: "test", name: "test", startTime: 0, duration: 1, loop: false })).toBeNull();
    const key = timeline.getTimeline()!.boneTracks![0].keyframes[0];
    timeline.deleteBoneRotationKey(key.id);
    expect(timeline.getTimeline()?.boneTracks).toEqual([]);
  });
});
