import type { SceneAudioClip } from "../../../../../../../../../contracts/scene-audio";

/** Plays only local scene audio under the 3D timeline's transport. */
export class SceneAudioPreview {
  private context: AudioContext | null = null;
  private clips: SceneAudioClip[] = [];
  private playhead = 0;
  private playing = false;
  private disposed = false;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private failed = new Set<string>();
  private waiting = new Map<string, Promise<AudioBuffer>>();
  private sources = new Map<string, { source: AudioBufferSourceNode; at: number; playhead: number; mediaId: string; start: number }>();

  constructor(
    private readonly load: (id: string) => Promise<ArrayBuffer>,
    private readonly onError: (message: string) => void,
    private readonly createContext: () => AudioContext = () => new AudioContext(),
  ) {}

  // Must be called directly from a user gesture, before the first await.
  async enable(): Promise<void> {
    if (this.disposed) throw new Error("Audio preview is closed.");
    const context = this.context ?? this.createContext();
    this.context = context;
    try {
      await context.resume();
      if (this.disposed || this.context !== context) return;
      if (context.state !== "running") throw new Error("Audio output could not be enabled.");
      this.sync(this.playhead, this.playing);
    } catch (error) {
      if (this.context === context) this.disable();
      throw error;
    }
  }

  disable(): void {
    for (const id of this.sources.keys()) this.stop(id);
    this.buffers.clear();
    this.waiting.clear();
    this.failed.clear();
    const context = this.context;
    this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.disable();
  }

  setClips(clips: SceneAudioClip[]): void {
    this.clips = clips;
    this.failed.clear();
    this.sync(this.playhead, this.playing);
  }

  sync(playhead: number, playing: boolean): void {
    this.playhead = playhead;
    this.playing = playing;
    const context = this.context;
    if (!context || this.disposed) return;
    const active = playing && context.state === "running" ? this.clips.filter(c => playhead >= c.start && playhead < c.start + c.duration) : [];
    const activeIds = new Set(active.map(c => c.id));
    const activeMedia = new Set(active.map(c => c.mediaId));
    for (const id of this.sources.keys()) if (!activeIds.has(id)) this.stop(id);
    // Do not retain decoded audio after it leaves the active interval.
    for (const id of this.buffers.keys()) if (!activeMedia.has(id)) this.buffers.delete(id);
    for (const clip of active) {
      const current = this.sources.get(clip.id);
      if (current && (current.mediaId !== clip.mediaId || current.start !== clip.start || Math.abs(current.playhead + context.currentTime - current.at - playhead) > 0.15)) this.stop(clip.id);
      if (this.sources.has(clip.id) || this.failed.has(clip.mediaId)) continue;
      let pending = this.buffers.get(clip.mediaId);
      if (!pending) {
        pending = this.load(clip.mediaId).then(bytes => context.decodeAudioData(bytes));
        this.buffers.set(clip.mediaId, pending);
      }
      const request = pending;
      if (this.waiting.get(clip.id) === request) continue;
      this.waiting.set(clip.id, request);
      void request.then(buffer => {
        if (this.context !== context || this.buffers.get(clip.mediaId) !== request || this.disposed || !this.playing || this.sources.has(clip.id)) return;
        const latest = this.clips.find(item => item.id === clip.id && item.mediaId === clip.mediaId);
        if (!latest || this.playhead < latest.start || this.playhead >= latest.start + latest.duration) return;
        const offset = this.playhead - latest.start;
        if (offset >= buffer.duration) return;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        try {
          source.start(0, offset);
          this.sources.set(latest.id, { source, at: context.currentTime, playhead: this.playhead, mediaId: latest.mediaId, start: latest.start });
        } catch (error) {
          source.disconnect();
          throw error;
        }
      }).catch(error => {
        if (this.context !== context || this.buffers.get(clip.mediaId) !== request || this.failed.has(clip.mediaId)) return;
        this.buffers.delete(clip.mediaId);
        this.failed.add(clip.mediaId);
        this.onError(`Scene audio preview failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        if (this.waiting.get(clip.id) === request) this.waiting.delete(clip.id);
      });
    }
  }

  private stop(id: string): void {
    const playing = this.sources.get(id);
    if (!playing) return;
    this.sources.delete(id);
    try { playing.source.stop(); } catch { /* It may have already ended. */ }
    playing.source.disconnect();
  }
}
