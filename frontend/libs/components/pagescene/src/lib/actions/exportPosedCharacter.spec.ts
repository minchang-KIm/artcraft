import { describe, expect, it } from "vitest";
import { AnimationClip, AnimationMixer, Bone, BoxGeometry, Float32BufferAttribute, Group, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { exportPosedCharacter } from "./exportPosedCharacter";
import { CharacterAnimationManager } from "../engine/animation/CharacterAnimationManager";
import type Editor from "../engine/editor";
import { EASING_PRESETS } from "../engine/timeline/types";

describe("posed GLB export", () => {
  it("rejects an unsupported nested rig without modifying it", async () => {
    const root = new Group(); root.userData.isCharacter = true;
    const nested = new Group(); const mesh = new SkinnedMesh(new BoxGeometry(), new MeshBasicMaterial());
    nested.add(mesh); root.add(nested);
    await expect(exportPosedCharacter(root)).rejects.toThrow("rig hierarchy");
    expect(mesh.parent).toBe(nested);
  });
  it("does not silently omit bone clips or a missing object track", async () => {
    const root = new Group(); root.userData.isCharacter = true;
    const bone = new Bone(); const mesh = new SkinnedMesh(new BoxGeometry(), new MeshBasicMaterial());
    root.add(bone, mesh); mesh.bind(new Skeleton([bone]));
    const empty = { duration: 10, fps: 30, tracks: [], clipLanes: [] };
    await expect(exportPosedCharacter(root, empty)).rejects.toThrow("no timeline animation");
    const withClip = { ...empty, clipLanes: [{ id: "lane", objectUuid: root.uuid, strip: { id: "clip", sourceMediaId: "", name: "clip", startTime: 0, duration: 1, loop: false } }] };
    await expect(exportPosedCharacter(root, withClip)).rejects.toThrow("not ready for export");
  });
  it("rejects objects without a skinned mesh", async () => {
    const root = new Group(); root.userData.isCharacter = true;
    await expect(exportPosedCharacter(root)).rejects.toThrow("no skinned mesh");
  });
  it("exports keyed bone rotations alongside root motion without changing the live pose", async () => {
    const root = new Group(); root.userData.isCharacter = true; root.name = "character";
    const bone = new Bone(); bone.name = "arm";
    const geometry = new BoxGeometry();
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    root.add(bone, mesh); mesh.bind(new Skeleton([bone]));
    const easing = EASING_PRESETS.linear;
    const timeline = { duration: 2, fps: 30, clipLanes: [], tracks: [{ objectUuid: root.uuid, keyframes: [
      { id: "root", time: 0, easing, transform: { position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    ] }], boneTracks: [{ objectUuid: root.uuid, path: [{ index: 0, name: "arm", type: "Bone" }], keyframes: [
      { id: "a", time: 0, easing, rotation: [0, 0, 0, 1] as [number, number, number, number] },
      { id: "b", time: 2, easing, rotation: [0, 0, 1, 0] as [number, number, number, number] },
    ] }] };
    const bytes = await exportPosedCharacter(root, timeline);
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    const mixer = new AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).play(); mixer.setTime(1);
    const exportedBone = gltf.scene.getObjectByName("arm")!;
    expect(exportedBone.quaternion.clone().normalize().angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0, 4);
    expect(gltf.scene.getObjectByName("character")!.position.x).toBeCloseTo(3);
    expect(bone.quaternion.angleTo(new Quaternion())).toBeCloseTo(0);
    expect(root.position.x).toBe(0);
    timeline.boneTracks[0].path[0].name = "changed";
    await expect(exportPosedCharacter(root, timeline)).rejects.toThrow("unbound");
  });
  it("exports bone keys over a clip while retaining other animated bones", async () => {
    const root = new Group(); root.userData.isCharacter = true;
    const keyed = new Bone(), other = new Bone(); keyed.name = "keyed"; other.name = "other";
    const geometry = new BoxGeometry(), count = geometry.getAttribute("position").count;
    geometry.setAttribute("skinIndex", new Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
    geometry.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial()); root.add(keyed, other, mesh); mesh.bind(new Skeleton([keyed, other]));
    root.animations = [new AnimationClip("motion", 2, [
      new QuaternionKeyframeTrack("keyed.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 1, 0]),
      new QuaternionKeyframeTrack("other.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 1, 0]),
    ])];
    const scene = new Scene(); scene.add(root);
    const editor = { activeScene: { scene }, timelineController: { getPlayhead: () => 0, resolveClipDuration() {} } } as unknown as Editor;
    editor.characterAnimationManager = new CharacterAnimationManager(editor);
    const lane = { id: "lane", objectUuid: root.uuid, strip: { id: "strip", sourceMediaId: "", bakedClipIndex: 0, name: "motion", startTime: 0, duration: 2, loop: false } };
    editor.characterAnimationManager.sync([lane]);
    const timeline = { duration: 2, fps: 30, tracks: [], clipLanes: [lane], boneTracks: [{ objectUuid: root.uuid, path: [{ index: 0, name: "keyed", type: "Bone" }], keyframes: [
      { id: "key", time: 0, easing: EASING_PRESETS.linear, rotation: [0, 0, 0, 1] as [number, number, number, number] },
    ] }] };
    const bytes = await exportPosedCharacter(root, timeline, editor);
    const gltf = await new GLTFLoader().parseAsync(bytes, "");
    const mixer = new AnimationMixer(gltf.scene); mixer.clipAction(gltf.animations[0]).play(); mixer.setTime(1);
    expect(gltf.scene.getObjectByName("keyed")!.quaternion.clone().normalize().angleTo(new Quaternion())).toBeCloseTo(0, 4);
    expect(gltf.scene.getObjectByName("other")!.quaternion.clone().normalize().angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeCloseTo(0, 4);
  });
});
