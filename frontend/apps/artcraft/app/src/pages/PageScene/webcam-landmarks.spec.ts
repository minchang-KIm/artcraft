import { describe, expect, it } from "vitest";
import { webcamSecondaryAxis, webcamSegmentPoints } from "./webcam-landmarks";

describe("webcam body segments", () => {
  it("uses hip and shoulder midpoints and the weakest endpoint confidence", () => {
    const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 1, presence: 1 }));
    points[23] = { x: -2, y: 2, z: 0, visibility: 0.7, presence: 0.9 };
    points[24] = { x: 2, y: 2, z: 2, visibility: 0.8, presence: 0.8 };
    points[11] = { x: -1, y: 0, z: -1, visibility: 0.9, presence: 0.7 };
    points[12] = { x: 3, y: 0, z: 1, visibility: 0.6, presence: 0.9 };
    expect(webcamSegmentPoints(points, 8)).toEqual([{ x: 0, y: 2, z: 1, visibility: 0.7, presence: 0.8 }, { x: 1, y: 0, z: 0, visibility: 0.6, presence: 0.7 }]);
    expect(webcamSegmentPoints(points, 0)).toEqual([points[11], points[13]]);
    expect(webcamSecondaryAxis(points, 8)).toEqual([points[11], points[12]]);
    expect(webcamSecondaryAxis(null, 8)).toEqual([undefined, undefined]);
    expect(webcamSecondaryAxis(points, 0)).toBeUndefined();
    expect(webcamSegmentPoints(null, 8)).toEqual([undefined, undefined]);
    expect(() => webcamSegmentPoints(points, 9)).toThrow();
  });
});
