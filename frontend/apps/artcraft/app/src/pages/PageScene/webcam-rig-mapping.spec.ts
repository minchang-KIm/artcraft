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
  it("suggests a torso only when it is an unambiguous ancestor of both arms", () => {
    const root = new Group(), spine = new Bone(); spine.name = "c_spine0"; root.add(spine);
    const left = new Bone(), right = new Bone(), lf = new Bone(), rf = new Bone();
    left.name = "l_uparm"; right.name = "r_uparm"; lf.name = "l_lowarm"; rf.name = "r_lowarm";
    spine.add(left, right); left.add(lf); right.add(rf);
    const upper = suggestWebcamMappings(root, "upper-body");
    expect(upper.mappings.map(item => item.segment)).toEqual([8, 0, 1, 2, 3]);
    expect(upper.mappings[0].boneId).toBe(spine.uuid);
    root.add(right);
    expect(suggestWebcamMappings(root, "upper-body").unavailable).toContain("torso");
    spine.add(right); const duplicate = new Bone(); duplicate.name = "c_spine0"; root.add(duplicate);
    expect(suggestWebcamMappings(root, "upper-body").unavailable).toContain("torso");
  });
});
