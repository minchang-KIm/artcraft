import { useEffect, useRef, useState } from "react";
import { Object3D, Quaternion, Vector3 } from "three";
import { getActiveEditor, IKTargetHandle, PoseModeChangedEvent, SceneResetEvent, SelectionChangedEvent, TimelinePlayheadEvent, solveTwoBoneIK } from "@storyteller/ui-pagescene";
import { suggestWebcamMappings, type MappingScope } from "./webcam-rig-mapping";
import { acquirePosePreview, hasPosePreview } from "./pose-control-lease";

const END_NAMES: Record<string, string[]> = {
  "left-arm": ["l_wrist", "mixamoriglefthand", "mixamorig:lefthand", "mixamorig_lefthand"],
  "right-arm": ["r_wrist", "mixamorigrighthand", "mixamorig:righthand", "mixamorig_righthand"],
  "left-leg": ["l_foot", "mixamorigleftfoot", "mixamorig:leftfoot", "mixamorig_leftfoot"],
  "right-leg": ["r_foot", "mixamorigrightfoot", "mixamorig:rightfoot", "mixamorig_rightfoot"],
};
type PathPart = { index: number; name: string; type: string };
type Editor = NonNullable<ReturnType<typeof getActiveEditor>>;
type PoseEntry = { path: PathPart[]; before: Quaternion; after: Quaternion };
type HandleSession = { editor: Editor; character: Object3D; upper: Object3D; middle: Object3D; end: Object3D; entries: PoseEntry[]; release: () => void; handle: IKTargetHandle; previousEnabled: boolean | undefined; previousVisible: boolean; previousFocused: boolean; limit: number; dragging: boolean };

function pathTo(root: Object3D, node: Object3D): PathPart[] {
  const path: PathPart[] = [];
  while (node !== root) {
    const parent: Object3D | null = node.parent;
    if (!parent) throw new Error("Bone is no longer in the selected character.");
    path.unshift({ index: parent.children.indexOf(node), name: node.name, type: node.type });
    node = parent;
  }
  return path;
}

function selectedCharacter(): Object3D | undefined {
  const selected = getActiveEditor()?.sceneManager?.selected_objects;
  return selected?.length === 1 && selected[0].userData.isCharacter ? selected[0] : undefined;
}

function recordPose(editor: Editor, character: Object3D, entries: PoseEntry[]): void {
  const id = character.uuid;
  const write = (key: "before" | "after") => {
    const root = editor.activeScene.scene.getObjectByProperty("uuid", id);
    const nodes = entries.map(entry => {
      let node = root;
      for (const part of entry.path) {
        node = node?.children[part.index];
        if (!node || node.name !== part.name || node.type !== part.type) throw new Error("The IK skeleton no longer matches.");
      }
      if (!node || node.type !== "Bone") throw new Error("The IK bone is unavailable.");
      return node;
    });
    nodes.forEach((node, index) => node.quaternion.copy(entries[index][key]));
  };
  if (entries.some(entry => entry.before.clone().normalize().angleTo(entry.after.clone().normalize()) > 1e-7)) editor.history.record({ label: "Apply IK target", apply: () => write("after"), revert: () => write("before") });
}

