/** Validate locally before opening a save dialog. No external resources are fetched. */
export async function validateExportedGlb(data: ArrayBuffer): Promise<void> {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 20 || data.byteLength > 50 * 1024 * 1024) {
    throw new Error("Invalid GLB size.");
  }
  const validator = await import("gltf-validator");
  let report: Awaited<ReturnType<typeof validator.validateBytes>>;
  try {
    report = await validator.validateBytes(new Uint8Array(data), { uri: "character.glb", maxIssues: 10 });
  } catch (error) {
    throw new Error(`GLB validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!report?.issues || !Number.isInteger(report.issues.numErrors)) throw new Error("GLB validation did not return a usable result.");
  if (report.issues.numErrors > 0) {
    const details = report.issues.messages.filter((message: { severity: number }) => message.severity === 0).slice(0, 3).map((message: { code: string; message: string }) => `${message.code}: ${message.message}`).join("; ");
    throw new Error(`GLB validation failed (${report.issues.numErrors} errors)${details ? `: ${details}` : "."}`);
  }
}
