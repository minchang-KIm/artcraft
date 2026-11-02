import type {
  MediaHandle,
  MediaKind,
  MediaSourceAdapter,
  ResolvedMedia,
} from "@storyteller/ui-video-editor";
import { kindFromMime } from "@storyteller/ui-video-editor";
import { MediaFilesApi } from "@storyteller/api";
import { invoke } from "@tauri-apps/api/core";

// Local imports remain in the shared SQLite asset store. Existing cloud
// media handles continue to resolve through MediaFilesApi.

type ApiMediaFileClass = "video" | "audio" | "image" | "unknown" | string;

const filesApi = new MediaFilesApi();

function kindFromMediaClass(mediaClass: ApiMediaFileClass | null): MediaKind {
  if (mediaClass === "video") return "video";
  if (mediaClass === "audio") return "audio";
  return "image";
}

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

function extensionOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.split(/[?#]/)[0];
  const dot = trimmed.lastIndexOf(".");
  if (dot === -1 || dot === trimmed.length - 1) return null;
  return trimmed.slice(dot + 1).toLowerCase();
}

function mimeForMediaFile({
  maybeOriginalFilename,
  cdnUrl,
  publicBucketPath,
  mediaClass,
}: {
  maybeOriginalFilename: string | null;
  cdnUrl: string;
  publicBucketPath: string;
  mediaClass: ApiMediaFileClass | null;
}): string {
  const candidates = [maybeOriginalFilename, cdnUrl, publicBucketPath];
  for (const candidate of candidates) {
    const ext = extensionOf(candidate);
    if (ext && EXT_TO_MIME[ext]) return EXT_TO_MIME[ext];
  }
  if (mediaClass === "video") return "video/mp4";
  if (mediaClass === "audio") return "audio/mpeg";
  if (mediaClass === "image") return "image/png";
  return "application/octet-stream";
}

export const tauriMediaSourceAdapter: MediaSourceAdapter = {
  async uploadLocalFile(file: File): Promise<MediaHandle> {
    const mime = file.type || EXT_TO_MIME[extensionOf(file.name) ?? ""] || "";
    const kind = kindFromMime(mime);
    if (!mime || file.size === 0 || file.size > 256 * 1024 * 1024) throw new Error("Unsupported media type or size (maximum 256 MiB).");
    const id = await invoke<string>("total_recall_media_put", { mime, content: Array.from(new Uint8Array(await file.arrayBuffer())) });
    return { id, kind };
  },

  async resolveMedia(handle: MediaHandle): Promise<ResolvedMedia> {
    if (handle.id.startsWith("local-media:")) {
      const [mime, content] = await invoke<[string, number[]]>("total_recall_media_get", { id: handle.id });
      return { mime, url: URL.createObjectURL(new Blob([Uint8Array.from(content)], { type: mime })) };
    }
    const response = await filesApi.GetMediaFileByToken({
      mediaFileToken: handle.id,
    });
    if (!response.success || !response.data) {
      throw new Error(
        response.errorMessage || `Failed to resolve media ${handle.id}`,
      );
    }
    const media = response.data;
    return {
      url: media.media_links.cdn_url,
      mime: mimeForMediaFile({
        maybeOriginalFilename: media.maybe_original_filename,
        cdnUrl: media.media_links.cdn_url,
        publicBucketPath: media.public_bucket_path,
        mediaClass: media.media_class,
      }),
      durationMs: media.maybe_duration_millis ?? undefined,
    };
  },

  releaseResolved(resolved) {
    if (resolved.url.startsWith("blob:")) URL.revokeObjectURL(resolved.url);
  },

  async deleteHandle(handle) {
    if (handle.id.startsWith("local-media:")) return; // Shared by saved revisions.
    const response = await filesApi.DeleteMediaFileByToken({
      mediaFileToken: handle.id,
      asMod: false,
    });
    if (!response.success) {
      throw new Error(
        response.errorMessage || `Failed to delete media ${handle.id}`,
      );
    }
  },
};

export { kindFromMediaClass };
