import type { EditorProject, ProjectMeta, ProjectStorageAdapter } from "@storyteller/ui-video-editor";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type StoredProject = EditorProject & { revision: number };

/** A durable adapter; revision numbers are never trusted from the UI payload. */
export function createTotalRecallProjectStorage(invoke: Invoke, legacy: ProjectStorageAdapter) {
  const revisions = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, task: () => Promise<T>): Promise<T> => {
    const previous = pending.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    pending.set(id, current);
    void current.finally(() => { if (pending.get(id) === current) pending.delete(id); }).catch(() => undefined);
    return current;
  };
  const load = async (id: string): Promise<StoredProject | null> => {
    const value = await invoke<StoredProject | null>("total_recall_project_load", { id });
    if (value) revisions.set(id, value.revision);
    else revisions.delete(id);
    return value;
  };
  const create = async (project: EditorProject): Promise<StoredProject> => {
    const result = await invoke<StoredProject>("total_recall_project_create", { id: project.id, document: project });
    revisions.set(project.id, result.revision);
    return result;
  };
  const adapter: ProjectStorageAdapter = {
    async loadProject(id: string) {
      return serial(id, async () => {
        const project = await load(id);
        if (!project) return null;
        const { revision: _revision, ...envelope } = project;
        return envelope;
      });
    },
    async saveProject(project: EditorProject) {
      await serial(project.id, async () => {
        let revision = revisions.get(project.id);
        if (revision === undefined) {
          const existing = await load(project.id);
          if (!existing) { await create(project); return; }
          revision = existing.revision;
        }
        const saved = await invoke<StoredProject>("total_recall_project_save", {
          id: project.id, expectedRevision: revision, document: project,
        });
        revisions.set(project.id, saved.revision);
      });
    },
    async deleteProject(id: string) {
      await serial(id, async () => {
        const revision = revisions.get(id) ?? (await load(id))?.revision;
        if (revision === undefined) return;
        await invoke<void>("total_recall_project_delete", { id, expectedRevision: revision });
        revisions.delete(id);
      });
    },
    async listProjects() {
      const all = await invoke<StoredProject[]>("total_recall_project_list");
      return all.map(({ id, name, updatedAt }): ProjectMeta => ({ id, name, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async createProject(name: string) {
      const project: EditorProject = { id: crypto.randomUUID(), name, updatedAt: Date.now(), data: null };
      await serial(project.id, () => create(project));
      return project;
    },
  };
  const migrateLegacy = async () => {
    const items = await legacy.listProjects();
    for (const item of items) {
      await serial(item.id, async () => {
        if (await invoke<boolean>("total_recall_project_exists", { id: item.id })) return;
        const project = await legacy.loadProject(item.id);
        if (project) await create(project);
      });
    }
  };
  return { adapter, migrateLegacy };
}
