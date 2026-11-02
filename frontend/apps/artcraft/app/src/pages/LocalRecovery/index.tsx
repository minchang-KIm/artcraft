import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Project = { id: string; name: string; kind: "scene" | "video"; currentRevision: number; deleted: boolean; corrupt: boolean };
type Revision = { revision: number; createdAt: string; deleted: boolean; readable: boolean };
type Props = { kind: Project["kind"]; copy: (document: unknown, revision: number) => Promise<void> };

/** Verify referenced local bytes before publishing a recovery copy. */
export async function validateLocalReferences(value: unknown): Promise<void> {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  const ids = new Set<string>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && (/^local-glb:[0-9a-f]{64}$/.test(item) || /^local-media:[a-z0-9.+~-]+:[0-9a-f]{64}$/.test(item))) ids.add(item);
    else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      for (const value of Object.values(item)) pending.push(value);
    }
    if (ids.size > 10000) throw new Error("Recovery has too many local assets.");
  }
  for (const id of ids) await invoke(id.startsWith("local-glb:") ? "total_recall_asset_get" : "total_recall_media_get", { id });
}

/** Recovery only creates a new copy; current editor state and source remain intact. */
export function LocalRecovery({ kind, copy }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revision, setRevision] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = async (action: () => Promise<string>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { setMessage(await action()); }
    catch (error) { setMessage(`Error: ${error instanceof Error ? error.message : String(error)}`); }
    finally { pending.current = false; setBusy(false); }
  };
  const list = () => run(async () => {
    const all = await invoke<Project[]>("total_recall_recovery_projects");
    const next = all.filter(project => project.kind === kind);
    setProjects(next); setSelected(next[0]?.id ?? ""); setRevisions([]); setRevision(""); setHasMore(false);
    return next.length ? `${next.length} recoverable item(s) found.` : "No recoverable items.";
  });
  const load = (older: boolean) => run(async () => {
    if (!selected) throw new Error("Select an item first.");
    const before = older ? revisions.at(-1)?.revision : undefined;
    if (older && before === undefined) throw new Error("No earlier history is loaded.");
    const page = await invoke<Revision[]>("total_recall_project_history", { id: selected, before: before ?? null, limit: 100 });
    setRevisions(previous => older ? [...previous, ...page] : page);
    setHasMore(page.length === 100);
    if (!older) setRevision(page.find(item => item.readable && !item.deleted)?.revision.toString() ?? "");
    return page.length ? `${page.length} revision(s) loaded.` : "No more revisions.";
  });
  const recover = () => run(async () => {
    const number = Number(revision);
    if (!selected || !revision || !Number.isSafeInteger(number) || number < 0) throw new Error("Select a readable revision.");
    const snapshot = await invoke<unknown>("total_recall_project_revision", { id: selected, revision: number });
    await copy(snapshot, number);
    return "Recovery copy created. Open it from the local list.";
  });
  return <details>
    <summary>Recover saved history</summary>
    <div className="flex max-w-80 flex-col gap-1">
      <p>Recovery creates a new copy and leaves the current editor and original unchanged.</p>
      <button type="button" disabled={busy} onClick={() => void list()}>List recoverable {kind === "scene" ? "scenes" : "videos"}</button>
      <label>Saved item <select aria-label={`Recoverable ${kind}`} className="text-black" value={selected} disabled={busy || !projects.length} onChange={event => { setSelected(event.target.value); setRevisions([]); setRevision(""); setHasMore(false); }}><option value="" disabled>Select an item</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.deleted ? " (deleted)" : ""}{project.corrupt ? " (current damaged)" : ""}</option>)}</select></label>
      <button type="button" disabled={busy || !selected} onClick={() => void load(false)}>List saved revisions</button>
      <label>Revision <select aria-label={`Recovery revision ${kind}`} className="text-black" value={revision} disabled={busy || !revisions.length} onChange={event => setRevision(event.target.value)}><option value="" disabled>Select a revision</option>{revisions.map(item => <option key={item.revision} value={String(item.revision)} disabled={item.deleted || !item.readable}>{item.revision} · {item.createdAt}{item.deleted ? " (deleted)" : ""}{!item.readable ? " (damaged)" : ""}</option>)}</select></label>
      {hasMore && <button type="button" disabled={busy} onClick={() => void load(true)}>Load older revisions</button>}
      <button type="button" disabled={busy || !revision} onClick={() => void recover()}>Create recovery copy</button>
      <p aria-live="polite" data-recovery-status>{message}</p>
    </div>
  </details>;
}
