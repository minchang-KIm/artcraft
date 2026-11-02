import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SceneAudioClip, SequenceAudioClip } from "../../../../../../../../../contracts/scene-audio";
import type { RecoveryReference } from "../../../../../../../../../contracts/recovery-reference";
import { wavDuration } from "./wav-duration";
import { SceneAudioPreview } from "./scene-audio-preview";
import { LocalWorkerSettings } from "~/pages/LocalWorkerSettings";
import { LocalRecovery } from "~/pages/LocalRecovery";
import { useTabStore } from "~/pages/Stores/TabState";
import { addCharacter, AssetType, getActiveEditor, usePageSceneStore, SceneResetEvent, TimelinePlayheadEvent, getSceneGenerationMetaData, mhrCharacterFingerprint, replaceMhrCharacter, exportPosedCharacter, addClipToCharacter, validateBoneAnimation } from "@storyteller/ui-pagescene";

type SceneDocument = { id: string; revision: number; kind: "scene"; name: string; updatedAt: number; data: unknown; generatedAssets?: Record<string, unknown>; mhrIdentityDraft?: number[]; sceneAudio?: SceneAudioClip[]; recoveredFrom?: RecoveryReference };
const MAX_BYTES = 50 * 1024 * 1024;
const IDENTITY_COUNT = 45;
const neutralIdentity = () => Array<string>(IDENTITY_COUNT).fill("0");
const validIdentity = (value: unknown): value is number[] => Array.isArray(value) && value.length === IDENTITY_COUNT && value.every((v) => typeof v === "number" && Number.isFinite(v) && v >= -3 && v <= 3);

async function validateSceneAssets(scene: SceneDocument): Promise<SceneAudioClip[]> {
  const snapshot = scene.data as { scene?: Array<{ media_file_token?: string }>; timeline?: { clipLanes?: Array<{ strip?: { sourceMediaId?: string } }> } };
  if (!Array.isArray(snapshot?.scene)) throw new Error("The local scene data is invalid.");
  const localAssets = new Set(snapshot.scene.map(object => object.media_file_token).filter((token): token is string => typeof token === "string" && token.startsWith("local-glb:")));
  for (const lane of snapshot.timeline?.clipLanes ?? []) {
    const id = lane.strip?.sourceMediaId;
    if (typeof id === "string" && id.startsWith("local-glb:")) localAssets.add(id);
  }
  const audio = scene.sceneAudio ?? [];
  if (!Array.isArray(audio) || audio.length > 1000 || audio.some(clip => !clip || typeof clip.id !== "string" || typeof clip.name !== "string" || !/^local-media:audio~wav:[0-9a-f]{64}$/.test(clip.mediaId) || !Number.isFinite(clip.start) || clip.start < 0 || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.start + clip.duration > 86400)) throw new Error("Invalid saved scene audio.");
  await Promise.all([...localAssets].map(id => invoke<number[]>("total_recall_asset_get", { id })));
  await Promise.all(audio.map(async clip => { const [mime, content] = await invoke<[string, number[]]>("total_recall_media_get", { id: clip.mediaId }); if (mime !== "audio/wav" || Math.abs(wavDuration(Uint8Array.from(content)) - clip.duration) > 1e-6) throw new Error("Saved scene audio is invalid."); }));
  return audio;
}

