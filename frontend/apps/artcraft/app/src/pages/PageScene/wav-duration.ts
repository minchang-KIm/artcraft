/** Validate a complete little-endian PCM/float WAV and return its duration. */
export function wavDuration(bytes: Uint8Array): number {
  if (bytes.length < 44) throw new Error("Invalid WAV file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) throw new Error("Invalid WAV container.");
  let format: { channels: number; rate: number; byteRate: number; align: number; bits: number; code: number } | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const kind = tag(offset), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > bytes.length || end + (size % 2) > bytes.length) throw new Error("Invalid WAV chunk.");
    if (kind === "fmt ") {
      if (format || size < 16) throw new Error("Invalid WAV format.");
      format = { code: view.getUint16(start, true), channels: view.getUint16(start + 2, true), rate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true), align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true) };
    } else if (kind === "data") {
      if (dataBytes !== undefined) throw new Error("Multiple WAV data chunks are not supported.");
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (offset !== bytes.length) throw new Error("Invalid trailing WAV data.");
  if (!format || dataBytes === undefined || !dataBytes || ![1, 3].includes(format.code) || format.channels < 1 || format.channels > 8 || format.rate < 8000 || format.rate > 192000 || ![8, 16, 24, 32].includes(format.bits) || (format.code === 3 && format.bits !== 32) || format.align !== format.channels * format.bits / 8 || format.byteRate !== format.rate * format.align || dataBytes % format.align !== 0) throw new Error("Unsupported or invalid PCM WAV.");
  const duration = dataBytes / format.byteRate;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error("Invalid WAV duration.");
  return duration;
}
