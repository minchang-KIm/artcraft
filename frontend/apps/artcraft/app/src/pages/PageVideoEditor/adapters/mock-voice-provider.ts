import type { MediaAsset, VoiceCapabilities, VoiceProvider, VoiceSynthesisRequest } from "../../../../../../../../../../docs/total recall/character-platform/contracts/voice-provider";

type Job = { request: VoiceSynthesisRequest; cancelled: boolean; result?: Promise<{ asset: MediaAsset; wav: Uint8Array }> };

/** Development-only tone; it never produces speech, clones a voice, or contacts a service. */
export class MockVoiceProvider implements VoiceProvider {
  private jobs = new Map<string, Job>();
  private idempotency = new Map<string, string>();

  async capabilities(): Promise<VoiceCapabilities> {
    return { providerId: "mock-tone", languages: ["und"], streaming: false, sampleRatesHz: [48000], voiceCloning: false, rightsState: "pending" };
  }

  async quote(request: VoiceSynthesisRequest): Promise<{ estimateCredits: number }> {
    this.validate(request);
    return { estimateCredits: 0 };
  }

  async synthesize(request: VoiceSynthesisRequest): Promise<{ jobId: string }> {
    this.validate(request);
    const existingId = this.idempotency.get(request.idempotencyKey);
    if (existingId) {
      const previous = this.jobs.get(existingId)!.request;
      const fields: (keyof VoiceSynthesisRequest)[] = ["projectId", "actorId", "text", "language", "voiceProfileId", "consentId", "providerId", "modelRevision"];
      if (fields.some((field) => previous[field] !== request[field])) throw new Error("Mock voice idempotency key conflict.");
      return { jobId: existingId };
    }
    const jobId = crypto.randomUUID();
    this.idempotency.set(request.idempotencyKey, jobId);
    this.jobs.set(jobId, { request: { ...request }, cancelled: false });
    return { jobId };
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Mock voice job not found.");
    job.cancelled = true;
  }

  async result(jobId: string): Promise<MediaAsset> { return (await this.wavResult(jobId)).asset; }

  async wavResult(jobId: string): Promise<{ asset: MediaAsset; wav: Uint8Array }> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Mock voice job not found.");
    if (job.cancelled) throw new Error("Mock voice job cancelled.");
    job.result ??= this.render(job);
    const result = await job.result;
    if (job.cancelled) throw new Error("Mock voice job cancelled.");
    return result;
  }

  private validate(request: VoiceSynthesisRequest): void {
    if (!request || request.providerId !== "mock-tone" || request.modelRevision !== "mock-tone-v1" || request.voiceProfileId !== "mock-tone" || request.language !== "und" || !request.projectId || !request.actorId || !request.idempotencyKey || typeof request.text !== "string" || !request.text.trim() || request.text.length > 500 || request.consentId !== undefined) {
      throw new Error("Invalid mock tone request.");
    }
  }

  private async render(job: Job): Promise<{ asset: MediaAsset; wav: Uint8Array }> {
    const sampleRate = 48000;
    const durationSeconds = Math.min(5, Math.max(0.4, Array.from(job.request.text.trim()).length * 0.06));
    const samples = Math.round(sampleRate * durationSeconds);
    const buffer = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buffer);
    const write = (at: number, value: string) => [...value].forEach((character, index) => view.setUint8(at + index, character.charCodeAt(0)));
    write(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); write(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, "data"); view.setUint32(40, samples * 2, true);
    for (let index = 0; index < samples; index++) {
      const fade = Math.min(1, index / 480, (samples - index - 1) / 480);
      view.setInt16(44 + index * 2, Math.round(32767 * 0.12 * fade * Math.sin(2 * Math.PI * 440 * index / sampleRate)), true);
    }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return { wav: new Uint8Array(buffer), asset: { id: `mock-tone:${hash}`, uri: `mock-tone:${hash}`, contentHash: hash, mediaType: "audio/wav", sampleRateHz: sampleRate, durationSeconds: samples / sampleRate, providerId: "mock-tone", modelRevision: "mock-tone-v1", licenseApprovalId: "not-applicable-mock-tone" } };
  }
}
