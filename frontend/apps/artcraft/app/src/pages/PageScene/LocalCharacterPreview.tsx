import { useEffect, useRef, useState } from "react";
import { Modal } from "@storyteller/ui-modal";
import { Viewer3D } from "@storyteller/ui-viewer-3d";

const MAX_BYTES = 50 * 1024 * 1024;

/** Local-only preview; scene/project import is not implemented yet. */
export function LocalCharacterPreview() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const selection = useRef(0);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => () => { selection.current++; }, []);

  const choose = async (file: File | undefined) => {
    const current = ++selection.current;
    setError(undefined);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".glb") || file.size < 12 || file.size > MAX_BYTES) {
      setError("Select a GLB file between 12 bytes and 50 MiB.");
      return;
    }
    try {
      const header = new DataView(await file.slice(0, 12).arrayBuffer());
      if (current !== selection.current) return;
      if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== file.size) {
        setError("The file is not a valid GLB 2.0 container.");
        return;
      }
      setUrl(URL.createObjectURL(file));
    } catch {
      if (current === selection.current) setError("Unable to read the selected file.");
    }
  };

  const close = () => { selection.current++; setOpen(false); setUrl(undefined); setError(undefined); };
  return (
    <>
      <button type="button" className="absolute right-4 top-16 z-20 rounded bg-ui-controls px-3 py-2 text-white" onClick={() => setOpen(true)}>
        Preview local GLB
      </button>
      <Modal isOpen={open} onClose={close} title="Local character preview" accessibleDescription="Preview only. This does not add the model to the scene or project." width={720}>
        <p>Preview only. This does not add the model to the scene or project.</p>
        <label className="my-3 block">
          Select GLB
          <input className="ml-3" type="file" accept=".glb,model/gltf-binary" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        {error && <p role="alert">{error}</p>}
        {url && <div className="h-[500px]"><Viewer3D modelUrl={url} isActive showGrid /></div>}
      </Modal>
    </>
  );
}
