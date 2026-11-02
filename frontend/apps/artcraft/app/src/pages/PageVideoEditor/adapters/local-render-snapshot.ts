import { mediaTimeToSeconds, mediaTimeFromSeconds, resolveTransformAtTime, resolveOpacityAtTime, TextNode, renderTextToContext, measureTextElement, buildTransformFromParams, readOpacityFromParams, type EditorCore } from "@storyteller/ui-video-editor";

function encode(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
}

/** Serialize only timeline operations the local FFmpeg renderer can reproduce. */
export async function createLocalRenderSnapshot(editor: EditorCore): Promise<object> {
  const project = editor.project.getActive();
  if (!project) throw new Error("No active project.");
  const { canvasSize, fps, background } = project.settings;
  if (!Number.isInteger(canvasSize.width) || !Number.isInteger(canvasSize.height) || canvasSize.width < 2 || canvasSize.height < 2 || canvasSize.width > 4096 || canvasSize.height > 4096 || canvasSize.width % 2 || canvasSize.height % 2 ||
      !fps || !Number.isInteger(fps.numerator) || !Number.isInteger(fps.denominator) || fps.numerator < 1 || fps.numerator > 1000000 || fps.denominator < 1 || fps.denominator > 100000 || fps.numerator / fps.denominator < 1 || fps.numerator / fps.denominator > 60 || background.type !== "color" || !/^#[0-9a-fA-F]{6}$/.test(background.color)) {
    throw new Error("Local render requires an even canvas up to 4096, FPS from 1 to 60 and an opaque RGB background.");
  }
  const tracks = editor.scenes.getActiveScene().tracks;
  const assets = new Map(editor.media.getAssets().map((asset) => [asset.id, asset]));
  const sceneItems = [];
  const audio = [];
  const allowed = new Set(["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY", "transform.rotate", "opacity", "blendMode"]);
  const visualTracks = [tracks.main, ...tracks.overlay.slice().reverse()];
  for (const [layer, track] of visualTracks.entries()) {
    if (track.hidden) continue;
    if (track.type === "text") {
      await document.fonts.ready;
      for (const element of track.elements) {
        if (element.hidden) continue;
        if (element.animations || element.effects?.length || (element.params.blendMode && element.params.blendMode !== "normal")) throw new Error("Local render does not support hidden, animated or effect text.");
        const canvas = document.createElement("canvas"); canvas.width = canvasSize.width; canvas.height = canvasSize.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Cannot render text.");
        const measured = measureTextElement({ element, canvasHeight: canvasSize.height, localTime: 0, ctx });
        const transform = buildTransformFromParams({ params: element.params });
        const opacity = readOpacityFromParams({ params: element.params });
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || ![transform.position.x, transform.position.y, transform.scaleX, transform.scaleY, transform.rotate].every(Number.isFinite)) throw new Error("Invalid text transform.");
        const node = new TextNode({ ...element, transform, opacity, canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 }, canvasHeight: canvasSize.height, textBaseline: "middle" });
        node.resolved = { transform, opacity, textColor: typeof element.params.color === "string" ? element.params.color : "#ffffff", backgroundColor: measured.resolvedBackground.color, effectPasses: [], measuredText: measured };
        renderTextToContext({ node, ctx });
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob || blob.size > 50 * 1024 * 1024) throw new Error("Text rendering failed or is too large.");
        sceneItems.push({ id: element.id, start: mediaTimeToSeconds({ time: element.startTime }), duration: mediaTimeToSeconds({ time: element.duration }), layer, opacity, png: encode(new Uint8Array(await blob.arrayBuffer())) });
      }
      continue;
    }
    if (track.type !== "video") {
      if (track.elements.length) throw new Error("Local render supports image, video and text layers only.");
      continue;
    }
    for (const element of track.elements) {
    if (element.hidden) continue;
    if ((element.type !== "image" && element.type !== "video") || element.effects?.length || element.masks?.length ||
        Object.entries(element.params).some(([key, value]) => (element.type === "video" && (key === "volume" || key === "muted")) ? false : !allowed.has(key) || (key === "blendMode" && value !== "normal"))) throw new Error("Local render supports image and video clips without effects or animations.");
    const transform = { x: element.params["transform.positionX"] ?? 0, y: element.params["transform.positionY"] ?? 0,
      scaleX: element.params["transform.scaleX"] ?? 1, scaleY: element.params["transform.scaleY"] ?? 1, rotate: element.params["transform.rotate"] ?? 0 };
    if (Object.values(transform).some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
        Math.abs(transform.x as number) > 4096 || Math.abs(transform.y as number) > 4096 ||
        Math.abs(transform.scaleX as number) < 0.01 || Math.abs(transform.scaleX as number) > 8 || Math.abs(transform.scaleY as number) < 0.01 || Math.abs(transform.scaleY as number) > 8 || Math.abs(transform.rotate as number) > 360) throw new Error("Unsupported visual transform.");
    const opacity = element.params.opacity ?? 1;
    if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Invalid clip opacity.");
    const asset = assets.get(element.mediaId);
    if (!asset || asset.type !== element.type || !asset.file || asset.file.size > 50 * 1024 * 1024) throw new Error("A local visual asset is unavailable or too large.");
    const start = mediaTimeToSeconds({ time: element.startTime });
    const duration = mediaTimeToSeconds({ time: element.duration });
    const channels = Object.keys(element.animations ?? {});
    if (channels.some((key) => key !== "transform.positionX" && key !== "transform.positionY" && key !== "transform.scaleX" && key !== "transform.scaleY" && key !== "transform.rotate" && key !== "opacity")) throw new Error("Local render supports position, scale, rotation and opacity keyframes only.");
    let motion: Array<{ frame: number; x: number; y: number; opacity?: number; scaleX?: number; scaleY?: number; rotate?: number }> | undefined;
    if (channels.length) {
      const rate = fps.numerator / fps.denominator;
      const first = Math.max(0, Math.ceil(start * rate - 1e-8));
      const last = Math.ceil((start + duration) * rate - 1e-8);
      if (last - first > 600) throw new Error("Animated clips are limited to 600 rendered frames.");
      const baseTransform = buildTransformFromParams({ params: element.params });
      motion = [];
      for (let frame = first; frame < last; frame++) {
        const time = mediaTimeFromSeconds({ seconds: frame / rate });
        const resolved = resolveTransformAtTime({ baseTransform, animations: element.animations, localTime: Math.max(0, time - element.startTime) });
        if (![resolved.position.x, resolved.position.y].every(Number.isFinite) || Math.abs(resolved.position.x) > 4096 || Math.abs(resolved.position.y) > 4096) throw new Error("Invalid animated position.");
        const sampleOpacity = resolveOpacityAtTime({ baseOpacity: opacity, animations: element.animations, localTime: Math.max(0, time - element.startTime) });
        if (!Number.isFinite(sampleOpacity) || sampleOpacity < 0 || sampleOpacity > 1) throw new Error("Invalid animated opacity.");
        const scaled = channels.includes("transform.scaleX") || channels.includes("transform.scaleY");
        if (scaled && (![resolved.scaleX, resolved.scaleY].every(Number.isFinite) || Math.abs(resolved.scaleX) < 0.01 || Math.abs(resolved.scaleX) > 8 || Math.abs(resolved.scaleY) < 0.01 || Math.abs(resolved.scaleY) > 8 || Math.sign(resolved.scaleX) !== Math.sign(baseTransform.scaleX) || Math.sign(resolved.scaleY) !== Math.sign(baseTransform.scaleY))) throw new Error("Animated scale must retain its direction and stay within the supported range.");
        if (channels.includes("transform.rotate") && (!Number.isFinite(resolved.rotate) || Math.abs(resolved.rotate) > 360)) throw new Error("Animated rotation is outside the supported range.");
        motion.push({ frame, x: resolved.position.x, y: resolved.position.y, ...(channels.includes("opacity") ? { opacity: sampleOpacity } : {}), ...(scaled ? { scaleX: resolved.scaleX, scaleY: resolved.scaleY } : {}), ...(channels.includes("transform.rotate") ? { rotate: resolved.rotate } : {}) });
      }
    }

    if (element.type === "video") {
      if (element.retime) throw new Error("Local render requires normal video speed.");
      if (!["video/mp4", "video/webm", "video/quicktime"].includes(asset.file.type)) throw new Error("Unsupported local video format.");
      const source_offset = mediaTimeToSeconds({ time: element.trimStart });
      if (source_offset < 0 || !Number.isFinite(asset.duration) || source_offset + duration > asset.duration! + 0.05) throw new Error("Video trim exceeds the available source.");
      sceneItems.push({ id: element.id, start, duration, layer, opacity, transform, motion, kind: "video", source_offset, mime: asset.file.type, data: encode(new Uint8Array(await asset.file.arrayBuffer())) });
      if (element.isSourceAudioEnabled !== false && !track.muted && asset.hasAudio !== false) {
        const db = element.params.volume ?? 0;
        const muted = element.params.muted ?? false;
        if (typeof db !== "number" || !Number.isFinite(db) || db < -60 || db > 20 || typeof muted !== "boolean") throw new Error("Invalid video audio settings.");
        if (!muted) audio.push({ name: element.name, source_scene: element.id, start, duration, source_offset, volume: 10 ** (db / 20), muted: false });
      }

      continue;
    }
    const bitmap = await createImageBitmap(asset.file);
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); throw new Error("Cannot decode image."); }
    ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || blob.size > 50 * 1024 * 1024) throw new Error("Image conversion failed or is too large.");
    sceneItems.push({ id: element.id, start, duration, layer, opacity, transform, motion, png: encode(new Uint8Array(await blob.arrayBuffer())) });
    }
  }
  sceneItems.sort((a, b) => a.layer - b.layer || a.start - b.start);
  if (!sceneItems.length || sceneItems.some((item, index) => index > 0 && item.layer === sceneItems[index - 1].layer && item.start < sceneItems[index - 1].start + sceneItems[index - 1].duration - 1e-9)) throw new Error("Local render requires non-overlapping clips on each visual track.");
  const supported = new Set(["audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/flac"]);
  for (const track of tracks.audio) for (const element of track.elements) {
    if (element.sourceType !== "upload" || element.retime || element.animations || Object.keys(element.params).some((key) => key !== "volume" && key !== "muted")) throw new Error("Local render does not support this audio clip.");
    const asset = assets.get(element.mediaId);
    if (!asset || asset.type !== "audio" || !asset.file || !supported.has(asset.file.type) || asset.file.size > 50 * 1024 * 1024) throw new Error("A supported local audio asset is unavailable or too large.");
    const db = element.params.volume ?? 0;
    if (typeof db !== "number" || !Number.isFinite(db) || db < -60 || db > 20) throw new Error("Invalid audio volume.");
    audio.push({ name: element.name, mime: asset.file.type, start: mediaTimeToSeconds({ time: element.startTime }), duration: mediaTimeToSeconds({ time: element.duration }), source_offset: mediaTimeToSeconds({ time: element.trimStart }), volume: 10 ** (db / 20), muted: track.muted || element.params.muted === true, data: encode(new Uint8Array(await asset.file.arrayBuffer())) });
  }
  return { format: "total-recall-webtoon-import", version: 1, scenes: sceneItems, audio, render: { ...canvasSize, fps: { numerator: fps.numerator, denominator: fps.denominator }, background: background.color, fit: "contain" } };
}
