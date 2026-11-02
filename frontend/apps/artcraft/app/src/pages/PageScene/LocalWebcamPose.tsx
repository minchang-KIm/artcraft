import { useEffect, useRef, useState } from "react";
import { Object3D, Quaternion, Vector3 } from "three";
import { invoke } from "@tauri-apps/api/core";
import { getActiveEditor, LandmarkBoneRetarget, SceneResetEvent, SelectionChangedEvent, TimelinePlayheadEvent, usePageSceneStore, validateBoneAnimation, type PoseLandmark, type TrackingState } from "@storyteller/ui-pagescene";
import { encodeWebcamMotion, WebcamMotionRecorder } from "./webcam-motion";
import { suggestWebcamMappings, type MappingScope } from "./webcam-rig-mapping";
import { WEBCAM_SEGMENTS as SEGMENTS, webcamSegmentPoints } from "./webcam-landmarks";
import workerUrl from "../../../../../../../../../workers/pose/landmarker-worker.mjs?url";
import visionUrl from "@mediapipe/tasks-vision?url";
import wasmLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

const MODEL_HASHES = new Set([
  "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
  "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1",
  "64437af838a65d18e5ba7a0d39b465540069bc8aae8308de3e318aad31fcbc7b",
]);
type Editor = NonNullable<ReturnType<typeof getActiveEditor>>;
type BoundBone = { bone: Object3D; parent: Object3D; before: Quaternion; retarget: LandmarkBoneRetarget; segment: number };
type Preview = { editor: Editor; character: Object3D; bindings: BoundBone[]; lossMode: "hold" | "fade" };
type Session = { worker: Worker; stream: MediaStream | null; stopped: boolean; frameId: number; nextId: number; busy: boolean; points: PoseLandmark[] | null; preview: Preview | null; recorder: WebcamMotionRecorder | null; cancelInit?: () => void };
const absolute = (url: string) => new URL(url, window.location.href).href;

function parentRotation(parent: Object3D): Quaternion {
  parent.updateWorldMatrix(true, false);
  const scale = parent.getWorldScale(new Vector3());
  const magnitude = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  const basis = [0, 1, 2].map(index => new Vector3().setFromMatrixColumn(parent.matrixWorld, index).normalize());
  const shear = Math.max(Math.abs(basis[0].dot(basis[1])), Math.abs(basis[1].dot(basis[2])), Math.abs(basis[0].dot(basis[2])));
  if (magnitude < 1e-8 || Math.min(scale.x, scale.y, scale.z) <= 0 || Math.max(Math.abs(scale.x - scale.y), Math.abs(scale.y - scale.z), Math.abs(scale.x - scale.z)) > magnitude * 1e-4 || parent.matrixWorld.determinant() <= 0 || shear > 1e-4) {
    throw new Error("The selected bone requires a positive uniform parent scale.");
  }
  return parent.getWorldQuaternion(new Quaternion());
}

function bonePath(character: Object3D, bone: Object3D): Array<{ index: number; name: string; type: string }> {
  const path: Array<{ index: number; name: string; type: string }> = [];
  let node = bone;
  while (node !== character) {
    const parent: Object3D | null = node.parent;
    if (!parent) throw new Error("The bone is no longer in the character.");
    path.unshift({ index: parent.children.indexOf(node), name: node.name, type: node.type });
    node = parent;
  }
  return path;
}

