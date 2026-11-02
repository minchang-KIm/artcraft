import type { PoseLandmark } from "@storyteller/ui-pagescene";

export const WEBCAM_SEGMENTS = [
  ["Left upper arm", 11, 13], ["Left forearm", 13, 15], ["Right upper arm", 12, 14], ["Right forearm", 14, 16],
  ["Left thigh", 23, 25], ["Left lower leg", 25, 27], ["Right thigh", 24, 26], ["Right lower leg", 26, 28],
  ["Torso", -1, -1],
] as const;

function midpoint(a?: PoseLandmark, b?: PoseLandmark): PoseLandmark | undefined {
  if (!a || !b) return undefined;
  return {
    x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
    presence: Math.min(a.presence ?? 1, b.presence ?? 1),
  };
}

/** Torso follows the direction from the hip midpoint to the shoulder midpoint. */
export function webcamSegmentPoints(points: PoseLandmark[] | null, segment: number): [PoseLandmark | undefined, PoseLandmark | undefined] {
  const definition = WEBCAM_SEGMENTS[segment];
  if (!definition) throw new Error("Invalid webcam segment.");
  if (segment === 8) return [midpoint(points?.[23], points?.[24]), midpoint(points?.[11], points?.[12])];
  return [points?.[definition[1]], points?.[definition[2]]];
}
