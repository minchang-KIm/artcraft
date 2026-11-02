import { AnimationClip, Euler, Object3D, Quaternion, QuaternionKeyframeTrack, Scene, SkinnedMesh, VectorKeyframeTrack } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { sampleTrackAt } from "../engine/timeline/interpolation";
import { resolveBonePath, sampleBoneRotation } from "../engine/timeline/boneRotation";
import { cloneTimeline, type TimelineData } from "../engine/timeline/types";
import type Editor from "../engine/editor";
import { CharacterAnimationManager } from "../engine/animation/CharacterAnimationManager";

/** Serialize a supported rig and, optionally, its object transform timeline. */
export async function exportPosedCharacter(character: Object3D, sourceTimeline?: TimelineData | null, editor?: Editor): Promise<ArrayBuffer> {
  const timeline = sourceTimeline ? cloneTimeline(sourceTimeline) : null;
  if (!character.userData.isCharacter) throw new Error("Select a character to export.");
  character.updateMatrixWorld(true);
  // Do not mutate the editor's live rig. glTF ignores skinned mesh node
  // transforms, so export simple mesh nodes at scene root while the skeleton
  // keeps the character's placement. Reject unsupported nesting instead of
  // silently exporting a differently placed character.
  const sourceMeshes: SkinnedMesh[] = [];
  character.traverse((object) => { if ((object as SkinnedMesh).isSkinnedMesh) sourceMeshes.push(object as SkinnedMesh); });
  if (!sourceMeshes.length) throw new Error("The selected character has no skinned mesh.");
  for (const mesh of sourceMeshes) {
    if (mesh.parent !== character || mesh.children.length || !mesh.skeleton || mesh.position.lengthSq() !== 0 ||
      mesh.quaternion.x !== 0 || mesh.quaternion.y !== 0 || mesh.quaternion.z !== 0 || mesh.quaternion.w !== 1 ||
      mesh.scale.x !== 1 || mesh.scale.y !== 1 || mesh.scale.z !== 1 ||
      mesh.skeleton.bones.some((bone) => !character.getObjectByProperty("uuid", bone.uuid))) {
      throw new Error("This rig hierarchy is not supported for posed GLB export.");
    }
  }
  const copy = clone(character);
  copy.uuid = character.uuid;
  const lanes = timeline?.clipLanes.filter((lane) => lane.objectUuid === character.uuid) ?? [];
  const boneTracks = timeline?.boneTracks?.filter((track) => track.objectUuid === character.uuid) ?? [];
  if (lanes.length && boneTracks.length) throw new Error("A character cannot export motion clips and bone keys together.");
  // Resolve against the clone before the skin meshes are reparented below.
  const keyedBones = boneTracks.map((track) => {
    const bone = resolveBonePath(copy, track.path);
    if (!bone || !sampleBoneRotation(track, 0)) throw new Error("Invalid or unbound bone rotation track.");
    return { track, bone };
  });
  if (new Set(keyedBones.map(({ bone }) => bone)).size !== keyedBones.length) throw new Error("Duplicate bone rotation tracks.");
  if (lanes.length && (!editor || !editor.characterAnimationManager.copyRestPoseTo(character.uuid, copy))) {
    throw new Error("Animation clips are not ready for export.");
  }
  const meshes: SkinnedMesh[] = [];
  copy.traverse((object) => { if ((object as SkinnedMesh).isSkinnedMesh) meshes.push(object as SkinnedMesh); });
  const scene = new Scene();
  scene.add(copy);
  for (const mesh of meshes) scene.add(mesh);
  scene.updateMatrixWorld(true);
  const animations: AnimationClip[] = [];
  if (timeline) {
    const track = timeline.tracks.find((item) => item.objectUuid === character.uuid);
    if (!track?.keyframes.length && !lanes.length && !keyedBones.length) throw new Error("The selected character has no timeline animation.");
    {
      if (!Number.isFinite(timeline.duration) || timeline.duration <= 0 || timeline.duration > 60 ||
          !Number.isFinite(timeline.fps) || timeline.fps <= 0 || timeline.fps > 120) {
        throw new Error("Timeline duration or frame rate is outside the supported export range.");
      }
      // Bake the editor's Euler + cubic-bezier interpolation at frame boundaries
      // and exact keyframes. glTF uses linear vector and quaternion interpolation.
      const times = new Set<number>([0, Math.fround(timeline.duration)]);
      for (let i = 1; i < timeline.duration * timeline.fps; i++) times.add(Math.fround(i / timeline.fps));
      let previousTime = -1;
      for (const key of track?.keyframes ?? []) {
        if (!Number.isFinite(key.time) || key.time < 0 || key.time > timeline.duration || key.time <= previousTime) throw new Error("Invalid timeline keyframe time or order.");
        previousTime = key.time;
        times.add(Math.fround(key.time));
      }
      for (const { track: boneTrack } of keyedBones) {
        for (const key of boneTrack.keyframes) {
          if (key.time > timeline.duration) throw new Error("Bone keyframe is outside the timeline.");
          times.add(Math.fround(key.time));
        }
      }
      let mixer: CharacterAnimationManager | undefined;
      if (lanes.length && editor) {
        const isolatedEditor = {
          activeScene: { scene, loadRawGlb: (id: string) => editor.activeScene.loadRawGlb(id) },
          timelineController: { getPlayhead: () => 0, resolveClipDuration: () => {} },
        } as unknown as Editor;
        mixer = new CharacterAnimationManager(isolatedEditor);
        const boundaries = await mixer.prepareForExport(lanes);
        for (const boundary of boundaries) {
          for (const time of [boundary - 0.0001, boundary, boundary + 0.0001]) {
            if (time >= 0 && time <= timeline.duration) times.add(Math.fround(time));
          }
        }
      }
      const sorted = [...times].sort((a, b) => a - b);
      const positions: number[] = [], rotations: number[] = [], scales: number[] = [];
      let previous: Quaternion | undefined;
      for (const time of track?.keyframes.length ? sorted : []) {
        const value = sampleTrackAt(track!, time);
        if (!value) throw new Error("Cannot sample the timeline.");
        const { position, rotation, scale } = value;
        const components = [position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, scale.x, scale.y, scale.z];
        if (!components.every(Number.isFinite)) throw new Error("Invalid timeline transform.");
        positions.push(position.x, position.y, position.z);
        scales.push(scale.x, scale.y, scale.z);
        const quaternion = new Quaternion().setFromEuler(new Euler(rotation.x, rotation.y, rotation.z));
        if (previous && previous.dot(quaternion) < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
        rotations.push(...quaternion.toArray()); previous = quaternion;
      }
      const tracks = track?.keyframes.length ? [
        new VectorKeyframeTrack(`${copy.uuid}.position`, sorted, positions),
        new QuaternionKeyframeTrack(`${copy.uuid}.quaternion`, sorted, rotations),
        new VectorKeyframeTrack(`${copy.uuid}.scale`, sorted, scales),
      ] : [];
      if (keyedBones.length * sorted.length > 1000000) throw new Error("Bone animation is too large to export.");
      for (const { track: boneTrack, bone } of keyedBones) {
        const values: number[] = [];
        let previous: Quaternion | undefined;
        for (const time of sorted) {
          const rotation = sampleBoneRotation(boneTrack, time);
          if (!rotation) throw new Error("Invalid bone rotation track.");
          if (previous && previous.dot(rotation) < 0) rotation.set(-rotation.x, -rotation.y, -rotation.z, -rotation.w);
          values.push(...rotation.toArray());
          previous = rotation;
        }
        tracks.push(new QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, sorted, values));
      }
      if (mixer) {
        const bones: Object3D[] = [];
        copy.traverse((node) => { if (node.type === "Bone") bones.push(node); });
        if (!bones.length || bones.length * sorted.length > 1000000) throw new Error("Bone animation is too large to export.");
        const values = bones.map(() => ({ positions: [] as number[], rotations: [] as number[], scales: [] as number[], previous: undefined as Quaternion | undefined }));
        for (const time of sorted) {
          mixer.evaluateAt(time);
          bones.forEach((bone, i) => {
            const value = values[i];
            value.positions.push(...bone.position.toArray()); value.scales.push(...bone.scale.toArray());
            const quaternion = bone.quaternion.clone();
            if (value.previous && value.previous.dot(quaternion) < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
            value.rotations.push(...quaternion.toArray()); value.previous = quaternion;
          });
        }
        bones.forEach((bone, i) => {
          tracks.push(new VectorKeyframeTrack(`${bone.uuid}.position`, sorted, values[i].positions));
          tracks.push(new QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, sorted, values[i].rotations));
          tracks.push(new VectorKeyframeTrack(`${bone.uuid}.scale`, sorted, values[i].scales));
        });
        mixer.clear();
      }
      animations.push(new AnimationClip("Character timeline", timeline.duration, tracks));
    }
  }
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true, animations });
  if (!(data instanceof ArrayBuffer) || data.byteLength > 50 * 1024 * 1024) throw new Error("Export exceeds the GLB size limit.");
  return data;
}
