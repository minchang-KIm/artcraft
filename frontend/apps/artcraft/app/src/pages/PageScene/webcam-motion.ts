import { AnimationClip, Bone, Object3D, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Scene } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const MAX_SECONDS = 30;
const MIN_INTERVAL = 1 / 30;

/** Bounded local quaternion samples; times are measured from recording start. */
export class WebcamMotionRecorder {
  private readonly times: number[] = [0];
  private readonly rotations: number[];
  private last: Quaternion;
  private lastTimestamp: number;
  constructor(private readonly startMs: number, initial: Quaternion, private readonly maxSeconds = MAX_SECONDS) {
    if (!Number.isFinite(startMs) || !validQuaternion(initial) || !Number.isFinite(maxSeconds) || maxSeconds < 0.1 || maxSeconds > MAX_SECONDS) throw new Error("Invalid initial pose or recording duration.");
    this.last = initial.clone().normalize();
    this.lastTimestamp = startMs;
    this.rotations = this.last.toArray();
  }
  sample(timestampMs: number, rotation: Quaternion): boolean {
    if (!Number.isFinite(timestampMs) || !validQuaternion(rotation)) throw new Error("Invalid recorded pose.");
    const elapsed = (timestampMs - this.startMs) / 1000;
    if (timestampMs <= this.lastTimestamp) throw new Error("Recording timestamps must increase.");
    this.lastTimestamp = timestampMs;
    const time = Math.fround(Math.min(elapsed, this.maxSeconds));
    const previousTime = this.times[this.times.length - 1];
    if (time - previousTime >= MIN_INTERVAL - 1e-6) {
      const next = rotation.clone().normalize();
      if (this.last.dot(next) < 0) next.set(-next.x, -next.y, -next.z, -next.w);
      this.times.push(time); this.rotations.push(...next.toArray()); this.last = next;
    }
    return elapsed >= this.maxSeconds;
  }
  data(): { times: number[]; rotations: number[]; duration: number } {
    const duration = this.times[this.times.length - 1];
    if (this.times.length < 2 || duration < 0.1) throw new Error("Record at least 0.1 seconds of motion.");
    return { times: [...this.times], rotations: [...this.rotations], duration };
  }
}

function validQuaternion(q: Quaternion): boolean {
  return [q.x, q.y, q.z, q.w].every(Number.isFinite) && q.lengthSq() > 1e-12;
}

/** Export an animation-only GLB whose single track binds uniquely to the rig. */
export async function encodeWebcamMotion(character: Object3D, bone: Object3D, recorder: WebcamMotionRecorder): Promise<{ data: ArrayBuffer; duration: number }> {
  if (!character.getObjectByProperty("uuid", bone.uuid) || bone.type !== "Bone" || !bone.name || PropertyBinding.sanitizeNodeName(bone.name) !== bone.name) throw new Error("The selected bone needs a glTF-compatible name.");
  let matches = 0;
  character.traverse(node => { if (node.name === bone.name) matches++; });
  if (matches !== 1) throw new Error("The selected bone name must be unique in the character.");
  const { times, rotations, duration } = recorder.data();
  const target = new Bone(); target.name = bone.name;
  const scene = new Scene(); scene.add(target);
  const clip = new AnimationClip("Webcam motion", duration, [new QuaternionKeyframeTrack(`${target.uuid}.quaternion`, times, rotations)]);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] });
  if (!(data instanceof ArrayBuffer) || data.byteLength > 50 * 1024 * 1024) throw new Error("Could not encode webcam motion.");
  return { data, duration };
}
