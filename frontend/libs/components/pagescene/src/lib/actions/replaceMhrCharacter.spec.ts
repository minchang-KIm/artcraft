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
});
