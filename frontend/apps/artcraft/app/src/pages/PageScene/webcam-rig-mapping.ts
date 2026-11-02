import { Object3D } from "three";

export type MappingScope = "all" | "upper-body" | "full-body" | "left-arm" | "right-arm" | "left-leg" | "right-leg";
export type SuggestedMapping = { boneId: string; segment: number };

// Exact semantic aliases for the pinned MHR rig and Mixamo's standard names.
// In particular, never match procedural twist bones by substring.
const CHAINS: ReadonlyArray<{ scope: Exclude<MappingScope, "all" | "upper-body" | "full-body">; segments: [number, number]; names: [string[], string[]] }> = [
  { scope: "left-arm", segments: [0, 1], names: [["l_uparm", "mixamorigleftarm", "mixamorig:leftarm", "mixamorig_leftarm"], ["l_lowarm", "mixamorigleftforearm", "mixamorig:leftforearm", "mixamorig_leftforearm"]] },
  { scope: "right-arm", segments: [2, 3], names: [["r_uparm", "mixamorigrightarm", "mixamorig:rightarm", "mixamorig_rightarm"], ["r_lowarm", "mixamorigrightforearm", "mixamorig:rightforearm", "mixamorig_rightforearm"]] },
  { scope: "left-leg", segments: [4, 5], names: [["l_upleg", "mixamorigleftupleg", "mixamorig:leftupleg", "mixamorig_leftupleg"], ["l_lowleg", "mixamorigleftleg", "mixamorig:leftleg", "mixamorig_leftleg"]] },
  { scope: "right-leg", segments: [6, 7], names: [["r_upleg", "mixamorigrightupleg", "mixamorig:rightupleg", "mixamorig_rightupleg"], ["r_lowleg", "mixamorigrightleg", "mixamorig:rightleg", "mixamorig_rightleg"]] },
];

/** Suggest complete, unambiguous chains only; no user pose is modified. */
export function suggestWebcamMappings(character: Object3D, scope: MappingScope): { mappings: SuggestedMapping[]; unavailable: string[] } {
  if (!CHAINS.some(chain => chain.scope === scope) && !["all", "upper-body", "full-body"].includes(scope)) throw new Error("Unknown mapping scope.");
  const byName = new Map<string, Object3D[]>();
  character.traverse(node => {
    if (node.type !== "Bone") return;
    const key = node.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), node]);
  });
  const mappings: SuggestedMapping[] = [];
  const unavailable: string[] = [];
  for (const chain of CHAINS.filter(item => scope === "all" || scope === "full-body" || (scope === "upper-body" && item.scope.endsWith("-arm")) || item.scope === scope)) {
    const matches = chain.names.map(names => names.flatMap(name => byName.get(name) ?? []));
    if (matches.some(nodes => nodes.length !== 1)) { unavailable.push(chain.scope); continue; }
    const [upper, lower] = matches.map(nodes => nodes[0]);
    let ancestor = lower.parent;
    while (ancestor && ancestor !== upper) ancestor = ancestor.parent;
    if (ancestor !== upper) { unavailable.push(chain.scope); continue; }
    mappings.push({ boneId: upper.uuid, segment: chain.segments[0] }, { boneId: lower.uuid, segment: chain.segments[1] });
  }
  if (scope === "upper-body" || scope === "full-body") {
    const torso = ["c_spine0", "mixamorigspine", "mixamorig:spine", "mixamorig_spine"].flatMap(name => byName.get(name) ?? []);
    const arms = [0, 2].map(segment => mappings.find(item => item.segment === segment));
    const ancestors = arms.map(item => item && character.getObjectByProperty("uuid", item.boneId));
    const torsoIsAncestor = (node?: Object3D) => {
      for (let parent = node?.parent; parent; parent = parent.parent) if (parent === torso[0]) return true;
      return false;
    };
    if (torso.length !== 1 || !ancestors.every(node => torsoIsAncestor(node))) unavailable.push("torso");
    else mappings.unshift({ boneId: torso[0].uuid, segment: 8 });
  }
  return { mappings, unavailable };
}
