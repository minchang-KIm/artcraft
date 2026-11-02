import { describe, expect, it } from "vitest";
import { Bone, Object3D, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { WebcamMotionRecorder, encodeWebcamMotion } from "./webcam-motion";

describe("webcam motion", () => {
  it("exports finite monotonic quaternion samples bound to the selected bone", async () => {
    const root = new Object3D(), bone = new Bone(); bone.name = "LeftArm"; root.add(bone);
    const recorder = new WebcamMotionRecorder(100, new Quaternion());
    recorder.sample(200, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5));
    recorder.sample(400, new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 1));
    const result = await encodeWebcamMotion(root, bone, recorder);
    const loaded = await new GLTFLoader().parseAsync(result.data, "");
    expect(loaded.animations).toHaveLength(1);
    const track = loaded.animations[0].tracks[0];
    expect(track.name).toBe("LeftArm.quaternion");
    expect(Array.from(track.times)).toEqual([0, Math.fround(0.1), Math.fround(0.3)]);
    expect(track.values[track.values.length - 1]).toBeCloseTo(Math.cos(0.5));
  });
  it("bounds sample rates and duration and rejects invalid time or short captures", () => {
    const recorder = new WebcamMotionRecorder(100, new Quaternion());
    recorder.sample(110, new Quaternion());
    expect(() => recorder.sample(109, new Quaternion())).toThrow();
    expect(() => recorder.data()).toThrow();
    expect(recorder.sample(40000, new Quaternion())).toBe(true);
    expect(recorder.data().duration).toBe(30);
    const short = new WebcamMotionRecorder(0, new Quaternion(), 2);
    expect(short.sample(2500, new Quaternion())).toBe(true);
    expect(short.data().duration).toBe(2);
  });
  it("rejects ambiguous or unbindable bone names", async () => {
    const root = new Object3D(), first = new Bone(), second = new Bone();
    first.name = second.name = "Bone"; root.add(first, second);
    const recorder = new WebcamMotionRecorder(0, new Quaternion()); recorder.sample(200, new Quaternion());
    await expect(encodeWebcamMotion(root, first, recorder)).rejects.toThrow(/unique/);
    first.name = "bad.bone";
    await expect(encodeWebcamMotion(root, first, recorder)).rejects.toThrow(/compatible/);
  });
  it("writes synchronized tracks for distinct bones and rejects partial samples", async () => {
    const root = new Object3D(), upper = new Bone(), lower = new Bone();
    upper.name = "UpperArm"; lower.name = "Forearm"; root.add(upper); upper.add(lower);
    const recorder = new WebcamMotionRecorder(0, [new Quaternion(), new Quaternion()]);
    expect(() => recorder.sample(100, [new Quaternion()])).toThrow(/recorded pose/);
    recorder.sample(100, [new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.4), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.8)]);
    const { data } = await encodeWebcamMotion(root, [upper, lower], recorder);
    const loaded = await new GLTFLoader().parseAsync(data, "");
    expect(loaded.animations[0].tracks.map(track => track.name)).toEqual(["UpperArm.quaternion", "Forearm.quaternion"]);
    for (const track of loaded.animations[0].tracks) expect(Array.from(track.times)).toEqual([0, Math.fround(0.1)]);
    await expect(encodeWebcamMotion(root, [upper, upper], recorder)).rejects.toThrow(/distinct/);
  });
});
