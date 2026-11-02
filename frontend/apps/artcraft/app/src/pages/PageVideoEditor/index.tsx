import type { SequenceAudioClip } from "../../../../../../../../../contracts/scene-audio";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  VideoEditor,
  EditorCore,
  buildDefaultScene,
  buildElementFromMedia,
  BatchCommand,
  InsertElementCommand,
  mediaTimeFromSeconds,
  mediaTimeToSeconds,
  createDefaultAdapters,
  ZERO_MEDIA_TIME,
  type ElementRef,
  type TProject,
  type VideoEditorAdapters,
} from "@storyteller/ui-video-editor";
import { tauriToastAdapter } from "./adapters/toast-adapter";
import { tauriAuthUserAdapter } from "./adapters/auth-user-adapter";
import { tauriMediaSourceAdapter } from "./adapters/media-source-adapter";
import { tauriExportSinkAdapter } from "./adapters/export-sink-adapter";
import { useTauriAssetGalleryAdapter } from "./adapters/asset-gallery-adapter";
import { invoke } from "@tauri-apps/api/core";
import { createLocalRenderSnapshot } from "./adapters/local-render-snapshot";
import { MockVoiceProvider } from "./adapters/mock-voice-provider";
import { importWebtoon } from "./adapters/import-webtoon";
import { createTotalRecallProjectStorage } from "./adapters/total-recall-project-storage";
import { LocalWorkerSettings } from "~/pages/LocalWorkerSettings";

// Tauri host for the @storyteller/ui-video-editor lib.
//
// Bootstraps an in-memory project (the IndexedDB project-storage default
// still persists across WebView restarts; a Tauri-specific filesystem-
// backed adapter is a future option but not needed yet) and wires
// every adapter through Tauri-native infra: addToast signal,
// authentication.userInfo signal, MediaUploadApi / MediaFilesApi,
// promptDownloadLocationIfNeeded for save-as.
//
// Mounted inside MainApp's tab switch — see MainApp.tsx case
// "VIDEO_EDITOR".

function buildBootstrapProject({ id }: { id: string }): TProject {
  const scene = buildDefaultScene({ name: "Main scene", isMain: true });
  const now = new Date();
  return {
    metadata: {
      id,
      name: "Untitled project",
      duration: ZERO_MEDIA_TIME,
      createdAt: now,
      updatedAt: now,
    },
    scenes: [scene],
    currentSceneId: scene.id,
    settings: {
      fps: { numerator: 30, denominator: 1 } as never,
      canvasSize: { width: 1920, height: 1080 },
      background: { type: "color", color: "#000000" },
    },
    version: 1,
  };
}

type SceneFrame = { id: string; kind: "scene-frame" | "scene-sequence"; duration?: number; sequenceAudio?: SequenceAudioClip[]; sourceStartSeconds?: number; sourceEndSeconds?: number; sourceFps?: number; frameCount?: number; name: string; updatedAt: number; mediaId: string; width: number; height: number; capturedAtUtc: string; sourceSceneId: string | null; sourceSceneRevision: number | null };

type ImportedLinkInfo = {
  kind: "voice" | "dialogue";
  sceneId: string | null;
  characterId: string | null;
  sourceText: string | null;
  links: Array<{ ref: ElementRef; startTime: ReturnType<typeof mediaTimeFromSeconds>; hidden: boolean }>;
};

