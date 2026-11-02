import { Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, SphereGeometry, Vector3 } from "three";
import { TransformControls } from "../TransformControls.js";

/** Temporary world-space IK target. The caller owns pose and history. */
export class IKTargetHandle {
  private readonly marker: Mesh;
  private readonly control: TransformControls;
  private disposed = false;

  constructor(private readonly scene: Scene, camera: PerspectiveCamera, canvas: HTMLElement, initial: Vector3,
    onMove: (target: Vector3) => void, onDrag: (dragging: boolean) => void) {
    this.marker = new Mesh(new SphereGeometry(0.035, 12, 8), new MeshBasicMaterial({ color: 0x00ffff, depthTest: false }));
    this.marker.userData.totalRecallIKHandle = true;
    this.marker.renderOrder = 1000;
    this.marker.position.copy(initial);
    this.control = new TransformControls(camera, canvas);
    this.control.userData.totalRecallIKControl = true;
    this.control.setMode("translate");
    this.control.setSpace("world");
    this.control.setSize(0.7);
    this.control.addEventListener("objectChange", () => onMove(this.marker.position.clone()));
    this.control.addEventListener("dragging-changed", event => onDrag((event as unknown as { value: boolean }).value));
    this.scene.add(this.marker, this.control);
    this.control.attach(this.marker);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.control.detach();
    this.scene.remove(this.control, this.marker);
    this.control.dispose();
    this.marker.geometry.dispose();
    (this.marker.material as MeshBasicMaterial).dispose();
  }
}
