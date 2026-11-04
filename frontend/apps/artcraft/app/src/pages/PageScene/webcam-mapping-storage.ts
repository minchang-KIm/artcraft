import { Object3D } from "three";

type Part = { index: number; name: string; type: string };
type Mapping = { boneId: string; segment: number };

/** Store stable skeleton paths rather than transient Three.js UUIDs. */
export function encodeWebcamMappings(character: Object3D, mappings: Mapping[], segmentCount: number) {
  if (!mappings.length || mappings.length > segmentCount || new Set(mappings.map(m => m.boneId)).size !== mappings.length || new Set(mappings.map(m => m.segment)).size !== mappings.length) throw new Error("Choose a different bone and limb for each mapping.");
  return { schemaVersion: 1, mappings: mappings.map(({ boneId, segment }) => {
    const bone = character.getObjectByProperty("uuid", boneId);
    if (!bone || bone.type !== "Bone" || !Number.isInteger(segment) || segment < 0 || segment >= segmentCount) throw new Error("A selected bone or limb is unavailable.");
    const path: Part[] = [];
    let node: Object3D = bone;
    while (node !== character) {
      const parent: Object3D | null = node.parent;
      if (!parent) throw new Error("A selected bone is outside the character.");
      path.unshift({ index: parent.children.indexOf(node), name: node.name, type: node.type });
      node = parent;
      if (path.length > 256) throw new Error("The bone path is too deep.");
    }
    if (!path.length) throw new Error("The selected bone is not inside the character.");
    return { path, segment };
  }) };
}

/** Reject the whole mapping if a path or segment no longer matches. */
export function decodeWebcamMappings(character: Object3D, value: unknown, segmentCount: number): Mapping[] {
  if (!value || typeof value !== "object") throw new Error("Invalid saved bone mappings.");
  const saved = value as { schemaVersion?: unknown; mappings?: unknown };
  if (saved.schemaVersion !== 1 || !Array.isArray(saved.mappings) || !saved.mappings.length || saved.mappings.length > segmentCount) throw new Error("Invalid saved bone mappings.");
  const mappings: Mapping[] = saved.mappings.map(entry => {
    if (!entry || typeof entry !== "object" || !Number.isInteger(entry.segment) || entry.segment < 0 || entry.segment >= segmentCount || !Array.isArray(entry.path) || !entry.path.length || entry.path.length > 256) throw new Error("Invalid saved bone mappings.");
    let node: Object3D | undefined = character;
    for (const part of entry.path) {
      if (!part || typeof part !== "object" || !Number.isSafeInteger(part.index) || part.index < 0 || typeof part.name !== "string" || typeof part.type !== "string") throw new Error("Invalid saved bone mappings.");
      node = node?.children[part.index];
      if (!node || node.name !== part.name || node.type !== part.type) throw new Error("Saved bone mappings do not match this skeleton.");
    }
    if (!node || node.type !== "Bone") throw new Error("Saved bone mappings do not match this skeleton.");
    return { boneId: node.uuid, segment: entry.segment };
  });
  if (new Set(mappings.map(m => m.boneId)).size !== mappings.length || new Set(mappings.map(m => m.segment)).size !== mappings.length) throw new Error("Invalid saved bone mappings.");
  return mappings;
}
