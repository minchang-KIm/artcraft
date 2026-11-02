import { Object3D, ObjectLoader } from "three";

export class BoneJSONHelper {

  model: Object3D;

  constructor(model: Object3D) {
    this.model = model;
  }

  private findHipBone(objectGroup: Object3D[]): Object3D | undefined {
    let hipBone = undefined;
    for (const child of objectGroup) {
      if (child.type === "Bone" && child.name.toLowerCase().includes("mixamorighips")) {
        hipBone = child;
        break;
      }
    }

    return hipBone;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public toJSON(): any {
    if (!this.model.userData.isCharacter) {
      return;
    }

    if (this.model.children.length < 1) {
      return undefined;
    }

    // Find the hip bone
    const hipBone = this.findHipBone(this.model.children[0].children);

    if (!hipBone) {
      // Non-Mixamo rigs (including MHR) still need their local pose saved.
      // Child paths disambiguate duplicate names and are checked on restore.
      const bones: Array<{ path: number[]; name: string; position: number[]; quaternion: number[]; scale: number[] }> = [];
      const visit = (node: Object3D, path: number[]) => {
        if (node.type === "Bone") bones.push({
          path, name: node.name, position: node.position.toArray(),
          quaternion: node.quaternion.toArray(), scale: node.scale.toArray(),
        });
        node.children.forEach((child, index) => visit(child, [...path, index]));
      };
      visit(this.model, []);
      return bones.length ? { format: "local-bones-v1", bones } : undefined;
    }

    return hipBone.toJSON();
  }

  /* Applies the bone tree in a recursive BFS manner */
  private applyBoneTree(hipBone: Object3D, boneTree: Object3D): void {
    hipBone.position.copy(boneTree.position);
    hipBone.quaternion.copy(boneTree.quaternion);
    hipBone.scale.copy(boneTree.scale);

    const hipChildren = hipBone.children;
    const treeChildren = boneTree.children;

    // NOTE: Assumption made that the lengths match!
    // This shouldn't be a problem unless the skeletal model is changed
    for (let i = 0; i < hipChildren.length; i++) {
      const hipChild = hipChildren[i];
      const treeChild = treeChildren[i];
      if (hipChild && treeChild) {
        this.applyBoneTree(hipChild, treeChild);
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public poseFromBoneJSON(boneJSON: any, options: { rotationsOnly?: boolean } = {}): boolean {
    if (boneJSON?.format === "local-bones-v1") {
      if (!Array.isArray(boneJSON.bones)) return false;
      const restored: Array<{ node: Object3D; position: number[]; quaternion: number[]; scale: number[] }> = [];
      const vector = (value: unknown, size: number): value is number[] =>
        Array.isArray(value) && value.length === size && value.every((v) => typeof v === "number" && Number.isFinite(v));
      const paths = new Set<string>();
      for (const item of boneJSON.bones) {
        if (!item || !Array.isArray(item.path) || !item.path.every((v: unknown) => Number.isInteger(v) && (v as number) >= 0) ||
          !vector(item.position, 3) || !vector(item.quaternion, 4) || !vector(item.scale, 3) ||
          item.quaternion.every((v: number) => v === 0)) return false;
        const key = item.path.join("/");
        if (paths.has(key)) return false;
        paths.add(key);
        let node: Object3D | undefined = this.model;
        for (const index of item.path) node = node?.children[index];
        if (!node || node.type !== "Bone" || node.name !== item.name) return false;
        restored.push({ node, position: item.position, quaternion: item.quaternion, scale: item.scale });
      }
      let count = 0;
      this.model.traverse((node) => { if (node.type === "Bone") count += 1; });
      if (restored.length !== count || count === 0) return false;
      for (const item of restored) {
        if (!options.rotationsOnly) item.node.position.fromArray(item.position);
        item.node.quaternion.fromArray(item.quaternion);
        if (!options.rotationsOnly) item.node.scale.fromArray(item.scale);
      }
      this.model.updateMatrixWorld(true);
      return true;
    }
    if (options.rotationsOnly || !this.model.children[0]) return false;
    const hipBone = this.findHipBone(this.model.children[0].children);
    if (!hipBone) return false;

    const loader = new ObjectLoader();
    const boneTree = loader.parse(boneJSON);
    this.applyBoneTree(hipBone, boneTree);
    return true;
  }

}
