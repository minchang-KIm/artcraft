import { describe, expect, it, vi } from "vitest";
import { Bone, Group, Scene } from "three";
import { mhrCharacterFingerprint, replaceMhrCharacter } from "./replaceMhrCharacter";

function character(media: string) {
  const root = new Group(); root.name = "MHR";
  root.userData = { media_id: media, isCharacter: true };
  const bone = new Bone(); bone.name = "pelvis"; root.add(bone);
  return root;
}

describe("MHR shape replacement", () => {
  it("does not apply a delayed result after the selection changes", async () => {
    const scene = new Scene(); const original = character("local-glb:old"); scene.add(original);
    const candidate = character("local-glb:new");
    let finish: (value: Group) => void = () => {};
    const pending = new Promise<Group>((resolve) => { finish = resolve; });
    const disposeObject = vi.fn();
    const manager = { selected_objects: [original], select_object: vi.fn() };
    const editor = { activeScene: { scene, loadObject: () => pending, disposeObject }, sceneManager: manager } as any;
    const operation = replaceMhrCharacter(editor, original.uuid, "local-glb:old", "local-glb:new", mhrCharacterFingerprint(original));
    manager.selected_objects = [];
    finish(candidate);
    await expect(operation).rejects.toThrow("selected character changed");
    expect(scene.getObjectByProperty("uuid", original.uuid)).toBe(original);
    expect(disposeObject).toHaveBeenCalledWith(candidate);
  });
  it("records distinct provenance changes even when the GLB hash is unchanged", async () => {
    const scene = new Scene(), original = character("local-glb:same"); scene.add(original);
    original.userData.totalRecallMhr = { assetId: "local-glb:same", provenance: { target: 175 } };
    let action: { apply(): Promise<void>; revert(): Promise<void> } | undefined;
    const editor = { activeScene: { scene }, sceneManager: { selected_objects: [original] }, history: { record: (value: typeof action) => { action = value; } } } as any;
    await replaceMhrCharacter(editor, original.uuid, "local-glb:same", "local-glb:same", mhrCharacterFingerprint(original), { target: 176 });
    expect(original.userData.totalRecallMhr.provenance.target).toBe(176);
    await action!.revert(); expect(original.userData.totalRecallMhr.provenance.target).toBe(175);
    await action!.apply(); expect(original.userData.totalRecallMhr.provenance.target).toBe(176);
  });
  it("restores each asset's provenance across shape replacement undo and redo", async () => {
    const scene = new Scene(), original = character("local-glb:old"); scene.add(original);
    original.userData.totalRecallMhr = { assetId: "local-glb:old", provenance: { target: 175 } };
    let action: { apply(): Promise<void>; revert(): Promise<void> } | undefined;
    const manager = { selected_objects: [original] as Group[], select_object: (id: string) => { manager.selected_objects = [scene.getObjectByProperty("uuid", id) as Group]; } };
    const editor = { activeScene: { scene, loadObject: async (id: string) => character(id), disposeObject() {} }, sceneManager: manager,
      mouse_controls: { clearFKVisuals() {}, removeTransformControls() {} }, bus: { emit() {} }, selection: { refreshOutliner() {} },
      history: { record: (value: typeof action) => { action = value; } } } as any;
    const id = original.uuid;
    await replaceMhrCharacter(editor, id, "local-glb:old", "local-glb:new", mhrCharacterFingerprint(original), { target: 180 });
    const current = () => scene.getObjectByProperty("uuid", id)!;
    expect(current().userData.totalRecallMhr).toEqual({ assetId: "local-glb:new", provenance: { target: 180 } });
    await action!.revert(); expect(current().userData.totalRecallMhr).toEqual({ assetId: "local-glb:old", provenance: { target: 175 } });
    await action!.apply(); expect(current().userData.totalRecallMhr).toEqual({ assetId: "local-glb:new", provenance: { target: 180 } });
  });
});
