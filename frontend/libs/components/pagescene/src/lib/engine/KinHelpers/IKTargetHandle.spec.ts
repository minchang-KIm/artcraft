import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Scene, Vector3 } from "three";
import { IKTargetHandle } from "./IKTargetHandle";

describe("IK target handle", () => {
  it("reports world-space movement and removes its objects and listeners", () => {
    const scene = new Scene(), camera = new PerspectiveCamera(), canvas = document.createElement("canvas");
    const remove = vi.spyOn(canvas, "removeEventListener"), move = vi.fn(), drag = vi.fn();
    const handle = new IKTargetHandle(scene, camera, canvas, new Vector3(1, 2, 3), move, drag);
    const marker = scene.children.find(node => node.userData.totalRecallIKHandle)!;
    const control = scene.children.find(node => node.userData.totalRecallIKControl)!;
    marker.position.set(2, 3, 4); control.dispatchEvent({ type: "objectChange" } as never);
    expect(move).toHaveBeenCalledWith(new Vector3(2, 3, 4));
    handle.dispose(); handle.dispose();
    expect(scene.children).toHaveLength(0);
    expect(remove).toHaveBeenCalledWith("pointerdown", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function));
  });
});
