import { useEffect, useState } from "react";
import { Object3D, Quaternion, Vector3 } from "three";
import { getActiveEditor, SceneResetEvent, SelectionChangedEvent, solveTwoBoneIK } from "@storyteller/ui-pagescene";
import { suggestWebcamMappings, type MappingScope } from "./webcam-rig-mapping";
import { hasPosePreview } from "./pose-control-lease";

const END_NAMES: Record<string, string[]> = {
  "left-arm": ["l_wrist", "mixamoriglefthand", "mixamorig:lefthand", "mixamorig_lefthand"],
  "right-arm": ["r_wrist", "mixamorigrighthand", "mixamorig:righthand", "mixamorig_righthand"],
  "left-leg": ["l_foot", "mixamorigleftfoot", "mixamorig:leftfoot", "mixamorig_leftfoot"],
  "right-leg": ["r_foot", "mixamorigrightfoot", "mixamorig:rightfoot", "mixamorig_rightfoot"],
};
type PathPart = { index: number; name: string; type: string };

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

  useEffect(() => {
    const editor = getActiveEditor();
    if (!editorInitialized || !editor) return;
    const refresh = () => {
      const list: Array<{ id: string; name: string }> = [];
      selectedCharacter()?.traverse((bone: Object3D) => { if (bone.type === "Bone") list.push({ id: bone.uuid, name: bone.name || "Unnamed bone" }); });
      setBones(list); setUpperId(""); setMiddleId(""); setEndId(""); setStatus("");
    };
    refresh();
    const selection = editor.bus.subscribe(SelectionChangedEvent, refresh);
    const reset = editor.bus.subscribe(SceneResetEvent, refresh);
    return () => { selection(); reset(); };
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
      if (editor.timelineController.getTimeline()?.clipLanes.some(lane => lane.objectUuid === character.uuid)) throw new Error("Remove this character's motion clips before editing its IK pose.");
      const upper = character.getObjectByProperty("uuid", upperId), middle = character.getObjectByProperty("uuid", middleId), end = character.getObjectByProperty("uuid", endId);
      if (!upper || !middle || !end) throw new Error("Select the upper, middle, and end bones.");
      const values = target.map(value => value.trim() ? Number(value) : NaN), degrees = limit.trim() ? Number(limit) : NaN;
      if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= 10000) || !Number.isFinite(degrees) || degrees < 0 || degrees > 180) throw new Error("Enter finite target coordinates and a limit between 0 and 180 degrees.");
      const entries = [upper, middle].map(node => ({ path: pathTo(character, node), before: node.quaternion.clone(), after: new Quaternion() }));
      const result = solveTwoBoneIK(upper, middle, end, new Vector3(...values as [number, number, number]), degrees * Math.PI / 180);
      entries[0].after.copy(upper.quaternion); entries[1].after.copy(middle.quaternion);
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
      if (entries.some(entry => entry.before.angleTo(entry.after) > 1e-7)) editor.history.record({ label: "Apply IK target", apply: () => write("after"), revert: () => write("before") });
      setStatus(result.reached ? "IK target reached. Save the local scene to retain the pose." : `IK applied with remaining distance ${result.distance.toFixed(4)}. Save the local scene to retain the pose.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const options = <><option value="">Select a bone</option>{bones.map(bone => <option key={bone.id} value={bone.id}>{bone.name} ({bone.id.slice(0, 6)})</option>)}</>;
  return <details className="max-w-72">
    <summary>Local two-bone IK (experimental)</summary>
    <p>Select a chain and enter a world-space target. Only upper and middle bone rotations are changed.</p>
    <label>Chain <select aria-label="IK chain" className="text-black" value={scope} onChange={event => setScope(event.target.value as MappingScope)}><option value="left-arm">Left arm</option><option value="right-arm">Right arm</option><option value="left-leg">Left leg</option><option value="right-leg">Right leg</option></select></label>
    <button type="button" disabled={!bones.length} onClick={suggest}>Suggest IK chain</button>
    <label>Upper <select aria-label="IK upper bone" className="max-w-48 text-black" value={upperId} onChange={event => setUpperId(event.target.value)}>{options}</select></label>
    <label>Middle <select aria-label="IK middle bone" className="max-w-48 text-black" value={middleId} onChange={event => setMiddleId(event.target.value)}>{options}</select></label>
    <label>End <select aria-label="IK end bone" className="max-w-48 text-black" value={endId} onChange={event => setEndId(event.target.value)}>{options}</select></label>
    <button type="button" disabled={!endId} onClick={readEndPosition}>Use current end position</button>
    {(["X", "Y", "Z"] as const).map((axis, index) => <label key={axis}>Target {axis} <input aria-label={`IK target ${axis}`} type="number" step="0.01" className="w-20 text-black" value={target[index]} onChange={event => { const value = event.currentTarget.value; setTarget(previous => previous.map((item, i) => i === index ? value : item) as [string, string, string]); }} /></label>)}
    <label>Joint limit (degrees) <input aria-label="IK joint limit" type="number" min="0" max="180" step="1" className="w-16 text-black" value={limit} onChange={event => setLimit(event.currentTarget.value)} /></label>
    <button type="button" disabled={!upperId || !middleId || !endId} onClick={apply}>Apply IK target</button>
    {status && <p role="status">{status}</p>}
  </details>;
}
