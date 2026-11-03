import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Group, Quaternion, QuaternionKeyframeTrack, Scene } from "three";
import { TimelineController } from "./TimelineController";
import { CharacterAnimationManager } from "../animation/CharacterAnimationManager";
import type Editor from "../editor";

function fixture() {
  const scene = new Scene(), character = new Group(), bone = new Bone();
  character.userData.isCharacter = true; bone.name = "arm"; character.add(bone); scene.add(character);
  const editor = { activeScene: { scene }, characterAnimationManager: { sync() {}, evaluateAt() {}, clear() {}, assertReadyForCapture() {} },
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

  it("rejects invalid paths atomically and allows clip lanes with bone keys", () => {
    const { timeline, character, path } = fixture();
    expect(() => timeline.addBoneRotationKeys(character.uuid, [path, [{ ...path[0], name: "wrong" }]])).toThrow();
    expect(timeline.getTimeline()?.boneTracks).toBeUndefined();
    timeline.addBoneRotationKeys(character.uuid, [path]);
    expect(timeline.addClipLane(character.uuid, { sourceMediaId: "test", name: "test", startTime: 0, duration: 1, loop: false })).not.toBeNull();
    const key = timeline.getTimeline()!.boneTracks![0].keyframes[0];
    timeline.deleteBoneRotationKey(key.id);
    expect(timeline.getTimeline()?.boneTracks).toEqual([]);
  });

  it("moves, eases and deletes bone keys through the shared timeline commands", () => {
    const { timeline, character, bone, path } = fixture();
    timeline.addBoneRotationKeys(character.uuid, [path]);
    timeline.seekTo(2); bone.quaternion.set(0, 0, 1, 0); timeline.addBoneRotationKeys(character.uuid, [path]);
    const track = timeline.getTimeline()!.boneTracks![0];
    const [first, second] = track.keyframes;
    timeline.moveKeyframe(second.id, 0);
    expect(second.time).toBe(2);
    timeline.moveKeyframe(second.id, 4);
    expect(second.time).toBe(4);
    timeline.setEasing(first.id, { p1x: 0.42, p1y: 0, p2x: 1, p2y: 1 });
    timeline.seekTo(2);
    expect(bone.quaternion.angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeGreaterThan(0.1);
    timeline.deleteKeyframe(second.id);
    expect(track.keyframes.map(key => key.id)).toEqual([first.id]);
  });

  it("layers keys over clip rotations and reapplies them after mixer reevaluation", () => {
    const scene = new Scene(), character = new Group(), keyed = new Bone(), other = new Bone();
    character.userData.isCharacter = true; keyed.name = "keyed"; other.name = "other";
    character.add(keyed, other); scene.add(character);
    character.animations = [new AnimationClip("motion", 2, [
      new QuaternionKeyframeTrack("keyed.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 1, 0]),
      new QuaternionKeyframeTrack("other.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 1, 0]),
    ])];
    const editor = { activeScene: { scene }, cameraController: { getCameraPersonMode: () => false }, bus: { emit() {} }, history: { record() {} } } as unknown as Editor;
    editor.timelineController = new TimelineController(editor);
    editor.characterAnimationManager = new CharacterAnimationManager(editor);
    const timeline = editor.timelineController; timeline.create();
    timeline.addClipLane(character.uuid, { sourceMediaId: "", bakedClipIndex: 0, name: "motion", startTime: 0, duration: 2, loop: false });
    timeline.seekTo(0); keyed.quaternion.set(0, 0, 0, 1);
    timeline.addBoneRotationKeys(character.uuid, [[{ index: 0, name: "keyed", type: "Bone" }]]);
    timeline.seekTo(1);
    expect(keyed.quaternion.angleTo(new Quaternion())).toBeCloseTo(0);
    expect(other.quaternion.angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0);
    editor.characterAnimationManager.evaluateAt(1.5);
    expect(keyed.quaternion.angleTo(new Quaternion())).toBeCloseTo(0);
    expect(other.quaternion.z).toBeGreaterThan(0.9);
  });
  it("captures bone position and scale without altering the character root or losing channels on an IK key", () => {
    const { timeline, character, bone, path } = fixture();
    character.position.x = 7; bone.position.x = 1; bone.scale.setScalar(1);
    timeline.addBoneRotationKeys(character.uuid, [path], true);
    timeline.seekTo(2); bone.position.x = 3; bone.scale.setScalar(3);
    timeline.addBoneRotationKeys(character.uuid, [path], true);
    timeline.addBoneRotationKeys(character.uuid, [path]);
    timeline.seekTo(1);
    expect(bone.position.x).toBeCloseTo(2); expect(bone.scale.x).toBeCloseTo(2);
    expect(character.position.x).toBe(7);
    expect(timeline.getTimeline()!.boneTracks![0].keyframes[1].position).toEqual([3,0,0]);
    const saved = JSON.parse(JSON.stringify(timeline.getTimeline()));
    bone.position.x = 99; bone.scale.setScalar(99); timeline.loadTimeline(saved);
    expect(bone.position.x).toBeCloseTo(2); expect(bone.scale.x).toBeCloseTo(2);
  });
});
