import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const fields = [
  ["TOTAL_RECALL_IMPORT_PYTHON", "Webtoon import Python"],
  ["TOTAL_RECALL_IMPORT_WORKER", "Webtoon import script"],
  ["TOTAL_RECALL_RENDER_PYTHON", "Video render Python"],
  ["TOTAL_RECALL_RENDER_WORKER", "Video render script"],
  ["TOTAL_RECALL_RENDER_FFMPEG", "FFmpeg executable"],
  ["TOTAL_RECALL_RIG_PYTHON", "Rigging Python"],
  ["TOTAL_RECALL_RIG_WORKER", "Rigging worker script"],
  ["TOTAL_RECALL_RIG_WORKSPACE", "SkinTokens workspace folder"],
  ["TOTAL_RECALL_VOICE_PYTHON", "Speech Python"],
  ["TOTAL_RECALL_VOICE_WORKER", "Speech worker script"],
  ["TOTAL_RECALL_VOICE_ESPEAK", "eSpeak NG executable"],
  ["TOTAL_RECALL_MHR_PYTHON", "MHR Python"],
  ["TOTAL_RECALL_MHR_WORKER", "MHR export script"],
  ["TOTAL_RECALL_MHR_MODEL", "MHR model file"],
  ["TOTAL_RECALL_MHR_ROOT", "MHR source folder"],
] as const;
type WorkerSetting = { key: string; path: string | null; source: "environment" | "saved" | "missing" };

/** The selected executables and scripts remain local and are never sent to a provider. */
export function LocalWorkerSettings() {
  const [key, setKey] = useState<string>(fields[0][0]);
  const [settings, setSettings] = useState<WorkerSetting[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = settings.find(item => item.key === key);
  const refresh = async () => setSettings(await invoke<WorkerSetting[]>("total_recall_worker_settings"));
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await operation();
      await refresh();
      setMessage(result === false ? "Selection cancelled." : success);
    } catch (error) { setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  };
  return <details onToggle={event => { if (event.currentTarget.open) void run(async () => undefined, "Worker settings loaded."); }}>
    <summary>Local worker settings</summary>
    <div className="flex max-w-80 flex-col gap-1">
      <label>Setting <select aria-label="Local worker setting" className="text-black" value={key} disabled={busy} onChange={event => setKey(event.target.value)}>{fields.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <p className="break-all">{selected?.path ?? "Not configured"}{selected?.source === "environment" ? " (environment override)" : ""}</p>
      <button type="button" disabled={busy || !selected || selected.source === "environment"} onClick={() => void run(() => invoke<boolean>("total_recall_choose_worker_setting", { key }), "Local worker path saved.")}>Choose local path</button>
      <button type="button" disabled={busy || selected?.source !== "saved"} onClick={() => void run(() => invoke("total_recall_clear_worker_setting", { key }), "Local worker path cleared.")}>Clear saved path</button>
      <p aria-live="polite" data-worker-status>{message}</p>
    </div>
  </details>;
}
