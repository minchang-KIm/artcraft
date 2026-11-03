import { describe, expect, it } from "vitest";
import { validateExportedGlb } from "./validateExportedGlb";

describe("local GLB validation", () => {
  it("rejects malformed output before it can be saved", async () => {
    await expect(validateExportedGlb(new ArrayBuffer(20))).rejects.toThrow("GLB validation failed");
    await expect(validateExportedGlb(new ArrayBuffer(19))).rejects.toThrow("Invalid GLB size");
  });
});