/** Two-bone target controls; no media or network access. */
export function LocalIKTools({ editorInitialized }: { editorInitialized: boolean }) {
  const [bones, setBones] = useState<Array<{ id: string; name: string }>>([]);
  const [upperId, setUpperId] = useState("");
  const [middleId, setMiddleId] = useState("");
  const [endId, setEndId] = useState("");
  const [scope, setScope] = useState<MappingScope>("left-arm");
  const [target, setTarget] = useState<[string, string, string]>(["0", "0", "0"]);
  const [limit, setLimit] = useState("180");
  const [status, setStatus] = useState("");
  const [handling, setHandling] = useState(false);
  const handleSession = useRef<HandleSession | null>(null);

  const stopHandle = (commit: boolean, updateUi = true) => {
    const current = handleSession.current;
    if (!current) return;
    handleSession.current = null;
    const { editor, character, upper, middle, end, entries } = current;
    const selected = editor.sceneManager?.selected_objects;
    const valid = editor.isLive && getActiveEditor() === editor && selected?.length === 1 && selected[0] === character && editor.activeScene.scene.getObjectByProperty("uuid", character.uuid) === character && character.getObjectByProperty("uuid", upper.uuid) === upper && character.getObjectByProperty("uuid", middle.uuid) === middle && character.getObjectByProperty("uuid", end.uuid) === end && !editor.timelineController.getTimeline()?.clipLanes.some((lane: { objectUuid: string }) => lane.objectUuid === character.uuid) && !editor.timelineController.getIsPlaying();
    let accepted = false, failure = "";
    try {
      if (commit && valid) {
        entries[0].after.copy(upper.quaternion); entries[1].after.copy(middle.quaternion);
        recordPose(editor, character, entries); accepted = true;
      } else {
        upper.quaternion.copy(entries[0].before); middle.quaternion.copy(entries[1].before);
      }
    } catch (error) {
      upper.quaternion.copy(entries[0].before); middle.quaternion.copy(entries[1].before);
      failure = error instanceof Error ? error.message : String(error);
    }
    try { current.handle.dispose(); } catch (error) { failure ||= error instanceof Error ? error.message : String(error); } finally { current.release(); }
    if (editor.gizmo.control && current.previousEnabled !== undefined) editor.gizmo.control.enabled = current.previousEnabled;
    editor.gizmo.setVisible(current.previousVisible);
    editor.focused = current.previousFocused;
    if (current.dragging) editor.mouse_controls?.onFKControlsDragging(false);
    if (updateUi) { setHandling(false); setStatus(failure || (accepted ? "IK handle applied. Save the local scene to retain the pose." : "IK handle cancelled.")); }
  };

  useEffect(() => {
    const editor = getActiveEditor();
    if (!editorInitialized || !editor) return;
    const refresh = () => {
      stopHandle(false);
      const list: Array<{ id: string; name: string }> = [];
      selectedCharacter()?.traverse((bone: Object3D) => { if (bone.type === "Bone") list.push({ id: bone.uuid, name: bone.name || "Unnamed bone" }); });
      setBones(list); setUpperId(""); setMiddleId(""); setEndId(""); setStatus("");
    };
    refresh();
    const selection = editor.bus.subscribe(SelectionChangedEvent, refresh);
    const reset = editor.bus.subscribe(SceneResetEvent, refresh);
    const timeline = editor.bus.subscribe(TimelinePlayheadEvent, () => {
      if (handleSession.current) { stopHandle(false); editor.characterAnimationManager.evaluateAt(editor.timelineController.getPlayhead()); }
    });
    const poseMode = editor.bus.subscribe(PoseModeChangedEvent, () => stopHandle(false));
    return () => { selection(); reset(); timeline(); poseMode(); stopHandle(false, false); };
  }, [editorInitialized]);

  const suggest = () => {
    const character = selectedCharacter();
    if (!character) { setStatus("Select one character."); return; }
    const proposal = suggestWebcamMappings(character, scope);
    if (proposal.mappings.length !== 2) { setStatus("No unambiguous matching chain. Select bones manually."); return; }
    const middle = character.getObjectByProperty("uuid", proposal.mappings[1].boneId);
    const ends: Object3D[] = [];
    middle?.traverse(node => { if (node.type === "Bone" && END_NAMES[scope]?.includes(node.name.toLowerCase())) ends.push(node); });
    if (ends.length !== 1) { setStatus("Could not identify a unique end bone. Select bones manually."); return; }
    setUpperId(proposal.mappings[0].boneId); setMiddleId(proposal.mappings[1].boneId); setEndId(ends[0].uuid);
    const p = ends[0].getWorldPosition(new Vector3()); setTarget([p.x.toFixed(4), p.y.toFixed(4), p.z.toFixed(4)]);
    setStatus("Chain suggested. Review the bones and choose a target.");
  };

  const readEndPosition = () => {
    const end = selectedCharacter()?.getObjectByProperty("uuid", endId);
    if (!end || end.type !== "Bone") { setStatus("Select a valid end bone."); return; }
    const p = end.getWorldPosition(new Vector3()); setTarget([p.x.toFixed(4), p.y.toFixed(4), p.z.toFixed(4)]);
    setStatus("Target set to the current end position.");
  };

  const apply = () => {
    const editor = getActiveEditor(), character = selectedCharacter();
    try {
      if (!editor || !character || editor.timelineController.getIsPlaying()) throw new Error("Select one character and pause the timeline.");
      if (hasPosePreview(editor)) throw new Error("Stop or apply the webcam preview before using IK.");
      if (editor.timelineController.getTimeline()?.clipLanes.some((lane: { objectUuid: string }) => lane.objectUuid === character.uuid)) throw new Error("Remove this character's motion clips before editing its IK pose.");
      const upper = character.getObjectByProperty("uuid", upperId), middle = character.getObjectByProperty("uuid", middleId), end = character.getObjectByProperty("uuid", endId);
      if (!upper || !middle || !end) throw new Error("Select the upper, middle, and end bones.");
      const values = target.map(value => value.trim() ? Number(value) : NaN), degrees = limit.trim() ? Number(limit) : NaN;
      if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= 10000) || !Number.isFinite(degrees) || degrees < 0 || degrees > 180) throw new Error("Enter finite target coordinates and a limit between 0 and 180 degrees.");
      const entries = [upper, middle].map(node => ({ path: pathTo(character, node), before: node.quaternion.clone(), after: new Quaternion() }));
      const result = solveTwoBoneIK(upper, middle, end, new Vector3(...values as [number, number, number]), degrees * Math.PI / 180);
      entries[0].after.copy(upper.quaternion); entries[1].after.copy(middle.quaternion);
      recordPose(editor, character, entries);
      setStatus(result.reached ? "IK target reached. Save the local scene to retain the pose." : `IK applied with remaining distance ${result.distance.toFixed(4)}. Save the local scene to retain the pose.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const startHandle = () => {
    const editor = getActiveEditor(), character = selectedCharacter();
    let release: (() => void) | undefined;
    let restoreGizmo: (() => void) | undefined;
    try {
      if (!editor || !character || !editor.isLive || editor.timelineController.getIsPlaying() || editor.getPoseMode() !== "select") throw new Error("Select one character, pause the timeline, and use selection mode.");
      if (hasPosePreview(editor)) throw new Error("Stop or apply the active pose preview first.");
      if (editor.timelineController.getTimeline()?.clipLanes.some((lane: { objectUuid: string }) => lane.objectUuid === character.uuid)) throw new Error("Remove this character's motion clips before editing its IK pose.");
      const upper = character.getObjectByProperty("uuid", upperId), middle = character.getObjectByProperty("uuid", middleId), end = character.getObjectByProperty("uuid", endId);
      const camera = editor.cameraController.camera, canvas = editor.renderer?.domElement;
      const degrees = limit.trim() ? Number(limit) : NaN;
      if (!upper || !middle || !end || !camera || !canvas || !Number.isFinite(degrees) || degrees < 0 || degrees > 180) throw new Error("Select valid bones and a rotation limit between 0 and 180 degrees.");
      const entries = [upper, middle].map(node => ({ path: pathTo(character, node), before: node.quaternion.clone(), after: new Quaternion() }));
      const initial = end.getWorldPosition(new Vector3());
      // Validate the chain without leaving even a tiny numerical change.
      solveTwoBoneIK(upper, middle, end, initial, degrees * Math.PI / 180);
      upper.quaternion.copy(entries[0].before); middle.quaternion.copy(entries[1].before);
      upper.updateWorldMatrix(true, true);
      release = acquirePosePreview(editor);
      const previousEnabled = editor.gizmo.control?.enabled, previousVisible = editor.gizmo.isVisible(), previousFocused = editor.focused;
      restoreGizmo = () => { if (editor.gizmo.control && previousEnabled !== undefined) editor.gizmo.control.enabled = previousEnabled; editor.gizmo.setVisible(previousVisible); editor.focused = previousFocused; };
      if (editor.gizmo.control) editor.gizmo.control.enabled = false;
      editor.gizmo.setVisible(false);
      const handle = new IKTargetHandle(editor.activeScene.scene, camera, canvas, initial, (point: Vector3) => {
        const current = handleSession.current;
        if (!current) return;
        try {
          if (getActiveEditor() !== editor || selectedCharacter() !== character || editor.timelineController.getIsPlaying() || character.getObjectByProperty("uuid", upper.uuid) !== upper || character.getObjectByProperty("uuid", middle.uuid) !== middle || character.getObjectByProperty("uuid", end.uuid) !== end) throw new Error("The IK target or selection changed.");
          upper.quaternion.copy(entries[0].before); middle.quaternion.copy(entries[1].before);
          upper.updateWorldMatrix(true, true);
          const result = solveTwoBoneIK(upper, middle, end, point, current.limit);
          setTarget([point.x.toFixed(4), point.y.toFixed(4), point.z.toFixed(4)]);
          setStatus(result.reached ? "IK handle preview: target reached." : `IK handle preview: remaining distance ${result.distance.toFixed(4)}.`);
        } catch (error) { stopHandle(false); setStatus(error instanceof Error ? error.message : String(error)); }
      }, (dragging: boolean) => { if (handleSession.current) handleSession.current.dragging = dragging; editor.focused = dragging ? false : previousFocused; editor.mouse_controls?.onFKControlsDragging(dragging); });
      handleSession.current = { editor, character, upper, middle, end, entries, release, handle, previousEnabled, previousVisible, previousFocused, limit: degrees * Math.PI / 180, dragging: false };
      setTarget([initial.x.toFixed(4), initial.y.toFixed(4), initial.z.toFixed(4)]);
      setHandling(true); setStatus("Drag the IK target in the viewport, then apply or cancel.");
    } catch (error) { restoreGizmo?.(); release?.(); setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const options = <><option value="">Select a bone</option>{bones.map(bone => <option key={bone.id} value={bone.id}>{bone.name} ({bone.id.slice(0, 6)})</option>)}</>;
  return <details className="max-w-72">
    <summary>Local two-bone IK (experimental)</summary>
    <p>Select a chain and enter a world-space target. Only upper and middle bone rotations are changed.</p>
    <label>Chain <select aria-label="IK chain" className="text-black" value={scope} disabled={handling} onChange={event => setScope(event.target.value as MappingScope)}><option value="left-arm">Left arm</option><option value="right-arm">Right arm</option><option value="left-leg">Left leg</option><option value="right-leg">Right leg</option></select></label>
    <button type="button" disabled={!bones.length || handling} onClick={suggest}>Suggest IK chain</button>
    <label>Upper <select aria-label="IK upper bone" className="max-w-48 text-black" value={upperId} disabled={handling} onChange={event => setUpperId(event.target.value)}>{options}</select></label>
    <label>Middle <select aria-label="IK middle bone" className="max-w-48 text-black" value={middleId} disabled={handling} onChange={event => setMiddleId(event.target.value)}>{options}</select></label>
    <label>End <select aria-label="IK end bone" className="max-w-48 text-black" value={endId} disabled={handling} onChange={event => setEndId(event.target.value)}>{options}</select></label>
    <button type="button" disabled={!endId || handling} onClick={readEndPosition}>Use current end position</button>
    {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}>Target {axis} <input aria-label={`IK target ${axis}`} type="number" step="0.01" className="w-20 text-black" value={target[index]} disabled={handling} onChange={event => { const value = event.currentTarget.value; setTarget(previous => previous.map((item, i) => i === index ? value : item) as [string, string, string]); }} /></label>)}
    <label>Joint limit (degrees) <input aria-label="IK joint limit" type="number" min="0" max="180" step="1" className="w-16 text-black" value={limit} disabled={handling} onChange={event => setLimit(event.currentTarget.value)} /></label>
    <button type="button" disabled={!upperId || !middleId || !endId || handling} onClick={apply}>Apply IK target</button>
    {!handling ? <button type="button" disabled={!upperId || !middleId || !endId} onClick={startHandle}>Start IK handle</button> : <><button type="button" onClick={() => stopHandle(true)}>Apply IK handle</button><button type="button" onClick={() => stopHandle(false)}>Cancel IK handle</button></>}
    {status && <p role="status">{status}</p>}
  </details>;
}
