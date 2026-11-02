import * as THREE from "three";
import type Editor from "../engine/editor";
import { BoneJSONHelper } from "../engine/KinHelpers/BoneJSONHelper";
import { ObjectAddedEvent, ObjectRemovedEvent } from "../engine/events/EngineEvent";
import type { UndoableAction } from "../engine/editor/HistoryManager";

/** Snapshot only the target so unrelated scene edits do not block a result. */
export function mhrCharacterFingerprint(object: THREE.Object3D): string {
  return JSON.stringify({ id: object.uuid, media: object.userData.media_id, position: object.position.toArray(),
    quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), pose: new BoneJSONHelper(object).toJSON() });
}

async function swap(editor: Editor, uuid: string, from: string, to: string, expected?: string): Promise<void> {
  const scene = editor.activeScene;
  const previous = scene.scene.getObjectByProperty("uuid", uuid);
  if (!previous || previous.parent !== scene.scene || previous.userData.media_id !== from || !previous.userData.isCharacter) {
    throw new Error("The selected character changed before the result was applied.");
  }
  const fingerprint = mhrCharacterFingerprint(previous);
  if (expected && (fingerprint !== expected || editor.sceneManager?.selected_objects?.[0] !== previous)) throw new Error("The selected character changed before the result was applied.");
  const pose = new BoneJSONHelper(previous).toJSON();
  const next = await scene.loadObject(to, previous.name, false, previous.position.clone(), 2);
  try {
    next.userData.isCharacter = true;
    if (!pose || !new BoneJSONHelper(next).poseFromBoneJSON(pose, { rotationsOnly: true })) {
      throw new Error("The generated skeleton is incompatible with the selected character.");
    }
    if (editor.activeScene !== scene || scene.scene.getObjectByProperty("uuid", uuid) !== previous || mhrCharacterFingerprint(previous) !== fingerprint || (expected && editor.sceneManager?.selected_objects?.[0] !== previous)) {
      throw new Error("The selected character changed before the result was applied.");
    }
    next.uuid = uuid;
    next.name = previous.name;
    next.position.copy(previous.position);
    next.quaternion.copy(previous.quaternion);
    next.scale.copy(previous.scale);
    next.visible = previous.visible;
    next.userData = { ...previous.userData, media_id: to, isCharacter: true };
    editor.mouse_controls.clearFKVisuals();
    editor.mouse_controls.removeTransformControls(true);
    scene.scene.remove(previous);
    scene.disposeObject(previous);
    scene.scene.add(next);
    editor.bus.emit(new ObjectRemovedEvent(uuid));
    editor.bus.emit(new ObjectAddedEvent({ id: uuid, kind: "character", name: next.name, mediaId: to }));
    editor.sceneManager?.select_object(uuid);
    editor.selection.refreshOutliner();
  } catch (error) {
    if (!next.parent) scene.disposeObject(next);
    throw error;
  }
}

class ReplaceMhrAction implements UndoableAction {
  readonly label = "Change MHR shape";
  constructor(private editor: Editor, private uuid: string, private before: string, private after: string) {}
  async apply() { await swap(this.editor, this.uuid, this.before, this.after); }
  async revert() { await swap(this.editor, this.uuid, this.after, this.before); }
}

/** Replace a generated MHR character while retaining its ID, placement and bone rotations. */
export async function replaceMhrCharacter(editor: Editor, uuid: string, before: string, after: string, fingerprint: string): Promise<void> {
  if (before === after) return;
  await swap(editor, uuid, before, after, fingerprint);
  editor.history.record(new ReplaceMhrAction(editor, uuid, before, after));
}
