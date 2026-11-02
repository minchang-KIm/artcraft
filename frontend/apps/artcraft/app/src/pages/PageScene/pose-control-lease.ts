/** A webcam preview owns the bones until it is applied or cancelled. */
const active = new WeakSet<object>();

export function hasPosePreview(owner: object): boolean { return active.has(owner); }

export function acquirePosePreview(owner: object): () => void {
  if (active.has(owner)) throw new Error("A pose preview is already active.");
  active.add(owner);
  let held = true;
  return () => { if (held) { held = false; active.delete(owner); } };
}
