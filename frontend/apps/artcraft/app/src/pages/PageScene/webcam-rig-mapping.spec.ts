import { describe, expect, it } from "vitest";
import { Bone, Group } from "three";
import { suggestWebcamMappings } from "./webcam-rig-mapping";

function chain(root: Group, upperName: string, lowerName: string) {
  const upper = new Bone(), lower = new Bone(); upper.name = upperName; lower.name = lowerName; root.add(upper); upper.add(lower); return [upper, lower];
}

describe("webcam rig mapping suggestions", () => {
  it("maps complete MHR and Mixamo chains without matching twist bones", () => {
    const root = new Group();
    const [upper, lower] = chain(root, "l_uparm", "l_lowarm");
    chain(root, "mixamorigRightUpLeg", "mixamorigRightLeg");
    const twist = new Bone(); twist.name = "l_uparm_twist0_proc"; upper.add(twist);
    const result = suggestWebcamMappings(root, "all");
    expect(result.mappings.map(item => item.segment)).toEqual([0, 1, 6, 7]);
    expect(result.mappings.slice(0, 2).map(item => item.boneId)).toEqual([upper.uuid, lower.uuid]);
    expect(result.unavailable).toEqual(["right-arm", "left-leg"]);
  });
  it("does not suggest ambiguous, partial, or incorrectly related chains", () => {
    const duplicate = new Group(); chain(duplicate, "l_uparm", "l_lowarm"); chain(duplicate, "l_uparm", "l_lowarm");
    expect(suggestWebcamMappings(duplicate, "left-arm").mappings).toEqual([]);
    const unrelated = new Group(); const upper = new Bone(), lower = new Bone(); upper.name = "l_uparm"; lower.name = "l_lowarm"; unrelated.add(upper, lower);
    expect(suggestWebcamMappings(unrelated, "left-arm").unavailable).toEqual(["left-arm"]);
    const partial = new Group(); partial.add(upper);
    expect(suggestWebcamMappings(partial, "left-arm").mappings).toEqual([]);
  });
});
