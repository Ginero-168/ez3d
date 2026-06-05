import * as THREE from 'three';

export function getSelectionCenter(targets) {
  const box = new THREE.Box3();
  targets.forEach(obj => {
    obj.updateMatrixWorld(true);
    box.expandByObject(obj);
  });
  const center = new THREE.Vector3();
  if (box.isEmpty()) return center;
  box.getCenter(center);
  return center;
}

export function captureAnchorTransformStarts(selectionAnchor, targets) {
  if (!selectionAnchor || !targets.length) return null;
  selectionAnchor.updateMatrixWorld(true);
  return {
    anchorStartMatrix: selectionAnchor.matrixWorld.clone(),
    targetStarts: targets.map(obj => {
      obj.updateMatrixWorld(true);
      const parentInv = new THREE.Matrix4();
      if (obj.parent) {
        obj.parent.updateMatrixWorld(true);
        parentInv.copy(obj.parent.matrixWorld).invert();
      }
      return {
        obj,
        matrixWorld: obj.matrixWorld.clone(),
        parentInv,
      };
    }),
  };
}

export function applyAnchorDeltaToSelection(selectionAnchor, anchorStartMatrix, targetStarts) {
  if (!selectionAnchor || !anchorStartMatrix || !targetStarts.length) return;
  selectionAnchor.updateMatrixWorld(true);
  const delta = new THREE.Matrix4().multiplyMatrices(
    selectionAnchor.matrixWorld,
    new THREE.Matrix4().copy(anchorStartMatrix).invert()
  );
  targetStarts.forEach(start => {
    const nextWorld = new THREE.Matrix4().multiplyMatrices(delta, start.matrixWorld);
    const nextLocal = new THREE.Matrix4().multiplyMatrices(start.parentInv, nextWorld);
    nextLocal.decompose(start.obj.position, start.obj.quaternion, start.obj.scale);
    if (start.obj.userData.outlineHelper) start.obj.userData.outlineHelper.update();
  });
}
