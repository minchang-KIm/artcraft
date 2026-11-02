import { Object3D, Quaternion } from "three";
import { cubicBezierYForX } from "./interpolation";
import type { BonePathPart, BoneRotationTrack } from "./types";

/** Resolve only an exact hierarchy match, including intermediate nodes. */
export function resolveBonePath(root: Object3D, path: BonePathPart[]): Object3D | null {
  if (!Array.isArray(path) || !path.length) return null;
  let node: Object3D | undefined = root;
  for (const part of path) {
    if (!part || !Number.isInteger(part.index) || part.index < 0 || typeof part.name !== "string" || typeof part.type !== "string") return null;
    node = node.children[part.index];
    if (!node || node.name !== part.name || node.type !== part.type) return null;
  }
  return node.type === "Bone" ? node : null;
}

/** Sample unit quaternions along the shortest arc; reject malformed tracks. */
export function sampleBoneRotation(track: BoneRotationTrack, time: number): Quaternion | null {
  if (!Number.isFinite(time) || !Array.isArray(track.keyframes) || !track.keyframes.length) return null;
  let previous = -Infinity;
  const rotations: Quaternion[] = [];
  for (const key of track.keyframes) {
    if (!key || !Number.isFinite(key.time) || key.time < 0 || key.time <= previous ||
      !Array.isArray(key.rotation) || key.rotation.length !== 4 || !key.rotation.every(Number.isFinite) ||
      !key.easing || ![key.easing.p1x, key.easing.p1y, key.easing.p2x, key.easing.p2y].every(Number.isFinite) ||
      key.easing.p1x < 0 || key.easing.p1x > 1 || key.easing.p2x < 0 || key.easing.p2x > 1) return null;
    const rotation = new Quaternion(...key.rotation);
    if (rotation.lengthSq() < 1e-12) return null;
    rotations.push(rotation.normalize());
    previous = key.time;
  }
  const keys = track.keyframes;
  if (time <= keys[0].time) return rotations[0];
  for (let i = 1; i < keys.length; i++) {
    if (time <= keys[i].time) {
      const x = (time - keys[i - 1].time) / (keys[i].time - keys[i - 1].time);
      return rotations[i - 1].slerp(rotations[i], cubicBezierYForX(keys[i - 1].easing, x)).normalize();
    }
  }
  return rotations[rotations.length - 1];
}
