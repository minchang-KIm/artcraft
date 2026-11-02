import { describe, expect, it } from "vitest";
import { Bone, BoxGeometry, Group, MeshBasicMaterial, Skeleton, SkinnedMesh } from "three";
import { exportPosedCharacter } from "./exportPosedCharacter";

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
});
