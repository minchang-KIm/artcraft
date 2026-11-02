import { AnimationClip, Bone, Object3D, PropertyBinding, Quaternion, QuaternionKeyframeTrack, Scene } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const MAX_SECONDS = 30;
const MIN_INTERVAL = 1 / 30;

/** Bounded local quaternion samples; times are measured from recording start. */
export class WebcamMotionRecorder {
  private readonly times: number[] = [0];
  private readonly rotations: number[][];
  private last: Quaternion[];
  private lastTimestamp: number;
  constructor(private readonly startMs: number, initial: Quaternion | Quaternion[], private readonly maxSeconds = MAX_SECONDS) {
    const poses = Array.isArray(initial) ? initial : [initial];
    if (!Number.isFinite(startMs) || !poses.length || poses.length > 9 || !poses.every(validQuaternion) || !Number.isFinite(maxSeconds) || maxSeconds < 0.1 || maxSeconds > MAX_SECONDS) throw new Error("Invalid initial pose or recording duration.");
    this.last = poses.map(pose => pose.clone().normalize());
    this.lastTimestamp = startMs;
    this.rotations = this.last.map(pose => pose.toArray());
  }
  sample(timestampMs: number, rotation: Quaternion | Quaternion[]): boolean {
    const poses = Array.isArray(rotation) ? rotation : [rotation];
    if (!Number.isFinite(timestampMs) || poses.length !== this.last.length || !poses.every(validQuaternion)) throw new Error("Invalid recorded pose.");
    const elapsed = (timestampMs - this.startMs) / 1000;
    if (timestampMs <= this.lastTimestamp) throw new Error("Recording timestamps must increase.");
    this.lastTimestamp = timestampMs;
    const time = Math.fround(Math.min(elapsed, this.maxSeconds));
    const previousTime = this.times[this.times.length - 1];
    if (time - previousTime >= MIN_INTERVAL - 1e-6) {
      const next = poses.map((pose, index) => {
        const result = pose.clone().normalize();
        if (this.last[index].dot(result) < 0) result.set(-result.x, -result.y, -result.z, -result.w);
        return result;
      });
      this.times.push(time); next.forEach((pose, index) => this.rotations[index].push(...pose.toArray())); this.last = next;
    }
    return elapsed >= this.maxSeconds;
  }
  data(): { times: number[]; rotations: number[][]; duration: number } {
    const duration = this.times[this.times.length - 1];
    if (this.times.length < 2 || duration < 0.1) throw new Error("Record at least 0.1 seconds of motion.");
    return { times: [...this.times], rotations: this.rotations.map(values => [...values]), duration };
  }
}

function validQuaternion(q: Quaternion): boolean {
  return [q.x, q.y, q.z, q.w].every(Number.isFinite) && q.lengthSq() > 1e-12;
}

/** Export animation-only GLB tracks that bind uniquely to the rig. */
export async function encodeWebcamMotion(character: Object3D, bone: Object3D | Object3D[], recorder: WebcamMotionRecorder): Promise<{ data: ArrayBuffer; duration: number }> {
  const bones = Array.isArray(bone) ? bone : [bone];
  if (!bones.length || bones.length > 9 || new Set(bones).size !== bones.length) throw new Error("Select distinct bones.");
  for (const item of bones) {
    if (!character.getObjectByProperty("uuid", item.uuid) || item.type !== "Bone" || !item.name || PropertyBinding.sanitizeNodeName(item.name) !== item.name) throw new Error("The selected bone needs a glTF-compatible name.");
    let matches = 0;
    character.traverse(node => { if (node.name === item.name) matches++; });
    if (matches !== 1) throw new Error("The selected bone name must be unique in the character.");
  }
  const { times, rotations, duration } = recorder.data();
  if (rotations.length !== bones.length) throw new Error("Recording does not match selected bones.");
  const scene = new Scene();
  const tracks = bones.map((item, index) => {
    const target = new Bone(); target.name = item.name; scene.add(target);
    return new QuaternionKeyframeTrack(`${target.uuid}.quaternion`, times, rotations[index]);
  });
  const clip = new AnimationClip("Webcam motion", duration, tracks);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] });
  if (!(data instanceof ArrayBuffer) || data.byteLength > 50 * 1024 * 1024) throw new Error("Could not encode webcam motion.");
  return { data, duration };
}
