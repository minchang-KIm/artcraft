import { PropertyBinding, type AnimationClip, type Bone, type Object3D } from "three";

/** Only direct, complete and finite bone transforms can be sampled safely. */
export function validateBoneAnimation(clip: AnimationClip, root: Object3D): boolean {
  if (!Number.isFinite(clip.duration) || clip.duration <= 0 || !clip.tracks.length) return false;
  return clip.tracks.every((track) => {
    try {
      const binding = PropertyBinding.parseTrackName(track.name);
      const node = PropertyBinding.findNode(root, binding.nodeName);
      if (!node || !(node as Bone).isBone || binding.objectName || binding.propertyIndex !== undefined ||
          !["position", "quaternion", "scale"].includes(binding.propertyName)) return false;
      const size = binding.propertyName === "quaternion" ? 4 : 3;
      if (!track.times.length || track.getValueSize() !== size || track.values.length !== track.times.length * size) return false;
      let previous = -1;
      for (const time of track.times) {
        if (!Number.isFinite(time) || time < 0 || time > clip.duration || time <= previous) return false;
        previous = time;
      }
      for (const value of track.values) if (!Number.isFinite(value)) return false;
      if (size === 4) {
        for (let i = 0; i < track.values.length; i += 4) {
          if (Math.hypot(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]) < 1e-8) return false;
        }
      }
      return true;
    } catch { return false; }
  });
}
