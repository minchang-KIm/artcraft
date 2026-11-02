import { describe, expect, it } from "vitest";
import { HistoryManager } from "./HistoryManager";

describe("HistoryManager failures", () => {
  it("keeps the action and permits retry after undo or redo fails", async () => {
    const history = new HistoryManager();
    let failUndo = true, failRedo = true;
    history.record({
      label: "replace",
      revert: () => { if (failUndo) { failUndo = false; throw new Error("undo failed"); } },
      apply: () => { if (failRedo) { failRedo = false; throw new Error("redo failed"); } },
    });
    await expect(history.undo()).rejects.toThrow("undo failed");
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    await history.undo();
    await expect(history.redo()).rejects.toThrow("redo failed");
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    await history.redo();
    expect(history.canUndo()).toBe(true);
  });
});