/** The model and camera frames remain on this device. */
export function LocalWebcamPose({ editorInitialized }: { editorInitialized: boolean }) {
  const [model, setModel] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState("");
  const [bones, setBones] = useState<Array<{ id: string; name: string }>>([]);
  const [boneId, setBoneId] = useState("");
  const [segment, setSegment] = useState(0);
  const [mappings, setMappings] = useState<Array<{ boneId: string; segment: number }>>([]);
  const [mappingScope, setMappingScope] = useState<MappingScope>("all");
  const [mirror, setMirror] = useState(false);
  const [lossMode, setLossMode] = useState<"hold" | "fade">("hold");
  const [tracking, setTracking] = useState<TrackingState | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const session = useRef<Session | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  const stop = (restore = true) => {
    generation.current++;
    const current = session.current;
    session.current = null;
    if (current) {
      current.stopped = true;
      current.cancelInit?.();
      cancelAnimationFrame(current.frameId);
      if (restore && current.preview) current.preview.bindings.forEach(binding => binding.bone.quaternion.copy(binding.before));
      current.worker.terminate();
      current.stream?.getTracks().forEach(track => track.stop());
    }
    if (video.current) video.current.srcObject = null;
    if (mounted.current) { setRunning(false); setStarting(false); setCalibrated(false); setRecording(false); setTracking(null); }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, []);

  useEffect(() => {
    const editor = getActiveEditor();
    if (!editorInitialized || !editor) return;
    const refresh = () => {
      stop();
      const selected = editor.sceneManager?.selected_objects;
      const character = selected?.length === 1 && selected[0].userData.isCharacter ? selected[0] : undefined;
      const next: Array<{ id: string; name: string }> = [];
      character?.traverse((item: Object3D) => { if (item.type === "Bone") next.push({ id: item.uuid, name: item.name || "Unnamed bone" }); });
      setBones(next);
      setBoneId(next[0]?.id ?? "");
      setMappings([]);
    };
    refresh();
    const unselect = editor.bus.subscribe(SelectionChangedEvent, refresh);
    const reset = editor.bus.subscribe(SceneResetEvent, refresh);
    const timeline = editor.bus.subscribe(TimelinePlayheadEvent, () => {
      if (session.current?.preview) {
        stop();
        // Seeking evaluates clips before emitting this event. Re-evaluate after
        // cancelling the preview so it cannot overwrite the requested pose.
        editor.characterAnimationManager.evaluateAt(editor.timelineController.getPlayhead());
        setStatus("Timeline changed; preview cancelled.");
      }
    });
    return () => { unselect(); reset(); timeline(); stop(); };
  }, [editorInitialized]);

  const start = async () => {
    if (!model || starting || running || saving) return;
    const token = ++generation.current;
    setStarting(true);
    setStatus("Checking local model…");
    let current: Session | null = null;
    try {
      if (!model.name.toLowerCase().endsWith(".task") || model.size < 1 || model.size > 50 * 1024 * 1024) throw new Error("Select a MediaPipe pose .task file up to 50 MiB.");
      const buffer = await model.arrayBuffer();
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), b => b.toString(16).padStart(2, "0")).join("");
      if (!MODEL_HASHES.has(digest)) throw new Error("The model does not match a supported pinned MediaPipe pose model.");
      if (generation.current !== token) return;
      const worker = new Worker(absolute(import.meta.env.DEV ? "/__total_recall_pose_worker.js" : workerUrl));
      current = { worker, stream: null, stopped: false, frameId: 0, nextId: 1, busy: false, points: null, preview: null, recorder: null };
      session.current = current;
      const active = current;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { clearTimeout(timer); active.cancelInit = undefined; error ? reject(error) : resolve(); };
        const timer = window.setTimeout(() => finish(new Error("Pose model initialization timed out.")), 60000);
        active.cancelInit = () => finish(new Error("Pose initialization cancelled."));
        worker.onmessage = ({ data }) => { if (data.id === 1) finish(data.type === "ready" ? undefined : new Error(data.message || "Pose model initialization failed.")); };
        worker.onerror = event => finish(new Error(event.message || "Pose worker failed."));
        try { worker.postMessage({ id: 1, type: "init", moduleUrl: absolute(visionUrl), wasmLoaderUrl: absolute(wasmLoaderUrl), wasmBinaryUrl: absolute(wasmBinaryUrl), modelBuffer: buffer }, [buffer]); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      if (generation.current !== token || active.stopped) return;
      setStatus("Requesting camera access…");
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      if (generation.current !== token || active.stopped) { stream.getTracks().forEach(track => track.stop()); return; }
      active.stream = stream;
      stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => { if (!active.stopped) { stop(); setStatus("Camera stopped; preview cancelled."); } }, { once: true }));
      if (!video.current) throw new Error("Camera preview is unavailable.");
      video.current.srcObject = stream;
      await video.current.play();
      if (generation.current !== token || active.stopped) return;
      worker.onmessage = ({ data }) => {
        if (active.stopped) return;
        if (data.type === "error") { setStatus(`Pose error: ${data.message}`); stop(); return; }
        if (data.type !== "pose") return;
        active.busy = false;
        active.points = data.worldLandmarks?.[0] ?? null;
        const preview = active.preview;
        if (!preview) return;
        try {
          const selected = preview.editor.sceneManager?.selected_objects;
          if (getActiveEditor() !== preview.editor || selected?.length !== 1 || selected[0] !== preview.character || preview.editor.activeScene.scene.getObjectByProperty("uuid", preview.character.uuid) !== preview.character || preview.bindings.some(binding => preview.character.getObjectByProperty("uuid", binding.bone.uuid) !== binding.bone || binding.bone.parent !== binding.parent) || preview.editor.timelineController.getIsPlaying()) throw new Error("Scene selection or playback changed; preview stopped.");
          for (const binding of preview.bindings) {
            const [a, b] = webcamSegmentPoints(active.points, binding.segment);
            binding.bone.quaternion.copy(binding.retarget.update(a as PoseLandmark, b as PoseLandmark, parentRotation(binding.parent), 0.35, Math.PI / 2, { timestampMs: data.timestampMs, mode: preview.lossMode }));
          }
          const states = preview.bindings.map(binding => binding.retarget.getTrackingState());
          setTracking(states.includes("fading") ? "fading" : states.includes("holding") ? "holding" : states.includes("lost") ? "lost" : "tracking");
          if (active.recorder?.sample(performance.now(), preview.bindings.map(binding => binding.bone.quaternion))) void finishRecording();
        } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); stop(); }
      };
      worker.onerror = event => { if (!active.stopped) { setStatus(event.message || "Pose worker failed."); stop(); } };
      const frame = () => {
        if (active.stopped) return;
        active.frameId = requestAnimationFrame(frame);
        if (active.busy || !video.current || video.current.readyState < 2) return;
        active.busy = true;
        void createImageBitmap(video.current).then(bitmap => {
          if (active.stopped) { bitmap.close(); return; }
          worker.postMessage({ id: ++active.nextId, type: "frame", frame: bitmap, timestampMs: performance.now() }, [bitmap]);
        }).catch(error => { if (!active.stopped) { setStatus(`Camera frame error: ${String(error)}`); stop(); } });
      };
      active.frameId = requestAnimationFrame(frame);
      setRunning(true);
      setStarting(false);
      setStatus("Camera running locally. Select a limb and calibrate.");
    } catch (error) {
      if (generation.current === token) { stop(); setStatus(error instanceof Error ? error.message : String(error)); }
      else if (current && !current.stopped) { current.worker.terminate(); current.stream?.getTracks().forEach(track => track.stop()); }
    }
  };

  const calibrate = () => {
    try {
      const current = session.current;
      const editor = getActiveEditor();
      const selected = editor?.sceneManager?.selected_objects;
      if (!current || !editor || selected?.length !== 1 || !selected[0].userData.isCharacter || editor.timelineController.getIsPlaying()) throw new Error("Select one character and pause the timeline.");
      if (current.recorder) throw new Error("Finish or cancel the recording before recalibrating.");
      const character = selected[0];
      const camera = editor.cameraController.camera;
      if (!camera) throw new Error("The stage camera is unavailable.");
      if (current.preview) current.preview.bindings.forEach(binding => binding.bone.quaternion.copy(binding.before));
      current.preview = null;
      setCalibrated(false);
      setTracking(null);
      const selections = [{ boneId, segment }, ...mappings];
      if (new Set(selections.map(item => item.boneId)).size !== selections.length || new Set(selections.map(item => item.segment)).size !== selections.length) throw new Error("Choose a different bone and limb for each mapping.");
      const cameraRotation = camera.getWorldQuaternion(new Quaternion());
      const bindings = selections.map(item => {
        const bone = character.getObjectByProperty("uuid", item.boneId);
        if (!bone || bone.type !== "Bone" || !bone.parent || !SEGMENTS[item.segment]) throw new Error("Select a valid bone and limb.");
        const before = bone.quaternion.clone();
        const [a, b] = webcamSegmentPoints(current.points, item.segment);
        return { bone, parent: bone.parent, before, segment: item.segment, retarget: new LandmarkBoneRetarget(a as PoseLandmark, b as PoseLandmark, cameraRotation, parentRotation(bone.parent), before, mirror) };
      });
      bindings.sort((a, b) => bonePath(character, a.bone).length - bonePath(character, b.bone).length);
      current.preview = { editor, character, bindings, lossMode };
      setCalibrated(true);
      setTracking("tracking");
      setStatus("Calibrated. Move the selected limb, then apply or cancel.");
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
  };

  const suggestMappings = () => {
    const selected = getActiveEditor()?.sceneManager?.selected_objects;
    if (selected?.length !== 1 || !selected[0].userData.isCharacter) { setStatus("Select one character in the scene."); return; }
    const result = suggestWebcamMappings(selected[0], mappingScope);
    if (!result.mappings.length) { setStatus(`No complete, unambiguous limb chains found (${result.unavailable.join(", ")}). Choose mappings manually.`); return; }
    const [first, ...rest] = result.mappings;
    setBoneId(first.boneId); setSegment(first.segment); setMappings(rest);
    setStatus(`Suggested ${result.mappings.length} bone mappings. Check each mapping before calibration.${result.unavailable.length ? ` Unavailable: ${result.unavailable.join(", ")}.` : ""}`);
  };

  const apply = () => {
    const preview = session.current?.preview;
    if (!preview) return;
    const selected = preview.editor.sceneManager?.selected_objects;
    if (getActiveEditor() !== preview.editor || selected?.length !== 1 || selected[0] !== preview.character || preview.editor.activeScene.scene.getObjectByProperty("uuid", preview.character.uuid) !== preview.character || preview.bindings.some(binding => preview.character.getObjectByProperty("uuid", binding.bone.uuid) !== binding.bone || binding.bone.parent !== binding.parent) || preview.editor.timelineController.getIsPlaying()) {
      stop();
      setStatus("Scene selection or playback changed; preview cancelled.");
      return;
    }
    const { editor, character, bindings } = preview;
    const characterId = character.uuid;
    const items = bindings.map(binding => ({ path: bonePath(character, binding.bone), before: binding.before.clone(), after: binding.bone.quaternion.clone() }));
    const write = (key: "before" | "after") => {
      const root = editor.activeScene.scene.getObjectByProperty("uuid", characterId);
      const targets = items.map(item => {
        let target = root;
        for (const part of item.path) {
          target = target?.children[part.index];
          if (!target || target.name !== part.name || target.type !== part.type) throw new Error("The character skeleton no longer matches the webcam pose.");
        }
        if (!target || target.type !== "Bone") throw new Error("The webcam pose target is unavailable.");
        return target;
      });
      targets.forEach((target, index) => target.quaternion.copy(items[index][key]));
    };
    editor.history.record({ label: "Apply webcam bone pose", apply: () => write("after"), revert: () => write("before") });
    stop(false);
    setStatus("Pose applied. Save the local scene to retain it.");
  };

  const beginRecording = () => {
    const current = session.current;
    if (!current?.preview || current.recorder) return;
    const timeline = current.preview.editor.timelineController.getTimeline();
    if (!timeline || !Number.isFinite(timeline.duration) || timeline.duration < 0.1) { setStatus("A timeline of at least 0.1 seconds is required."); return; }
    const limit = Math.min(30, timeline.duration);
    current.recorder = new WebcamMotionRecorder(performance.now(), current.preview.bindings.map(binding => binding.bone.quaternion), limit);
    setRecording(true);
    setStatus(`Recording selected bone locally, up to ${limit} seconds.`);
  };

  const finishRecording = async () => {
    const current = session.current;
    const preview = current?.preview;
    const recorder = current?.recorder;
    if (!preview || !recorder) return;
    const { editor, character, bindings } = preview;
    const playhead = editor.timelineController.getPlayhead();
    stop();
    const token = generation.current;
    setSaving(true);
    setStatus("Saving recorded motion…");
    const checkTarget = () => {
      const selected = editor.sceneManager?.selected_objects;
      if (generation.current !== token || getActiveEditor() !== editor || selected?.length !== 1 || selected[0] !== character || editor.activeScene.scene.getObjectByProperty("uuid", character.uuid) !== character || bindings.some(binding => character.getObjectByProperty("uuid", binding.bone.uuid) !== binding.bone || binding.bone.parent !== binding.parent) || editor.timelineController.getIsPlaying()) throw new Error("Scene selection changed; recorded motion was not added.");
    };
    try {
      const { data, duration } = await encodeWebcamMotion(character, bindings.map(binding => binding.bone), recorder);
      checkTarget();
      const timeline = editor.timelineController.getTimeline();
      if (!timeline || duration > timeline.duration) throw new Error("The recording is longer than the timeline.");
      const id = await invoke<string>("total_recall_asset_put", { content: Array.from(new Uint8Array(data)) });
      const clip = (await editor.activeScene.loadRawGlb(id))?.animations?.[0];
      checkTarget();
      if (!clip || !validateBoneAnimation(clip, character)) throw new Error("The recorded motion does not bind to the selected skeleton.");
      const lane = editor.timelineController.recordEdit("Add webcam motion", () => editor.timelineController.addClipLane(character.uuid, {
        sourceMediaId: id, name: "Webcam motion", startTime: playhead, duration, loop: false, autoDuration: false,
      }));
      if (!lane) throw new Error("There is no room for this motion on the character timeline.");
      usePageSceneStore.getState().setTimelineRevealObjectUuid(character.uuid);
      usePageSceneStore.getState().setTimelineExpanded(true);
      setStatus("Webcam motion added to the timeline. Save the local scene to retain it.");
    } catch (error) { if (mounted.current) setStatus(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setSaving(false); }
  };

  return <details className="max-w-72">
    <summary>Local webcam pose (experimental)</summary>
    <p>Camera frames stay on this device. Map each chosen bone to a different body segment.</p>
    <label>Pose model <input aria-label="Pose model" type="file" accept=".task" disabled={running || starting} onChange={event => setModel(event.currentTarget.files?.[0] ?? null)} /></label>
    <label>Mapping scope <select aria-label="Webcam mapping scope" className="text-black" value={mappingScope} disabled={calibrated} onChange={event => setMappingScope(event.target.value as MappingScope)}><option value="all">All limbs</option><option value="upper-body">Upper body</option><option value="full-body">Full body</option><option value="left-arm">Left arm</option><option value="right-arm">Right arm</option><option value="left-leg">Left leg</option><option value="right-leg">Right leg</option></select></label>
    <button type="button" disabled={calibrated || saving || !bones.length} onClick={suggestMappings}>Suggest bone mappings</button>
    <label>Bone <select aria-label="Webcam bone" className="max-w-48 text-black" value={boneId} disabled={calibrated} onChange={event => setBoneId(event.target.value)}>{bones.map(bone => <option key={bone.id} value={bone.id}>{bone.name} ({bone.id.slice(0, 6)})</option>)}</select></label>
    <label>Limb <select aria-label="Webcam limb" className="text-black" value={segment} disabled={calibrated} onChange={event => setSegment(Number(event.target.value))}>{SEGMENTS.map(([name], index) => <option key={name} value={index}>{name}</option>)}</select></label>
    {mappings.map((mapping, index) => <div key={index}>
      <label>Bone {index + 2} <select aria-label={`Additional webcam bone ${index + 1}`} className="max-w-48 text-black" value={mapping.boneId} disabled={calibrated} onChange={event => setMappings(previous => previous.map((item, i) => i === index ? { ...item, boneId: event.target.value } : item))}>{bones.map(bone => <option key={bone.id} value={bone.id}>{bone.name} ({bone.id.slice(0, 6)})</option>)}</select></label>
      <label>Limb {index + 2} <select aria-label={`Additional webcam limb ${index + 1}`} className="text-black" value={mapping.segment} disabled={calibrated} onChange={event => setMappings(previous => previous.map((item, i) => i === index ? { ...item, segment: Number(event.target.value) } : item))}>{SEGMENTS.map(([name], i) => <option key={name} value={i}>{name}</option>)}</select></label>
      <button type="button" disabled={calibrated} onClick={() => setMappings(previous => previous.filter((_, i) => i !== index))}>Remove mapping {index + 2}</button>
    </div>)}
    <button type="button" disabled={calibrated || mappings.length + 1 >= Math.min(bones.length, SEGMENTS.length)} onClick={() => {
      const usedBones = new Set([boneId, ...mappings.map(item => item.boneId)]);
      const usedSegments = new Set([segment, ...mappings.map(item => item.segment)]);
      const nextBone = bones.find(bone => !usedBones.has(bone.id));
      const nextSegment = SEGMENTS.findIndex((_, index) => !usedSegments.has(index));
      if (nextBone && nextSegment >= 0) setMappings(previous => [...previous, { boneId: nextBone.id, segment: nextSegment }]);
    }}>Add bone mapping</button>
    <label><input type="checkbox" checked={mirror} disabled={calibrated} onChange={event => setMirror(event.target.checked)} /> Mirror motion</label>
    <label>When tracking is lost <select aria-label="When tracking is lost" className="text-black" value={lossMode} disabled={calibrated} onChange={event => setLossMode(event.target.value as "hold" | "fade")}><option value="hold">Hold last pose</option><option value="fade">Return to calibrated pose</option></select></label>
    <video ref={video} muted playsInline aria-label="Local camera preview" className="max-w-48" />
    {!running && !starting ? <button type="button" disabled={!model || !boneId || saving} onClick={() => void start()}>Start local camera</button> : <button type="button" onClick={() => { stop(); setStatus("Camera stopped; preview cancelled."); }}>Stop camera</button>}
    <button type="button" disabled={!running || !boneId || recording} onClick={calibrate}>Calibrate selected bone</button>
    <button type="button" disabled={!calibrated || recording} onClick={apply}>Apply webcam pose</button>
    {!recording ? <button type="button" disabled={!calibrated || saving} onClick={beginRecording}>Record webcam motion</button> : <button type="button" onClick={() => void finishRecording()}>Finish webcam recording</button>}
    {tracking && <p aria-live="polite">{tracking === "tracking" ? "Tracking pose" : tracking === "holding" ? "Tracking lost: holding pose" : tracking === "fading" ? "Tracking lost: returning to calibration" : "Tracking lost: calibrated pose"}</p>}
    {status && <p role="status">{status}</p>}
  </details>;
}
