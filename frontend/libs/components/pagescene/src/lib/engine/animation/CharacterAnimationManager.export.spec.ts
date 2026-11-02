import { describe, expect, it, vi } from "vitest";
import { AnimationClip, Bone, Group, QuaternionKeyframeTrack, Scene } from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { CharacterAnimationManager } from "./CharacterAnimationManager";

function setup() {
  const root = new Group(); root.name = "character";
  const bone = new Bone(); bone.name = "pelvis"; root.add(bone);
  root.animations = [new AnimationClip("bend", 2, [new QuaternionKeyframeTrack("pelvis.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 0.7071068, 0.7071068])])];
  const scene = new Scene(); scene.add(root);
  const timelineController = { getPlayhead: () => 0, resolveClipDuration: vi.fn(), getTimeline: () => null };
  const editor = { activeScene: { scene }, timelineController } as any;
  const lane = { id: "lane", objectUuid: root.uuid, strip: { id: "strip", sourceMediaId: "", bakedClipIndex: 0, name: "bend", startTime: 0, duration: 2, loop: false } };
  return { root, bone, scene, editor, lane };
}

describe("isolated animation export", () => {
  it("copies the captured rest pose and samples without mutating the live rig", async () => {
    const { root, bone, editor, lane } = setup();
    const live = new CharacterAnimationManager(editor); live.sync([lane]);
    live.evaluateAt(1);
    const liveRotation = bone.quaternion.z;
    const copy = clone(root); copy.uuid = root.uuid;
    expect(live.copyRestPoseTo(root.uuid, copy)).toBe(true);
    expect(copy.getObjectByName("pelvis")!.quaternion.z).toBeCloseTo(0);
    const scene = new Scene(); scene.add(copy);
    const isolated = new CharacterAnimationManager({ activeScene: { scene }, timelineController: editor.timelineController } as any);
    await isolated.prepareForExport([lane]); isolated.evaluateAt(1);
    expect(copy.getObjectByName("pelvis")!.quaternion.z).toBeCloseTo(liveRotation);
    expect(bone.quaternion.z).toBeCloseTo(liveRotation);
  });

  it("keeps repeated external clips independent during a transition", async () => {
    const { root, bone, editor, lane } = setup();
    const sharedClip = root.animations[0];
    editor.activeScene.loadRawGlb = vi.fn().mockResolvedValue({ animations: [sharedClip] });
    const first = { ...lane, strip: { ...lane.strip, bakedClipIndex: undefined, sourceMediaId: "shared", duration: 1, transitionEasing: { p1x: 0, p1y: 0, p2x: 1, p2y: 1 } } };
    const second = { ...first, id: "lane2", strip: { ...first.strip, id: "strip2", startTime: 2, transitionEasing: undefined } };
    const manager = new CharacterAnimationManager(editor);
    await manager.prepareForExport([first, second]);
    manager.evaluateAt(0.5);
    expect(bone.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 5);
    manager.evaluateAt(1.5);
    expect(bone.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 5);
    manager.evaluateAt(2.5);
    expect(bone.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 5);
  });

  it("samples repeat boundaries using the source clip duration", async () => {
    const { bone, editor, lane } = setup();
    const manager = new CharacterAnimationManager(editor);
    const boundaries = await manager.prepareForExport([{ ...lane, strip: { ...lane.strip, duration: 5, loop: true } }]);
    expect(boundaries).toEqual(expect.arrayContaining([0, 2, 4, 5]));
    manager.evaluateAt(2.5);
    expect(bone.quaternion.z).toBeCloseTo(Math.sin(Math.PI / 16), 5);
    manager.evaluateAt(2);
    expect(bone.quaternion.z).toBeCloseTo(0, 5);
  });

  it("rejects an animation track that does not bind to a bone", async () => {
    const { root, editor, lane } = setup();
    root.animations = [new AnimationClip("wrong", 1, [new QuaternionKeyframeTrack("missing.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])])];
    const manager = new CharacterAnimationManager(editor);
    await expect(manager.prepareForExport([lane])).rejects.toThrow("unsupported or unbound tracks");
  });
});
