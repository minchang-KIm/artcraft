import { Object3D } from "three";

export type MappingScope = "all" | "left-arm" | "right-arm" | "left-leg" | "right-leg";
export type SuggestedMapping = { boneId: string; segment: number };

// Exact semantic aliases for the pinned MHR rig and Mixamo's standard names.
// In particular, never match procedural twist bones by substring.
const CHAINS: ReadonlyArray<{ scope: Exclude<MappingScope, "all">; segments: [number, number]; names: [string[], string[]] }> = [
  { scope: "left-arm", segments: [0, 1], names: [["l_uparm", "mixamorigleftarm", "mixamorig:leftarm", "mixamorig_leftarm"], ["l_lowarm", "mixamorigleftforearm", "mixamorig:leftforearm", "mixamorig_leftforearm"]] },
  { scope: "right-arm", segments: [2, 3], names: [["r_uparm", "mixamorigrightarm", "mixamorig:rightarm", "mixamorig_rightarm"], ["r_lowarm", "mixamorigrightforearm", "mixamorig:rightforearm", "mixamorig_rightforearm"]] },
  { scope: "left-leg", segments: [4, 5], names: [["l_upleg", "mixamorigleftupleg", "mixamorig:leftupleg", "mixamorig_leftupleg"], ["l_lowleg", "mixamorigleftleg", "mixamorig:leftleg", "mixamorig_leftleg"]] },
  { scope: "right-leg", segments: [6, 7], names: [["r_upleg", "mixamorigrightupleg", "mixamorig:rightupleg", "mixamorig_rightupleg"], ["r_lowleg", "mixamorigrightleg", "mixamorig:rightleg", "mixamorig_rightleg"]] },
];

/** Suggest complete, unambiguous chains only; no user pose is modified. */
export function suggestWebcamMappings(character: Object3D, scope: MappingScope): { mappings: SuggestedMapping[]; unavailable: string[] } {
  if (!CHAINS.some(chain => chain.scope === scope) && scope !== "all") throw new Error("Unknown mapping scope.");
  const byName = new Map<string, Object3D[]>();
  character.traverse(node => {
    if (node.type !== "Bone") return;
    const key = node.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), node]);
  });
  const mappings: SuggestedMapping[] = [];
  const unavailable: string[] = [];
  for (const chain of CHAINS.filter(item => scope === "all" || item.scope === scope)) {
    const matches = chain.names.map(names => names.flatMap(name => byName.get(name) ?? []));
    if (matches.some(nodes => nodes.length !== 1)) { unavailable.push(chain.scope); continue; }
    const [upper, lower] = matches.map(nodes => nodes[0]);
    let ancestor = lower.parent;
    while (ancestor && ancestor !== upper) ancestor = ancestor.parent;
    if (ancestor !== upper) { unavailable.push(chain.scope); continue; }
    mappings.push({ boneId: upper.uuid, segment: chain.segments[0] }, { boneId: lower.uuid, segment: chain.segments[1] });
  }
  return { mappings, unavailable };
}
