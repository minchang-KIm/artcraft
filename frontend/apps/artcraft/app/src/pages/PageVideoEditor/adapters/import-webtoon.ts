import {
  buildDefaultScene, buildElementFromMedia, buildTextElement, mediaTimeFromSeconds,
  serializeProjectDocument,
  type MediaAssetData, type MediaSourceAdapter, type ProjectStorageAdapter, type TProject,
} from "@storyteller/ui-video-editor";

type PreparedAudio = { name: string; mime: string; start: number; duration: number; volume: number; muted: boolean; data: string; legacy_voice?: { scene_id: string | null; character_id: string | null; text: string | null; dialogue_index: number | null } };

type PreparedDialogue = { text: string; start: number; duration: number; scene_id: string; dialogue_index: number; character_id: string | null; timing_inferred: boolean };

type PreparedScene = { id: string; start: number; duration: number; width: number; height: number; png: string };

/** Create a new project without changing the active one or the source file. */
export async function importWebtoon(value: unknown, storage: ProjectStorageAdapter, media: MediaSourceAdapter): Promise<string> {
  if (!value || typeof value !== "object") throw new Error("Invalid webtoon import file.");
  const document = value as { format?: unknown; version?: unknown; name?: unknown; scenes?: unknown; audio?: unknown; dialogues?: unknown; original_project?: unknown };
  if (document.format !== "total-recall-webtoon-import" || document.version !== 1 || !Array.isArray(document.scenes) || !document.scenes.length || document.scenes.length > 1000) throw new Error("Invalid webtoon import file.");
  if (document.original_project !== undefined && (!document.original_project || typeof document.original_project !== "object" || Array.isArray(document.original_project))) throw new Error("Invalid original webtoon metadata.");
  const scenes = document.scenes as PreparedScene[];
  let end = 0;
  for (const scene of scenes) {
    if (!scene || typeof scene.id !== "string" || !Number.isFinite(scene.start) || !Number.isFinite(scene.duration) || scene.start < end || scene.duration <= 0 || scene.start + scene.duration > 86400 ||
      !Number.isInteger(scene.width) || !Number.isInteger(scene.height) || scene.width < 1 || scene.height < 1 || scene.width > 16384 || scene.height > 16384 ||
      typeof scene.png !== "string" || scene.png.length > 70 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(scene.png)) throw new Error("Invalid or overlapping webtoon scene.");
    end = scene.start + scene.duration;
  }
  const dialogues = document.dialogues === undefined ? [] : document.dialogues;
  if (!Array.isArray(dialogues) || dialogues.length > 10000) throw new Error("Invalid webtoon dialogues.");
  for (const line of dialogues as PreparedDialogue[]) {
    if (!line || typeof line.text !== "string" || !line.text.trim() || !Number.isFinite(line.start) || !Number.isFinite(line.duration) || line.start < 0 || line.duration <= 0 || line.start + line.duration > 86400 || typeof line.scene_id !== "string" || !Number.isSafeInteger(line.dialogue_index) || line.dialogue_index < 0 || (line.character_id !== null && typeof line.character_id !== "string") || typeof line.timing_inferred !== "boolean") throw new Error("Invalid webtoon dialogue.");
    end = Math.max(end, line.start + line.duration);
  }
  const audio = document.audio === undefined ? [] : document.audio;
  if (!Array.isArray(audio) || audio.length > 1000) throw new Error("Invalid webtoon audio.");
  const extensions: Record<string, string> = { "audio/wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/aac": "aac", "audio/flac": "flac" };
  for (const item of audio as PreparedAudio[]) {
    if (!item || typeof item.name !== "string" || !extensions[item.mime] || !Number.isFinite(item.start) || !Number.isFinite(item.duration) || item.start < 0 || item.duration <= 0 || item.start + item.duration > 86400 ||
        !Number.isFinite(item.volume) || item.volume < 0 || item.volume > 10 || (item.volume > 0 && item.volume < 0.001) || typeof item.muted !== "boolean" ||
        typeof item.data !== "string" || item.data.length > 70 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw new Error("Invalid webtoon audio.");
    const voice = item.legacy_voice;
    if (voice !== undefined && (!voice || typeof voice !== "object" || [voice.scene_id, voice.character_id, voice.text].some(value => value !== null && typeof value !== "string") || (voice.dialogue_index !== null && (!Number.isSafeInteger(voice.dialogue_index) || voice.dialogue_index < 0)))) throw new Error("Invalid legacy voice metadata.");
    end = Math.max(end, item.start + item.duration);
  }
  const projectId = `webtoon-${crypto.randomUUID()}`;
  const name = typeof document.name === "string" && document.name.trim() ? document.name.slice(0, 200) : "Imported webtoon";
  const timeline = buildDefaultScene({ name: "Webtoon timeline", isMain: true });
  const manifest: MediaAssetData[] = [];
  for (const item of scenes) {
    const binary = atob(item.png);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) throw new Error("Invalid scene PNG.");
    const file = new File([bytes], `${item.id}.png`, { type: "image/png" });
    const handle = await media.uploadLocalFile(file);
    if (!handle.id.startsWith("local-media:")) throw new Error("Webtoon images must be stored locally.");
    manifest.push({ id: handle.id, name: file.name, type: "image" as const, size: file.size, lastModified: file.lastModified, width: item.width, height: item.height });
    const element = buildElementFromMedia({ mediaId: handle.id, mediaType: "image", name: item.id, startTime: mediaTimeFromSeconds({ seconds: item.start }), duration: mediaTimeFromSeconds({ seconds: item.duration }) });
    if (element.type !== "image") throw new Error("Unexpected timeline element.");
    timeline.tracks.main.elements.push({ ...element, id: crypto.randomUUID() });
  }
  const textTracks: { end: number; track: { id: string; type: "text"; name: string; hidden: boolean; elements: Array<ReturnType<typeof createDialogue>> } }[] = [];
  function createDialogue(line: PreparedDialogue) {
    const element = buildTextElement({ startTime: mediaTimeFromSeconds({ seconds: line.start }), raw: { name: "Imported dialogue", duration: mediaTimeFromSeconds({ seconds: line.duration }), params: { content: line.text } } });
    if (element.type !== "text") throw new Error("Unexpected dialogue element.");
    return { ...element, id: crypto.randomUUID(), legacyDialogue: { schemaVersion: 1 as const, sceneId: line.scene_id, dialogueIndex: line.dialogue_index, characterId: line.character_id, timingInferred: line.timing_inferred } };
  }
  const dialogueIds = new Map<string, string | null>();
  for (const line of [...dialogues as PreparedDialogue[]].sort((a, b) => a.start - b.start)) {
    let slot = textTracks.find((entry) => entry.end <= line.start + 1e-9);
    if (!slot) {
      slot = { end: 0, track: { id: crypto.randomUUID(), type: "text", name: `Imported dialogue ${textTracks.length + 1}`, hidden: true, elements: [] } };
      textTracks.push(slot);
    }
    slot.end = line.start + line.duration;
    const element = createDialogue(line);
    const key = JSON.stringify([line.scene_id, line.dialogue_index]);
    dialogueIds.set(key, dialogueIds.has(key) ? null : element.id);
    slot.track.elements.push(element);
  }
  timeline.tracks.overlay.push(...textTracks.map((entry) => entry.track));
  for (const [index, item] of (audio as PreparedAudio[]).entries()) {
    const bytes = Uint8Array.from(atob(item.data), (character) => character.charCodeAt(0));
    if (!bytes.length) throw new Error("Empty webtoon audio.");
    const file = new File([bytes], `audio-${index + 1}.${extensions[item.mime]}`, { type: item.mime });
    const handle = await media.uploadLocalFile(file);
    if (!handle.id.startsWith("local-media:")) throw new Error("Webtoon audio must be stored locally.");
    manifest.push({ id: handle.id, name: file.name, type: "audio" as const, size: file.size, lastModified: file.lastModified });
    const element = buildElementFromMedia({ mediaId: handle.id, mediaType: "audio", name: item.name, startTime: mediaTimeFromSeconds({ seconds: item.start }), duration: mediaTimeFromSeconds({ seconds: item.duration }) });
    if (element.type !== "audio") throw new Error("Unexpected timeline element.");
    element.params = { ...element.params, volume: item.volume === 0 ? -60 : 20 * Math.log10(item.volume), muted: item.muted || item.volume === 0 };
    const voice = item.legacy_voice;
    const matches = voice ? (dialogues as PreparedDialogue[]).filter(line => line.scene_id === voice.scene_id && line.character_id === voice.character_id && line.text === voice.text && Math.abs(line.start - item.start) < 1e-6) : [];
    const target = matches.length === 1 && voice?.dialogue_index === matches[0].dialogue_index ? dialogueIds.get(JSON.stringify([voice.scene_id, voice.dialogue_index])) ?? null : null;
    timeline.tracks.audio.push({ id: crypto.randomUUID(), type: "audio", name: item.name, muted: false, elements: [{ ...element, id: crypto.randomUUID(), ...(voice ? { legacyVoice: { schemaVersion: 1 as const, sceneId: voice.scene_id, characterId: voice.character_id, sourceText: voice.text, dialogueElementId: target } } : {}) }] });
  }
  // FFmpeg's yuv420p output needs even dimensions; fit large panels into the
  // renderer's canvas limit without changing the stored source image.
  const canvasScale = Math.min(1, 4096 / scenes[0].width, 4096 / scenes[0].height);
  const canvasSize = {
    width: Math.max(2, Math.round(scenes[0].width * canvasScale / 2) * 2),
    height: Math.max(2, Math.round(scenes[0].height * canvasScale / 2) * 2),
  };
  const now = new Date();
  const project: TProject = {
    metadata: { id: projectId, name, createdAt: now, updatedAt: now, duration: mediaTimeFromSeconds({ seconds: end }) },
    scenes: [timeline], currentSceneId: timeline.id,
    settings: { fps: { numerator: 30, denominator: 1 } as never, canvasSize, background: { type: "color", color: "#000000" } },
    version: 1,
    ...(document.original_project === undefined ? {} : { legacyWebtoonSource: { schemaVersion: 1 as const, originalProject: document.original_project as Record<string, unknown> } }),
  };
  await storage.saveProject({ id: projectId, name, updatedAt: now.getTime(), data: serializeProjectDocument({ project, media: manifest }) });
  return projectId;
}
