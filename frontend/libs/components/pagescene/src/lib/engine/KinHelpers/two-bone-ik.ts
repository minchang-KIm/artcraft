import { Object3D, Quaternion, Vector3 } from "three";

const EPS = 1e-7;
const finiteVector = (value: Vector3) => [value.x, value.y, value.z].every(Number.isFinite);

function hasAncestor(node: Object3D, ancestor: Object3D): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

function requireUniformTransform(node: Object3D): void {
  node.updateWorldMatrix(true, false);
  const matrix = node.matrixWorld;
  const axes = [0, 1, 2].map(index => new Vector3().setFromMatrixColumn(matrix, index));
  const lengths = axes.map(axis => axis.length());
  const max = Math.max(...lengths), min = Math.min(...lengths);
  if (!Number.isFinite(max) || min < EPS || max - min > max * 1e-4 || matrix.determinant() <= 0) throw new Error("IK requires positive uniform scale.");
  axes.forEach(axis => axis.normalize());
  if (Math.max(Math.abs(axes[0].dot(axes[1])), Math.abs(axes[1].dot(axes[2])), Math.abs(axes[0].dot(axes[2]))) > 1e-4) throw new Error("IK does not support sheared transforms.");
}

function rotateToward(bone: Object3D, from: Vector3, to: Vector3, limit: number): void {
  if (!bone.parent || from.lengthSq() < EPS * EPS || to.lengthSq() < EPS * EPS) throw new Error("IK chain has a degenerate direction.");
  const delta = new Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
  if (angle > limit) { const full = delta.clone(); delta.identity().slerp(full, limit / angle); }
  const world = bone.getWorldQuaternion(new Quaternion());
  const parent = bone.parent.getWorldQuaternion(new Quaternion());
  bone.quaternion.copy(parent.invert().multiply(delta).multiply(world).normalize());
  bone.updateWorldMatrix(true, true);
}

/** Move an end bone using only the two specified ancestor rotations. */
export function solveTwoBoneIK(upper: Object3D, middle: Object3D, end: Object3D, target: Vector3, maxRotation = Math.PI): { reached: boolean; distance: number } {
  if ([upper, middle, end].some(node => node.type !== "Bone") || !upper.parent || !hasAncestor(middle, upper) || !hasAncestor(end, middle) || !finiteVector(target) || !Number.isFinite(maxRotation) || maxRotation < 0 || maxRotation > Math.PI) throw new Error("Invalid IK chain or target.");
  for (const node of [upper.parent, upper, middle, end]) requireUniformTransform(node);
  const beforeUpper = upper.quaternion.clone(), beforeMiddle = middle.quaternion.clone();
  try {
    const root = upper.getWorldPosition(new Vector3());
    const joint = middle.getWorldPosition(new Vector3());
    const tip = end.getWorldPosition(new Vector3());
    const first = joint.clone().sub(root), second = tip.clone().sub(joint);
    const firstLength = first.length(), secondLength = second.length();
    if (firstLength < EPS || secondLength < EPS || ![firstLength, secondLength].every(Number.isFinite)) throw new Error("IK chain has a zero-length segment.");
    const desired = target.clone().sub(root);
    const requestedDistance = desired.length();
    const axis = requestedDistance > EPS ? desired.multiplyScalar(1 / requestedDistance) : tip.clone().sub(root).normalize();
    if (axis.lengthSq() < EPS * EPS) axis.copy(first).normalize();
    const minDistance = Math.abs(firstLength - secondLength) + EPS;
    const maxDistance = firstLength + secondLength - EPS;
    if (minDistance > maxDistance) throw new Error("IK chain segments are too short.");
    const distance = Math.max(minDistance, Math.min(maxDistance, requestedDistance));
    let pole = first.clone().addScaledVector(axis, -first.dot(axis));
    if (pole.lengthSq() < EPS * EPS) {
      const fallback = Math.abs(axis.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      pole = fallback.addScaledVector(axis, -fallback.dot(axis));
    }
    pole.normalize();
    const along = (firstLength * firstLength + distance * distance - secondLength * secondLength) / (2 * distance);
    const height = Math.sqrt(Math.max(0, firstLength * firstLength - along * along));
    const jointTarget = root.clone().addScaledVector(axis, along).addScaledVector(pole, height);
    const tipTarget = root.clone().addScaledVector(axis, distance);
    rotateToward(upper, first, jointTarget.sub(root), maxRotation);
    const nextJoint = middle.getWorldPosition(new Vector3()), nextTip = end.getWorldPosition(new Vector3());
    rotateToward(middle, nextTip.sub(nextJoint), tipTarget.sub(nextJoint), maxRotation);
    const remaining = end.getWorldPosition(new Vector3()).distanceTo(target);
    if (!Number.isFinite(remaining)) throw new Error("IK produced an invalid pose.");
    return { reached: remaining <= Math.max(1e-5, (firstLength + secondLength) * 1e-4), distance: remaining };
  } catch (error) {
    upper.quaternion.copy(beforeUpper); middle.quaternion.copy(beforeMiddle); upper.updateWorldMatrix(true, true);
    throw error;
  }
}