/** Local asset and scene commands; no user media leaves the device. */
export function LocalSceneTools() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sequenceJob, setSequenceJob] = useState<string | null>(null);
  const [sequenceCancelling, setSequenceCancelling] = useState(false);
  const captureJob = useRef<{ id: string; cancelled: boolean; acceptingCancel: boolean } | null>(null);
  const [identityDraft, setIdentityDraft] = useState<string[]>(neutralIdentity);
  const [identityIndex, setIdentityIndex] = useState(0);
  const [includeTimeline, setIncludeTimeline] = useState(false);
  const [captureStart, setCaptureStart] = useState("");
  const [captureEnd, setCaptureEnd] = useState("");
  const [captureResolution, setCaptureResolution] = useState("native");
  const [audioStart, setAudioStart] = useState("0");
  const [sceneAudio, setSceneAudio] = useState<SceneAudioClip[]>([]);
  const [audioPreviewEnabled, setAudioPreviewEnabled] = useState(false);
  const audioPreview = useRef<SceneAudioPreview | null>(null);
  const [sceneName, setSceneName] = useState("Local 3D scene");
  const [scenes, setScenes] = useState<SceneDocument[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const busyRef = useRef(false);
  const sceneEpoch = useRef(0);
  const editorInitialized = usePageSceneStore(state => state.is3DEditorInitialized);
  const current = useRef<{ id: string; revision: number } | undefined>(undefined);
  const generatedAssets = useRef<Record<string, unknown>>({});
  const recoveredFrom = useRef<RecoveryReference | undefined>(undefined);
  const run = async (work: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try { setMessage(await work()); }
    catch (error) { setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { busyRef.current = false; setBusy(false); }
  };
  useEffect(() => {
    const editor = getActiveEditor();
    if (!editorInitialized || !editor) return;
    return editor.bus.subscribe(SceneResetEvent, () => {
      sceneEpoch.current += 1;
      audioPreview.current?.setClips([]);
      current.current = undefined;
      generatedAssets.current = {};
      recoveredFrom.current = undefined;
      setSceneAudio([]);
      setIdentityDraft(neutralIdentity());
      setIdentityIndex(0);
    });
  }, [editorInitialized]);
  useEffect(() => {
    const editor = getActiveEditor();
    if (!editorInitialized || !editor) return;
    const preview = new SceneAudioPreview(async id => {
      const [mime, content] = await invoke<[string, number[]]>("total_recall_media_get", { id });
      if (mime !== "audio/wav") throw new Error("Scene audio is not a WAV file.");
      const bytes = Uint8Array.from(content);
      wavDuration(bytes);
      return bytes.buffer;
    }, message => setMessage(`Error: ${message}`));
    audioPreview.current = preview;
    setAudioPreviewEnabled(false);
    preview.sync(editor.timelineController.getPlayhead(), editor.timelineController.getIsPlaying());
    const unsubscribe = editor.bus.subscribe(TimelinePlayheadEvent, (event: { playhead: number; isPlaying: boolean }) => preview.sync(event.playhead, event.isPlaying));
    return () => {
      unsubscribe();
      preview.dispose();
      if (audioPreview.current === preview) audioPreview.current = null;
    };
  }, [editorInitialized]);
  useEffect(() => { audioPreview.current?.setClips(sceneAudio); }, [sceneAudio, editorInitialized]);
  const enableAudioPreview = async () => {
    const preview = audioPreview.current;
    if (!preview) return;
    try {
      await preview.enable();
      if (audioPreview.current === preview) setAudioPreviewEnabled(true);
    } catch (error) {
      if (audioPreview.current === preview) setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  useEffect(() => () => {
    const job = captureJob.current;
    if (job?.acceptingCancel) {
      job.cancelled = true;
      void invoke("total_recall_scene_sequence_abort", { jobId: job.id }).catch(() => {});
    }
  }, []);
  const cancelSequence = async () => {
    const job = captureJob.current;
    if (!job?.acceptingCancel || job.cancelled) return;
    job.cancelled = true;
    setSequenceCancelling(true);
    setMessage("Cancelling 3D animation capture…");
    try { await invoke("total_recall_scene_sequence_abort", { jobId: job.id }); }
    catch (error) { setMessage(`Error cancelling 3D capture: ${String(error)}`); }
  };
  const add = (file?: File) => run(async () => {
    if (!file) return "No file selected.";
    if (!file.name.toLowerCase().endsWith(".glb") || file.size < 20 || file.size > MAX_BYTES) throw new Error("Select a GLB up to 50 MiB.");
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    const content = Array.from(new Uint8Array(await file.arrayBuffer()));
    const id = await invoke<string>("total_recall_asset_put", { content });
    const objectId = await addCharacter(editor, { media_id: id, name: file.name, type: AssetType.CHARACTER, version: 2 });
    if (!objectId) throw new Error("The model could not be added to the scene.");
    return "Character added. Save the local scene to retain its placement.";
  });
  const addMotion = (file?: File) => run(async () => {
    if (!file) return "No file selected.";
    if (!file.name.toLowerCase().endsWith(".glb") || file.size < 20 || file.size > MAX_BYTES) throw new Error("Select a GLB up to 50 MiB.");
    const editor = getActiveEditor();
    const selected = editor?.sceneManager?.selected_objects;
    if (!editor || !selected || selected.length !== 1 || !selected[0].userData.isCharacter) throw new Error("Select one character in the scene.");
    const character = selected[0];
    const content = Array.from(new Uint8Array(await file.arrayBuffer()));
    const id = await invoke<string>("total_recall_asset_put", { content });
    const clip = (await editor.activeScene.loadRawGlb(id))?.animations?.[0];
    if (!clip || !validateBoneAnimation(clip, character)) throw new Error("The motion contains invalid tracks or does not match the selected skeleton.");
    if (getActiveEditor() !== editor || editor.sceneManager.selected_objects.length !== 1 || editor.sceneManager.selected_objects[0] !== character ||
        editor.activeScene.scene.getObjectByProperty("uuid", character.uuid) !== character) throw new Error("The selected character changed before the motion was added.");
    editor.timelineController.create();
    const lane = addClipToCharacter(editor, character.uuid, { media_id: id, name: file.name });
    if (!lane) throw new Error("There is no room for this motion on the character timeline.");
    return "Local motion added. Save the local scene to retain it.";
  });
  const identity = identityDraft.map((value) => value.trim() ? Number(value) : NaN);
  const identityIsValid = validIdentity(identity);
  const generate = () => run(async () => {
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    if (!identityIsValid) throw new Error("Every MHR identity coefficient must be between -3 and 3.");
    setMessage("Generating a local MHR character…");
    const result = await invoke<{ assetId: string; provenance: unknown }>("total_recall_mhr_generate", { identity });
    const objectId = await addCharacter(editor, { media_id: result.assetId, name: "MHR character", type: AssetType.CHARACTER, version: 2 });
    if (!objectId) throw new Error("The generated character could not be added to the scene.");
    generatedAssets.current = { ...generatedAssets.current, [result.assetId]: result.provenance };
    return "MHR character added. Save the local scene to retain its placement.";
  });
  const applyToSelected = () => run(async () => {
    const editor = getActiveEditor();
    const selected = editor?.sceneManager?.selected_objects;
    if (!editor || !selected || selected.length !== 1) throw new Error("Select one MHR character in the scene.");
    const object = selected[0];
    const before: unknown = object.userData.media_id;
    const provenance = typeof before === "string" ? generatedAssets.current[before] : undefined;
    const originalIdentity = provenance && typeof provenance === "object" ? (provenance as { identity?: unknown }).identity : undefined;
    if (typeof before !== "string" || !validIdentity(originalIdentity)) throw new Error("The selected character has no valid MHR generation record.");
    if (!identityIsValid) throw new Error("Every MHR identity coefficient must be between -3 and 3.");
    editor.entranceAnimator.cancel(object);
    const fingerprint = mhrCharacterFingerprint(object);
    setMessage("Generating a local MHR character…");
    const result = await invoke<{ assetId: string; provenance: unknown }>("total_recall_mhr_generate", { identity });
    generatedAssets.current = { ...generatedAssets.current, [result.assetId]: result.provenance };
    if (getActiveEditor() !== editor) throw new Error("The scene changed before the result was applied.");
    await replaceMhrCharacter(editor, object.uuid, before, result.assetId, fingerprint);
    return "MHR shape applied. Save the local scene to retain the change.";
  });
  const loadSelectedIdentity = () => run(async () => {
    const selected = getActiveEditor()?.sceneManager?.selected_objects;
    if (!selected || selected.length !== 1) throw new Error("Select one MHR character in the scene.");
    const id: unknown = selected[0].userData.media_id;
    const provenance = typeof id === "string" ? generatedAssets.current[id] : undefined;
    const values = provenance && typeof provenance === "object" ? (provenance as { identity?: unknown }).identity : undefined;
    if (!validIdentity(values)) throw new Error("The selected character has no valid MHR generation record.");
    setIdentityDraft(values.map(String));
    setIdentityIndex(0);
    return "Selected MHR coefficients loaded.";
  });
  const exportSelected = () => run(async () => {
    const selected = getActiveEditor()?.sceneManager?.selected_objects;
    if (!selected || selected.length !== 1) throw new Error("Select one character in the scene.");
    setMessage("Preparing posed GLB…");
    const editor = getActiveEditor();
    if (!editor) throw new Error("3D stage is not ready.");
    const bytes = await exportPosedCharacter(selected[0], includeTimeline ? editor.timelineController.getTimeline() : undefined, editor);
    const saved = await invoke<boolean>("total_recall_export_glb", { content: Array.from(new Uint8Array(bytes)) });
    return saved ? (includeTimeline ? "GLB exported with character timeline; audio is not included." : "Posed GLB exported. Timeline animation is not included.") : "Export cancelled.";
  });
  const addSceneAudio = (file?: File) => run(async () => {
    if (!file) return "No audio selected.";
    const start = audioStart.trim() ? Number(audioStart) : NaN;
    if (!Number.isFinite(start) || start < 0 || start > 86400) throw new Error("Enter a valid non-negative audio start time.");
    if (!file.name.toLowerCase().endsWith(".wav") || file.size < 44 || file.size > MAX_BYTES) throw new Error("Select a PCM WAV up to 50 MiB.");
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    if (sceneAudio.length >= 1000) throw new Error("Scene audio limit reached.");
    const epoch = sceneEpoch.current;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const duration = wavDuration(bytes);
    if (start + duration > 86400) throw new Error("Audio extends beyond the supported timeline.");
    const mediaId = await invoke<string>("total_recall_media_put", { mime: "audio/wav", content: Array.from(bytes) });
    if (getActiveEditor() !== editor || !editor.isLive || sceneEpoch.current !== epoch) throw new Error("The 3D stage changed before audio was added.");
    setSceneAudio(previous => [...previous, { id: crypto.randomUUID(), mediaId, name: file.name, start, duration }]);
    return "Scene audio added. Save the local scene to retain it.";
  });
  const captureFrame = () => run(async () => {
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    const name = sceneName.trim();
    if (!name) throw new Error("Enter a scene name.");
    const savedScene = current.current ? { ...current.current } : null;
    const sceneData = JSON.parse(JSON.stringify(editor.save_manager.getSceneJson({ sceneGenerationMetadata: getSceneGenerationMetaData(editor) })));
    const capture = editor.snapShotOfCurrentFrame(false);
    if (!capture) throw new Error("Could not capture the 3D frame.");
    const buffer = await capture.file.arrayBuffer();
    if (buffer.byteLength < 24 || buffer.byteLength > MAX_BYTES) throw new Error("Captured frame is invalid or too large.");
    const bytes = new Uint8Array(buffer);
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error("Captured frame is not PNG.");
    const header = new DataView(buffer);
    const width = header.getUint32(16), height = header.getUint32(20);
    if (!width || !height || width > 4096 || height > 4096) throw new Error("Captured frame dimensions are invalid.");
    const mediaId = await invoke<string>("total_recall_media_put", { mime: "image/png", content: Array.from(bytes) });
    const id = `scene-frame:${crypto.randomUUID()}`;
    const capturedAtUtc = new Date().toISOString();
    await invoke("total_recall_project_create", { id, document: { id, kind: "scene-frame", name: `${name} frame`, updatedAt: Date.now(), mediaId, width, height, capturedAtUtc, sourceSceneId: savedScene?.id ?? null, sourceSceneRevision: savedScene?.revision ?? null, data: sceneData } });
    return "3D frame captured. Add it from the video editor.";
  });
  const captureSequence = () => run(async () => {
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    const name = sceneName.trim();
    const timeline = editor.timelineController.getTimeline();
    if (!name || !timeline || !Number.isInteger(timeline.fps) || timeline.fps < 1 || timeline.fps > 30 || !Number.isFinite(timeline.duration) || timeline.duration <= 0) throw new Error("A named scene and a timeline with 1–30 FPS are required.");
    const start = captureStart.trim() ? Number(captureStart) : 0;
    const end = captureEnd.trim() ? Number(captureEnd) : timeline.duration;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > timeline.duration) throw new Error("Invalid 3D capture range. Choose a start and end within the timeline.");
    const count = Math.max(1, Math.ceil((end - start) * timeline.fps - 1e-9));
    if (count > 1800) throw new Error("3D capture is limited to 1800 frames. Choose a shorter range or reduce FPS.");
    editor.characterAnimationManager.assertReadyForCapture(timeline.clipLanes);
    const timelineFingerprint = JSON.stringify(timeline);
    const epoch = sceneEpoch.current;
    const sequenceAudio: SequenceAudioClip[] = sceneAudio.flatMap(clip => {
      const overlapStart = Math.max(start, clip.start);
      const overlapEnd = Math.min(end, clip.start + clip.duration);
      return overlapEnd > overlapStart ? [{ id: clip.id, mediaId: clip.mediaId, name: clip.name, start: overlapStart - start, duration: overlapEnd - overlapStart, sourceOffset: overlapStart - clip.start, sourceDuration: clip.duration }] : [];
    });
    const savedScene = current.current ? { ...current.current } : null;
    const sceneData = JSON.parse(JSON.stringify(editor.save_manager.getSceneJson({ sceneGenerationMetadata: getSceneGenerationMetaData(editor) })));
    const initialTime = editor.timelineController.getPlayhead();
    const wasPlaying = editor.timelineController.getIsPlaying();
    const jobId = crypto.randomUUID();
    setMessage("Preparing 3D animation…");
    await invoke("total_recall_scene_sequence_begin", { jobId, fps: timeline.fps });
    const job = { id: jobId, cancelled: false, acceptingCancel: true };
    captureJob.current = job;
    setSequenceJob(jobId);
    setSequenceCancelling(false);
    editor.timelineController.pause();
    editor.stopRenderLoop();
    try {
      for (let frame = 0; frame < count; frame++) {
        if (job.cancelled) throw new Error("3D sequence cancelled");
        if (getActiveEditor() !== editor || !editor.isLive || sceneEpoch.current !== epoch || JSON.stringify(editor.timelineController.getTimeline()) !== timelineFingerprint) throw new Error("The 3D scene or timeline changed during capture.");
        editor.timelineController.seekTo(start + frame / timeline.fps);
        const capture = editor.snapShotOfCurrentFrame(false, captureResolution === "native" ? undefined : Number(captureResolution));
        if (!capture) throw new Error("Could not capture a 3D frame.");
        const content = Array.from(new Uint8Array(await capture.file.arrayBuffer()));
        await invoke("total_recall_scene_sequence_append", { jobId, content });
        if (job.cancelled) throw new Error("3D sequence cancelled");
        setMessage(`Capturing 3D animation: ${frame + 1}/${count}`);
      }
      if (getActiveEditor() !== editor || !editor.isLive || sceneEpoch.current !== epoch || JSON.stringify(editor.timelineController.getTimeline()) !== timelineFingerprint) throw new Error("The 3D scene or timeline changed during capture.");
      setMessage("Encoding 3D animation…");
      const result = await invoke<{ mediaId: string; width: number; height: number; duration: number }>("total_recall_scene_sequence_finish", { jobId });
      if (job.cancelled) throw new Error("3D sequence cancelled");
      job.acceptingCancel = false;
      setSequenceJob(null);
      const id = `scene-sequence:${crypto.randomUUID()}`;
      const capturedAtUtc = new Date().toISOString();
      await invoke("total_recall_project_create", { id, document: { id, kind: "scene-sequence", name: `${name} animation`, updatedAt: Date.now(), ...result, capturedAtUtc, sourceSceneId: savedScene?.id ?? null, sourceSceneRevision: savedScene?.revision ?? null, sourceStartSeconds: start, sourceEndSeconds: end, sourceFps: timeline.fps, frameCount: count, sequenceAudio, data: sceneData } });
      return "3D animation captured. Add it from the video editor.";
    } catch (error) {
      if (job.cancelled) return "3D animation capture cancelled.";
      throw error;
    } finally {
      job.acceptingCancel = false;
      if (captureJob.current === job) captureJob.current = null;
      setSequenceJob(null);
      setSequenceCancelling(false);
      try { await invoke("total_recall_scene_sequence_abort", { jobId }); }
      finally {
        if (editor.isLive && getActiveEditor() === editor) {
          editor.timelineController.seekTo(initialTime);
          if (wasPlaying) editor.timelineController.play();
          editor.startRenderLoop();
        }
      }
    }
  });
  const save = (copy = false) => run(async () => {
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    // The scene snapshot contains Three.js objects; serialize them using the
    // existing scene format before passing the document across Tauri IPC.
    const data = JSON.parse(JSON.stringify(editor.save_manager.getSceneJson({ sceneGenerationMetadata: getSceneGenerationMetaData(editor) })));
    const active = copy ? undefined : current.current;
    const id = active?.id ?? `scene:${crypto.randomUUID()}`;
    const name = sceneName.trim();
    if (!name) throw new Error("Enter a scene name.");
    if (!identityIsValid) throw new Error("Every MHR identity coefficient must be between -3 and 3.");
    const document = { id, kind: "scene", name, updatedAt: Date.now(), data, generatedAssets: generatedAssets.current, mhrIdentityDraft: identity, sceneAudio, ...(recoveredFrom.current ? { recoveredFrom: recoveredFrom.current } : {}) };
    const saved = active
      ? await invoke<SceneDocument>("total_recall_project_save", { id, expectedRevision: active.revision, document })
      : await invoke<SceneDocument>("total_recall_project_create", { id, document });
    current.current = { id, revision: saved.revision };
    setScenes((previous) => [saved, ...previous.filter((scene) => scene.id !== id)]);
    setSelectedSceneId(id);
    return "Local scene saved.";
  });
  const refresh = () => run(async () => {
    const all = await invoke<SceneDocument[]>("total_recall_project_list");
    const saved = all.filter((project) => project.kind === "scene").sort((a, b) => b.updatedAt - a.updatedAt);
    setScenes(saved);
    setSelectedSceneId((selected) => saved.some((scene) => scene.id === selected) ? selected : saved[0]?.id ?? "");
    return saved.length ? `${saved.length} local scene(s) found.` : "No saved local scene.";
  });
  const open = (selectedId?: string) => run(async () => {
    const editor = getActiveEditor();
    if (!editor?.sceneManager) throw new Error("3D stage is not ready.");
    const all = await invoke<SceneDocument[]>("total_recall_project_list");
    const saved = all.filter((project) => project.kind === "scene").sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = selectedId ? saved.find((scene) => scene.id === selectedId) : saved[0];
    if (!latest) return selectedId ? "The selected scene no longer exists." : "No saved local scene.";
    // Validate every local dependency before loadCache clears the current scene.
    const savedAudio = await validateSceneAssets(latest);
    const loaded = await editor.applyJson(JSON.stringify(latest.data));
    if (!loaded.applied) throw new Error("The local scene could not be loaded.");
    current.current = { id: latest.id, revision: latest.revision };
    generatedAssets.current = latest.generatedAssets ?? {};
    recoveredFrom.current = latest.recoveredFrom;
    setSceneAudio(savedAudio);
    const provenance = Object.values(generatedAssets.current);
    const legacyIdentity = provenance.length === 1 && provenance[0] && typeof provenance[0] === "object"
      ? (provenance[0] as { identity?: unknown }).identity : undefined;
    const restoredIdentity = validIdentity(latest.mhrIdentityDraft) ? latest.mhrIdentityDraft : legacyIdentity;
    setIdentityDraft(validIdentity(restoredIdentity) ? restoredIdentity.map(String) : neutralIdentity());
    setIdentityIndex(0);
    setSceneName(latest.name);
    setScenes(saved);
    setSelectedSceneId(latest.id);
    return "Local scene opened.";
  });
  return (
    <div className="absolute right-4 top-28 z-20 flex max-h-[calc(100vh-7rem)] flex-col items-end gap-2 overflow-y-auto rounded bg-ui-controls p-2 text-sm text-white">
      <LocalWorkerSettings />
      <LocalRecovery kind="scene" copy={async (value, revision) => {
        const source = value as SceneDocument;
        if (!source || source.kind !== "scene" || typeof source.id !== "string" || typeof source.name !== "string") throw new Error("Invalid scene history.");
        await validateSceneAssets(source);
        const id = `scene:${crypto.randomUUID()}`;
        const name = `${source.name.slice(0, 160)} (recovered r${revision})`;
        await invoke("total_recall_project_create", { id, document: { ...source, id, name, updatedAt: Date.now(), recoveredFrom: { schemaVersion: 1, projectId: source.id, revision } } });
      }} />
      <label className="cursor-pointer rounded px-2 py-1">Add local GLB<input aria-label="Add local GLB" type="file" accept=".glb,model/gltf-binary" className="sr-only" disabled={busy} onChange={(event) => { void add(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <label className="cursor-pointer rounded px-2 py-1">Add local motion GLB<input aria-label="Add local motion GLB" type="file" accept=".glb,model/gltf-binary" className="sr-only" disabled={busy} onChange={(event) => { void addMotion(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <label>MHR coefficient <select aria-label="MHR coefficient" className="text-black" value={identityIndex} disabled={busy} onChange={(event) => setIdentityIndex(Number(event.target.value))}>{Array.from({ length: IDENTITY_COUNT }, (_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
      <label>Coefficient value <input aria-label="MHR coefficient value" type="number" min={-3} max={3} step={0.1} className="w-16 text-black" value={identityDraft[identityIndex]} disabled={busy} onChange={(event) => { const value = event.currentTarget.value; setIdentityDraft((previous) => previous.map((item, index) => index === identityIndex ? value : item)); }} /></label>
      <button type="button" disabled={busy} onClick={() => void loadSelectedIdentity()}>Load selected MHR coefficients</button>
      <button type="button" disabled={busy} onClick={() => setIdentityDraft(neutralIdentity())}>Reset MHR coefficients</button>
      <button type="button" disabled={busy || !identityIsValid} onClick={() => void generate()}>Generate local MHR character</button>
      <button type="button" disabled={busy || !identityIsValid} onClick={() => void applyToSelected()}>Apply MHR shape to selected</button>
      <label><input type="checkbox" checked={includeTimeline} disabled={busy} onChange={(event) => setIncludeTimeline(event.target.checked)} /> Include character timeline</label>
      <button type="button" disabled={busy} onClick={() => void exportSelected()}>Export selected GLB</button>
      <label>Scene name <input aria-label="Scene name" className="text-black" maxLength={200} value={sceneName} disabled={busy} onChange={(event) => setSceneName(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void captureFrame()}>Capture frame for video</button>
      <label>Scene audio start (seconds) <input aria-label="Scene audio start" type="number" min={0} step="any" className="w-20 text-black" value={audioStart} disabled={busy} onChange={(event) => setAudioStart(event.target.value)} /></label>
      <label className="cursor-pointer rounded px-2 py-1">Add scene WAV<input aria-label="Add scene WAV" type="file" accept=".wav,audio/wav" className="sr-only" disabled={busy} onChange={(event) => { void addSceneAudio(event.target.files?.[0]); event.target.value = ""; }} /></label>
      {audioPreviewEnabled ? <button type="button" onClick={() => { audioPreview.current?.disable(); setAudioPreviewEnabled(false); }}>Disable scene audio preview</button> : <button type="button" onClick={() => void enableAudioPreview()}>Enable scene audio preview</button>}
      {sceneAudio.map(clip => <div key={clip.id} className="max-w-72">{clip.name} · {clip.start.toFixed(2)}s · {clip.duration.toFixed(2)}s <button type="button" disabled={busy} aria-label={`Remove ${clip.name}`} onClick={() => setSceneAudio(previous => previous.filter(item => item.id !== clip.id))}>Remove</button></div>)}
      <label>Capture resolution <select aria-label="3D capture resolution" className="text-black" value={captureResolution} disabled={busy} onChange={(event) => setCaptureResolution(event.target.value)}><option value="native">Native</option><option value="1280">Max 1280 px</option><option value="640">Max 640 px</option></select></label>
      <label>Capture start (seconds) <input aria-label="3D capture start" type="number" min={0} step="any" className="w-20 text-black" value={captureStart} disabled={busy} placeholder="0" onChange={(event) => setCaptureStart(event.target.value)} /></label>
      <label>Capture end (seconds) <input aria-label="3D capture end" type="number" min={0} step="any" className="w-20 text-black" value={captureEnd} disabled={busy} placeholder="End" onChange={(event) => setCaptureEnd(event.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void captureSequence()}>Capture animation for video</button>
      {sequenceJob && <button type="button" disabled={sequenceCancelling} onClick={() => void cancelSequence()}>Cancel 3D animation capture</button>}
      <button type="button" disabled={busy} onClick={() => void useTabStore.getState().setActiveTab("VIDEO_EDITOR")}>Open video editor</button>
      <button type="button" disabled={busy} onClick={() => void save()}>Save local scene</button>
      <button type="button" disabled={busy} onClick={() => void save(true)}>Save as new local scene</button>
      <button type="button" disabled={busy} onClick={() => void refresh()}>List local scenes</button>
      <label>Saved scene <select aria-label="Saved scene" className="text-black" disabled={busy || !scenes.length} value={selectedSceneId} onChange={(event) => setSelectedSceneId(event.target.value)}><option value="" disabled>Select a scene</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label>
      <button type="button" disabled={busy || !selectedSceneId} onClick={() => void open(selectedSceneId)}>Open selected local scene</button>
      <button type="button" disabled={busy} onClick={() => void open()}>Open latest local scene</button>
      {message && <p role="status" className="max-w-72">{message}</p>}
    </div>
  );
}
