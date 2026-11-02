import { describe, expect, it } from "vitest";
import { acquirePosePreview, hasPosePreview } from "./pose-control-lease";

describe("pose preview lease", () => {
  it("prevents conflicting edits and releases idempotently", () => {
    const first = {}, second = {};
    const release = acquirePosePreview(first);
    expect(hasPosePreview(first)).toBe(true);
    expect(hasPosePreview(second)).toBe(false);
    expect(() => acquirePosePreview(first)).toThrow();
    release(); release();
    expect(hasPosePreview(first)).toBe(false);
    acquirePosePreview(first)();
  });
});
