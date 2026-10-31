import { useEffect, useMemo, useRef, useState } from "react";
import {
  VideoEditor,
  EditorCore,
  buildDefaultScene,
  createDefaultAdapters,
  ZERO_MEDIA_TIME,
  type TProject,
  type VideoEditorAdapters,
} from "@storyteller/ui-video-editor";
import { tauriToastAdapter } from "./adapters/toast-adapter";
import { tauriAuthUserAdapter } from "./adapters/auth-user-adapter";
import { tauriMediaSourceAdapter } from "./adapters/media-source-adapter";
import { tauriExportSinkAdapter } from "./adapters/export-sink-adapter";
import { useTauriAssetGalleryAdapter } from "./adapters/asset-gallery-adapter";
import { invoke } from "@tauri-apps/api/core";
import { createTotalRecallProjectStorage } from "./adapters/total-recall-project-storage";

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

export function PageVideoEditor() {
  const [ready, setReady] = useState(false);
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

  if (storageError) return <div role="alert">Project storage unavailable: {storageError}</div>;
  if (!ready) return null;

  return (
    <div className="h-full w-full overflow-hidden">
      <VideoEditor adapters={adapters} />
      {galleryModal}
    </div>
  );
}
