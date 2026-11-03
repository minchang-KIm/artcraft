declare module "gltf-validator" {
  export function validateBytes(data: Uint8Array, options?: { uri?: string; maxIssues?: number }): Promise<{
    issues: { numErrors: number; messages: Array<{ severity: number; code: string; message: string }> };
  }>;
}