export function PageVideoEditor() {
  const [ready, setReady] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [importing, setImporting] = useState(false);
  const [mockDialogue, setMockDialogue] = useState("");
  const [sceneFrames, setSceneFrames] = useState<SceneFrame[]>([]);
  const [selectedFrame, setSelectedFrame] = useState("");
  const [importedLink, setImportedLink] = useState<ImportedLinkInfo | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const renderCancelled = useRef(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const initialization = useRef<Promise<void> | null>(null);

  const storage = useMemo(() => {
    const legacy = createDefaultAdapters().projectStorage;
    return createTotalRecallProjectStorage(invoke, legacy);
  }, []);

  const { adapter: assetGalleryAdapter, modal: galleryModal } =
    useTauriAssetGalleryAdapter();

  const adapters = useMemo<Partial<VideoEditorAdapters>>(
    () => ({
      toast: tauriToastAdapter,
      authUser: tauriAuthUserAdapter,
      mediaSource: tauriMediaSourceAdapter,
      assetGallery: assetGalleryAdapter,
      exportSink: tauriExportSinkAdapter,
      projectStorage: storage.adapter,
    }),
    [assetGalleryAdapter, storage],
  );

  // Stable transient id so StrictMode + adapter ref churn don't
  // reset the project on every effect re-run.
  const transientIdRef = useRef<string>(`local-${crypto.randomUUID()}`);
  const resolvedProjectId = transientIdRef.current;

  useEffect(() => {
    let active = true;
    if (!initialization.current) {
      initialization.current = (async () => {
        // Copy first; never delete or overwrite the old IndexedDB records.
        await storage.migrateLegacy();
        EditorCore.initialize({ adapters: { ...createDefaultAdapters(), ...adapters } });
        const editor = EditorCore.getInstance();
        if (editor.project.getActive()) return;
        const projects = await storage.adapter.listProjects();
        const loaded = projects.length ? await editor.project.openProject({ id: projects[0].id }) : null;
        if (projects.length && !loaded) throw new Error("The last project could not be opened.");
        if (!loaded) {
          const project = buildBootstrapProject({ id: resolvedProjectId });
          editor.project.setActiveProject({ project });
          editor.scenes.initializeScenes({ scenes: project.scenes, currentSceneId: project.currentSceneId });
        }
      })();
    }
    initialization.current.then(() => {
      if (active) setReady(true);
    }).catch((error: unknown) => {
      if (active) {
        setStorageError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => { active = false; };
  }, [resolvedProjectId, adapters, storage]);

  useEffect(() => {
    if (!ready) return;
    const editor = EditorCore.getInstance();
    const refresh = () => {
      const selected = editor.selection.getSelectedElements();
      const scene = editor.scenes.getActiveSceneOrNull();
      if (selected.length !== 1 || !scene) { setImportedLink(null); return; }
      const ref = selected[0];
      const voice = scene.tracks.audio.find(track => track.id === ref.trackId)?.elements.find(element => element.id === ref.elementId);
      if (voice?.legacyVoice) {
        const data = voice.legacyVoice;
        const links: ImportedLinkInfo["links"] = [];
        for (const track of scene.tracks.overlay) if (track.type === "text") for (const element of track.elements) {
          if (element.id === data.dialogueElementId && element.legacyDialogue) links.push({ ref: { trackId: track.id, elementId: element.id }, startTime: element.startTime, hidden: track.hidden || !!element.hidden });
        }
        setImportedLink({ kind: "voice", sceneId: data.sceneId, characterId: data.characterId, sourceText: data.sourceText, links });
        return;
      }
      const track = scene.tracks.overlay.find(track => track.id === ref.trackId);
      const dialogue = track?.type === "text" ? track.elements.find(element => element.id === ref.elementId) : undefined;
      if (!dialogue?.legacyDialogue) { setImportedLink(null); return; }
      const links: ImportedLinkInfo["links"] = [];
      for (const audio of scene.tracks.audio) for (const element of audio.elements) {
        if (element.legacyVoice?.dialogueElementId === dialogue.id) links.push({ ref: { trackId: audio.id, elementId: element.id }, startTime: element.startTime, hidden: false });
      }
      setImportedLink({ kind: "dialogue", sceneId: dialogue.legacyDialogue.sceneId, characterId: dialogue.legacyDialogue.characterId, sourceText: typeof dialogue.params.content === "string" ? dialogue.params.content : null, links });
    };
    const unsubscribeSelection = editor.selection.subscribe(refresh);
    const unsubscribeScenes = editor.scenes.subscribe(refresh);
    refresh();
    return () => { unsubscribeSelection(); unsubscribeScenes(); };
  }, [ready]);

  useEffect(() => {
    if (!renderJobId) return;
    let active = true;
    const poll = async () => {
      try {
        const progress = await invoke<number | null>("total_recall_render_progress", { jobId: renderJobId });
        if (active && progress !== null) setRenderProgress(progress);
      } catch { /* The render result reports failures; polling may race cleanup. */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 500);
    return () => { active = false; window.clearInterval(timer); };
  }, [renderJobId]);

  const openImportedWebtoon = async (value: unknown) => {
    const editor = EditorCore.getInstance();
    await editor.project.saveCurrentProject();
    const id = await importWebtoon(value, storage.adapter, tauriMediaSourceAdapter);
    if (!await editor.project.openProject({ id })) throw new Error("Imported project could not be opened.");
    setImportStatus("Webtoon timeline imported. Original project remains unchanged.");
  };

  const importOriginalProject = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const content = await invoke<string | null>("total_recall_prepare_webtoon");
      if (content === null) { setImportStatus("Webtoon import cancelled."); return; }
      await openImportedWebtoon(JSON.parse(content));
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const importProject = async (file?: File) => {
    if (!file || importing) return;
    setImporting(true);
    try {
      if (file.size > 150 * 1024 * 1024) throw new Error("Import file exceeds 150 MiB.");
      const value: unknown = JSON.parse(await file.text());
      await openImportedWebtoon(value);
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const listSceneFrames = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const all = await invoke<SceneFrame[]>("total_recall_project_list");
      const validRange = (frame: SceneFrame) => {
        const parts = [frame.sourceStartSeconds, frame.sourceEndSeconds, frame.sourceFps, frame.frameCount];
        if (parts.every(value => value === undefined)) return true;
        const [start, end, fps, count] = parts;
        return typeof start === "number" && Number.isFinite(start) && start >= 0 && typeof end === "number" && Number.isFinite(end) && end > start && typeof fps === "number" && Number.isInteger(fps) && fps >= 1 && fps <= 30 && typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 1800 && typeof frame.duration === "number" && Math.abs(frame.duration - count / fps) < 1e-6 && Math.abs(count - Math.max(1, Math.ceil((end - start) * fps - 1e-9))) < 1e-6;
      };
      const validAudio = (frame: SceneFrame) => frame.sequenceAudio === undefined || (Array.isArray(frame.sequenceAudio) && frame.sequenceAudio.length <= 1000 && frame.sequenceAudio.every(clip => clip && typeof clip.id === "string" && typeof clip.name === "string" && /^local-media:audio~wav:[0-9a-f]{64}$/.test(clip.mediaId) && Number.isFinite(clip.start) && clip.start >= 0 && Number.isFinite(clip.duration) && clip.duration > 0 && Number.isFinite(clip.sourceOffset) && clip.sourceOffset >= 0 && Number.isFinite(clip.sourceDuration) && clip.sourceDuration > 0 && clip.sourceOffset + clip.duration <= clip.sourceDuration + 1e-6 && typeof frame.duration === "number" && clip.start + clip.duration <= frame.duration + 1e-6));
      const frames = all.filter((frame) => (frame.kind === "scene-frame" || frame.kind === "scene-sequence") && typeof frame.id === "string" && typeof frame.name === "string" && (frame.kind === "scene-frame" ? /^local-media:image~png:[0-9a-f]{64}$/.test(frame.mediaId) : /^local-media:video~mp4:[0-9a-f]{64}$/.test(frame.mediaId) && typeof frame.duration === "number" && Number.isFinite(frame.duration) && frame.duration > 0 && frame.duration <= 300 && validRange(frame) && validAudio(frame)) && Number.isInteger(frame.width) && Number.isInteger(frame.height) && frame.width > 0 && frame.width <= 4096 && frame.height > 0 && frame.height <= 4096 && typeof frame.capturedAtUtc === "string" && Number.isFinite(Date.parse(frame.capturedAtUtc)) && (frame.sourceSceneId === null || typeof frame.sourceSceneId === "string") && (frame.sourceSceneRevision === null || Number.isSafeInteger(frame.sourceSceneRevision) && frame.sourceSceneRevision >= 0)).sort((a, b) => b.updatedAt - a.updatedAt);
      setSceneFrames(frames);
      setSelectedFrame((id) => frames.some(frame => frame.id === id) ? id : frames[0]?.id ?? "");
      setImportStatus(frames.length ? `${frames.length} local 3D frame(s) found.` : "No local 3D frames.");
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const addSceneFrame = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const frame = sceneFrames.find(item => item.id === selectedFrame);
      if (!frame) throw new Error("Select a local 3D frame.");
      const editor = EditorCore.getInstance();
      const project = editor.project.getActive();
      if (!project) throw new Error("No active project.");
      const sceneId = editor.scenes.getActiveScene().id;
      const startTime = editor.playback.getCurrentTime();
      const resolved = await editor.adapters.mediaSource.resolveMedia({ id: frame.mediaId, kind: frame.kind === "scene-frame" ? "image" : "video" });
      let mediaOwnsUrl = false;
      const audioResources: Array<{ clip: SequenceAudioClip; file: File; resolved: Awaited<ReturnType<typeof editor.adapters.mediaSource.resolveMedia>>; retained: boolean }> = [];
      try {
        const response = await fetch(resolved.url);
        if (!response.ok) throw new Error("Could not read the local 3D frame.");
        const blob = await response.blob();
        const isVideo = frame.kind === "scene-sequence";
        const mime = isVideo ? "video/mp4" : "image/png";
        if (blob.type !== mime || blob.size === 0 || blob.size > 50 * 1024 * 1024) throw new Error("Invalid local 3D capture.");
        const file = new File([blob], `${frame.name}.${isVideo ? "mp4" : "png"}`, { type: mime });
        for (const clip of frame.kind === "scene-sequence" ? frame.sequenceAudio ?? [] : []) {
          const audioResolved = await editor.adapters.mediaSource.resolveMedia({ id: clip.mediaId, kind: "audio" });
          try {
            const audioResponse = await fetch(audioResolved.url);
            if (!audioResponse.ok) throw new Error("Could not read scene audio.");
            const audioBlob = await audioResponse.blob();
            if (audioBlob.type !== "audio/wav" || audioBlob.size === 0 || audioBlob.size > 50 * 1024 * 1024) throw new Error("Invalid scene audio.");
            audioResources.push({ clip, file: new File([audioBlob], clip.name, { type: "audio/wav" }), resolved: audioResolved, retained: false });
          } catch (error) { editor.adapters.mediaSource.releaseResolved?.(audioResolved); throw error; }
        }
        if (editor.project.getActive()?.metadata.id !== project.metadata.id || editor.scenes.getActiveScene().id !== sceneId) throw new Error("Project or scene changed before the frame was added.");
        const registered = await editor.media.addMediaAsset({ asset: { id: frame.mediaId, name: frame.name, type: isVideo ? "video" : "image", file, url: resolved.url, width: frame.width, height: frame.height, ...(isVideo ? { duration: frame.duration, hasAudio: false } : {}) } });
        if (!registered) throw new Error("Could not add the 3D frame to media.");
        mediaOwnsUrl = registered.file === file;
        if (!mediaOwnsUrl) editor.adapters.mediaSource.releaseResolved?.(resolved);
        const element = buildElementFromMedia({ mediaId: frame.mediaId, mediaType: isVideo ? "video" : "image", name: frame.name, startTime, duration: mediaTimeFromSeconds({ seconds: isVideo ? frame.duration! : 3 }) });
        const provenance = { schemaVersion: 1 as const, sceneId: frame.sourceSceneId, sceneRevision: frame.sourceSceneRevision, capturedAtUtc: frame.capturedAtUtc, contentSha256: frame.mediaId.split(":").at(-1)! };
        const visual = element.type === "image" ? { ...element, sceneFrame: { ...provenance, frameId: frame.id } } : element.type === "video" ? { ...element, isSourceAudioEnabled: false, sceneSequence: { ...provenance, sequenceId: frame.id, outputWidth: frame.width, outputHeight: frame.height, ...(frame.sourceStartSeconds === undefined ? {} : { sourceStartSeconds: frame.sourceStartSeconds, sourceEndSeconds: frame.sourceEndSeconds, sourceFps: frame.sourceFps, frameCount: frame.frameCount }) } } : null;
        if (!visual) throw new Error("Unexpected 3D capture element.");
        const commands = [new InsertElementCommand({ element: visual, placement: { mode: "auto" } })];
        for (const resource of audioResources) {
          const { clip, file: audioFile, resolved: audioResolved } = resource;
          const audioAsset = await editor.media.addMediaAsset({ asset: { id: clip.mediaId, name: clip.name, type: "audio", file: audioFile, url: audioResolved.url, duration: clip.sourceDuration } });
          if (!audioAsset) throw new Error("Could not add scene audio.");
          resource.retained = audioAsset.file === audioFile;
          if (!resource.retained) editor.adapters.mediaSource.releaseResolved?.(audioResolved);
          const audio = buildElementFromMedia({ mediaId: clip.mediaId, mediaType: "audio", name: clip.name, startTime: mediaTimeFromSeconds({ seconds: mediaTimeToSeconds({ time: startTime }) + clip.start }), duration: mediaTimeFromSeconds({ seconds: clip.duration }) });
          if (audio.type !== "audio" || audio.duration <= 0) throw new Error("Scene audio duration is too short.");
          commands.push(new InsertElementCommand({ element: { ...audio, trimStart: mediaTimeFromSeconds({ seconds: clip.sourceOffset }), sourceDuration: mediaTimeFromSeconds({ seconds: clip.sourceDuration }), sceneAudio: { schemaVersion: 1, sequenceId: frame.id, sceneAudioId: clip.id, sourceOffset: clip.sourceOffset } }, placement: { mode: "auto" } }));
        }
        if (editor.project.getActive()?.metadata.id !== project.metadata.id || editor.scenes.getActiveScene().id !== sceneId) throw new Error("Project or scene changed before the capture was added.");
        editor.command.execute({ command: new BatchCommand(commands) });
        setImportStatus(isVideo ? "3D animation added to the timeline." : "3D frame added to the timeline.");
      } catch (error) { if (!mediaOwnsUrl) editor.adapters.mediaSource.releaseResolved?.(resolved); throw error; }
      finally { for (const resource of audioResources) if (!resource.retained) editor.adapters.mediaSource.releaseResolved?.(resource.resolved); }
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const addMockDialogue = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const editor = EditorCore.getInstance();
      const project = editor.project.getActive();
      if (!project) throw new Error("No active project.");
      const sceneId = editor.scenes.getActiveScene().id;
      const startTime = editor.playback.getCurrentTime();
      const provider = new MockVoiceProvider();
      const request = { projectId: project.metadata.id, actorId: "unassigned", text: mockDialogue, language: "und", voiceProfileId: "mock-tone", providerId: "mock-tone", modelRevision: "mock-tone-v1", idempotencyKey: crypto.randomUUID() };
      const { jobId } = await provider.synthesize(request);
      const { wav, asset } = await provider.wavResult(jobId);
      if (editor.project.getActive()?.metadata.id !== project.metadata.id || editor.scenes.getActiveScene().id !== sceneId) throw new Error("Project or scene changed before the tone was added.");
      const file = new File([wav], "mock-tone.wav", { type: "audio/wav" });
      const handle = await editor.adapters.mediaSource.uploadLocalFile(file);
      if (!handle.id.startsWith("local-media:")) throw new Error("Mock tone must be stored locally.");
      const resolved = await editor.adapters.mediaSource.resolveMedia(handle);
      if (editor.project.getActive()?.metadata.id !== project.metadata.id || editor.scenes.getActiveScene().id !== sceneId) throw new Error("Project or scene changed before the tone was added.");
      const name = `[Mock tone] ${mockDialogue.trim()}`;
      const registered = await editor.media.addMediaAsset({ asset: { id: handle.id, name, type: "audio", file, url: resolved.url, duration: asset.durationSeconds } });
      if (!registered) throw new Error("Could not add mock tone to media.");
      const element = buildElementFromMedia({ mediaId: handle.id, mediaType: "audio", name, startTime, duration: mediaTimeFromSeconds({ seconds: asset.durationSeconds }) });
      if (element.type !== "audio") throw new Error("Unexpected mock tone element.");
      editor.timeline.insertElement({ element: { ...element, mockVoiceGeneration: { schemaVersion: 1, kind: "mock-tone", generatedAtUtc: new Date().toISOString(), jobId, request, contentSha256: asset.contentHash, sampleRateHz: 48000, durationSeconds: asset.durationSeconds } }, placement: { mode: "auto" } });
      setImportStatus("Mock tone added. This is not speech.");
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const saveRenderSnapshot = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const snapshot = await createLocalRenderSnapshot(EditorCore.getInstance());
      const saved = await invoke<boolean>("total_recall_export_snapshot", { content: JSON.stringify(snapshot) });
      setImportStatus(saved ? "Render snapshot saved. Render it with the local FFmpeg command." : "Render snapshot save cancelled.");
    } catch (error) { setImportStatus(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setImporting(false); }
  };

  const renderLocalVideo = async () => {
    if (importing) return;
    setImporting(true);
    renderCancelled.current = false;
    setRenderProgress(0);
    const jobId = crypto.randomUUID();
    let registered = false;
    try {
      await invoke("total_recall_render_begin", { jobId });
      registered = true;
      setRenderJobId(jobId);
      setImportStatus("Rendering local MP4…");
      const snapshot = await createLocalRenderSnapshot(EditorCore.getInstance());
      if (renderCancelled.current) throw new Error("Local render cancelled.");
      const content = await invoke<number[]>("total_recall_render_video", { content: JSON.stringify(snapshot), jobId });
      if (renderCancelled.current) throw new Error("Local render cancelled.");
      setRenderJobId(null);
      const saved = await invoke<boolean>("total_recall_save_video", { content });
      setImportStatus(saved ? "Local MP4 saved." : "Local MP4 save cancelled.");
    } catch (error) {
      setImportStatus(renderCancelled.current ? "Local render cancelled." : `Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRenderJobId(null);
      if (registered) {
        try { await invoke("total_recall_render_finish", { jobId }); }
        catch (error) { setImportStatus(`Error releasing render job: ${String(error)}`); }
      }
      setImporting(false);
    }
  };

  const cancelLocalRender = async () => {
    if (!renderJobId || renderCancelled.current) return;
    renderCancelled.current = true;
    setImportStatus("Cancelling local render…");
    try { await invoke("total_recall_render_cancel", { jobId: renderJobId }); }
    catch (error) { renderCancelled.current = false; setImportStatus(`Error cancelling render: ${String(error)}`); }
  };

  if (storageError) return <div role="alert">Project storage unavailable: {storageError}</div>;
  if (!ready) return null;

  return (
    <div className="h-full w-full overflow-hidden">
      <div className="absolute left-4 top-52 z-20 rounded bg-ui-controls p-2 text-sm text-white"><LocalWorkerSettings /></div>
      <button type="button" className="absolute left-4 top-20 z-20 rounded bg-ui-controls px-2 py-1 text-sm text-white" disabled={importing} onClick={() => void importOriginalProject()}>Import webtoon project</button>
      <label className="absolute right-4 top-20 z-20 cursor-pointer rounded bg-ui-controls px-2 py-1 text-sm text-white">Import prepared webtoon<input aria-label="Import prepared webtoon" type="file" accept=".json,application/json" className="sr-only" disabled={importing} onChange={(event) => { void importProject(event.target.files?.[0]); event.target.value = ""; }} /></label>
      <button type="button" className="absolute right-4 top-36 z-20 rounded bg-ui-controls px-2 py-1 text-sm text-white" disabled={importing} onClick={() => void saveRenderSnapshot()}>Save local render snapshot</button>
      <button type="button" className="absolute right-4 top-44 z-20 rounded bg-ui-controls px-2 py-1 text-sm text-white" disabled={importing} onClick={() => void renderLocalVideo()}>Render local MP4</button>
      {renderJobId && <div className="absolute right-4 top-60 z-20 flex items-center gap-2 rounded bg-ui-controls p-1 text-white"><progress aria-label="Local render progress" max={100} value={renderProgress} /><span>{renderProgress}%</span></div>}
      {renderJobId && <button type="button" className="absolute right-4 top-52 z-20 rounded bg-ui-controls px-2 py-1 text-sm text-white" onClick={() => void cancelLocalRender()}>Cancel local render</button>}
      {importStatus && <p role="status" className="absolute right-4 top-28 z-20 rounded bg-ui-controls p-2 text-white">{importStatus}</p>}
      <details className="absolute left-4 top-48 z-20 rounded bg-ui-controls p-2 text-white">
        <summary>3D scene captures</summary>
        <div className="flex flex-col gap-1">
          <button type="button" disabled={importing} onClick={() => void listSceneFrames()}>List local 3D captures</button>
          <label>3D frame <select aria-label="3D frame" className="text-black" value={selectedFrame} disabled={importing || !sceneFrames.length} onChange={(event) => setSelectedFrame(event.target.value)}><option value="" disabled>Select a frame</option>{sceneFrames.map(frame => <option key={frame.id} value={frame.id}>{frame.name}</option>)}</select></label>
          <button type="button" disabled={importing || !selectedFrame} onClick={() => void addSceneFrame()}>Add 3D capture at playhead</button>
        </div>
      </details>
      <details className="absolute left-4 top-32 z-20 rounded bg-ui-controls p-2 text-white">
        <summary>Dialogue tools</summary>
        <div className="flex flex-col gap-1">
        <label htmlFor="mock-dialogue">Mock dialogue (tone only, no speech)</label>
        <textarea id="mock-dialogue" className="text-black" maxLength={500} value={mockDialogue} onChange={(event) => setMockDialogue(event.target.value)} />
        <button type="button" disabled={importing || !mockDialogue.trim()} onClick={() => void addMockDialogue()}>Add mock tone at playhead</button>
        {importedLink && <section aria-label="Imported dialogue link" className="max-w-72 border-t pt-2 text-sm">
          <p>{importedLink.kind === "voice" ? "Imported voice" : "Imported dialogue"}</p>
          <p>Scene: {importedLink.sceneId ?? "unknown"}; character: {importedLink.characterId ?? "unknown"}</p>
          <p className="break-words">{importedLink.sourceText ?? "No source text"}</p>
          {importedLink.links.length === 0 ? <p>{importedLink.kind === "voice" ? "Linked dialogue is unavailable." : "No linked audio."}</p> : importedLink.links.map((link, index) => <button key={link.ref.elementId} type="button" className="block underline" onClick={() => { const editor = EditorCore.getInstance(); editor.selection.setSelectedElements({ elements: [link.ref] }); editor.playback.seek({ time: link.startTime }); }}>{importedLink.kind === "voice" ? "Select linked dialogue" : `Select linked audio ${index + 1}`}{link.hidden ? " (hidden track)" : ""}</button>)}
        </section>}
        </div>
      </details>
      <VideoEditor adapters={adapters} />
      {galleryModal}
    </div>
  );
}
