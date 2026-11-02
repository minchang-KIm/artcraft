import { Quaternion, Vector3 } from "three";

/** A camera-space MediaPipe world landmark. */
export type PoseLandmark = { x: number; y: number; z: number; visibility?: number; presence?: number };
export type TrackingLossOptions = { timestampMs: number; mode: "hold" | "fade"; holdMs?: number; fadeMs?: number };
export type TrackingState = "tracking" | "holding" | "fading" | "lost";

const finiteQuaternion = (q: Quaternion) => [q.x, q.y, q.z, q.w].every(Number.isFinite) && q.lengthSq() > 1e-12;

function direction(a: PoseLandmark, b: PoseLandmark, camera: Quaternion, mirror: boolean, confidence: number): Vector3 | null {
  for (const p of [a, b]) {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite) ||
        (p.visibility !== undefined && (!Number.isFinite(p.visibility) || p.visibility < confidence)) ||
        (p.presence !== undefined && (!Number.isFinite(p.presence) || p.presence < confidence))) return null;
  }
  // MediaPipe uses x right, y down and z away; Three's camera looks down -Z.
  const vector = new Vector3((b.x - a.x) * (mirror ? -1 : 1), a.y - b.y, a.z - b.z);
  if (vector.lengthSq() < 1e-10) return null;
  return vector.normalize().applyQuaternion(camera);
}

/**
 * Calibrates one selected bone against an observed limb direction. Only the
 * returned local quaternion should be applied; other bones remain untouched.
 * A direction alone cannot determine axial twist, so it preserves the
 * calibration's twist rather than claiming a full-body retarget.
 */
export class LandmarkBoneRetarget {
  private readonly baseline: Vector3;
  private readonly calibratedWorld: Quaternion;
  private readonly camera: Quaternion;
  private readonly calibratedLocal: Quaternion;
  private lastLocal: Quaternion;
  private lostAt: number | null = null;
  private lostPose: Quaternion | null = null;
  private lastTimestamp: number | null = null;
  private state: TrackingState = "tracking";

  constructor(a: PoseLandmark, b: PoseLandmark, camera: Quaternion, parentWorld: Quaternion,
    local: Quaternion, private readonly mirror = false, private readonly confidence = 0.5) {
    if (![camera, parentWorld, local].every(finiteQuaternion) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Invalid pose calibration");
    this.camera = camera.clone().normalize();
    const baseline = direction(a, b, this.camera, mirror, confidence);
    if (!baseline) throw new Error("Pose calibration needs two confident, distinct landmarks");
    this.baseline = baseline;
    this.lastLocal = local.clone().normalize();
    this.calibratedLocal = this.lastLocal.clone();
    this.calibratedWorld = parentWorld.clone().normalize().multiply(this.lastLocal);
  }

  getTrackingState(): TrackingState { return this.state; }

  /** Missing observations hold, or fade from the last pose to calibration. */
  update(a: PoseLandmark, b: PoseLandmark, parentWorld: Quaternion, smoothing = 0.35, maxRadians = Math.PI / 2, loss?: TrackingLossOptions): Quaternion {
    if (!finiteQuaternion(parentWorld) || !Number.isFinite(smoothing) || smoothing < 0 || smoothing > 1 ||
        !Number.isFinite(maxRadians) || maxRadians < 0 || maxRadians > Math.PI) throw new Error("Invalid pose update");
    if (loss && (!Number.isFinite(loss.timestampMs) || loss.timestampMs < 0 ||
      (this.lastTimestamp !== null && loss.timestampMs <= this.lastTimestamp) ||
      !["hold", "fade"].includes(loss.mode) || !Number.isFinite(loss.holdMs ?? 500) || (loss.holdMs ?? 500) < 0 ||
      !Number.isFinite(loss.fadeMs ?? 1000) || (loss.fadeMs ?? 1000) <= 0)) throw new Error("Invalid tracking loss settings");
    if (loss) this.lastTimestamp = loss.timestampMs;
    const observed = direction(a, b, this.camera, this.mirror, this.confidence);
    if (!observed) {
      if (!loss || loss.mode === "hold") { this.lostAt = null; this.lostPose = null; this.state = "holding"; return this.lastLocal.clone(); }
      if (this.lostAt === null) { this.lostAt = loss.timestampMs; this.lostPose = this.lastLocal.clone(); }
      const elapsed = loss.timestampMs - this.lostAt;
      const alpha = Math.min(1, Math.max(0, (elapsed - (loss.holdMs ?? 500)) / (loss.fadeMs ?? 1000)));
      this.state = alpha >= 1 ? "lost" : alpha > 0 ? "fading" : "holding";
      this.lastLocal.copy(this.lostPose!).slerp(this.calibratedLocal, alpha).normalize();
      return this.lastLocal.clone();
    }
    this.lostAt = null;
    this.lostPose = null;
    this.state = "tracking";
    const delta = new Quaternion().setFromUnitVectors(this.baseline, observed);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(delta.w)));
    if (angle > maxRadians) delta.identity().slerp(new Quaternion().setFromUnitVectors(this.baseline, observed), maxRadians / angle);
    const target = parentWorld.clone().normalize().invert().multiply(delta).multiply(this.calibratedWorld).normalize();
    this.lastLocal.slerp(target, smoothing).normalize();
    return this.lastLocal.clone();
  }
}
