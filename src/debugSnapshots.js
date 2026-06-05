export function vectorSnapshot(v) {
  return { x: v.x, y: v.y, z: v.z };
}

export function objectDebugSnapshot(obj, center) {
  return {
    name: obj.name,
    type: obj.userData?.type || null,
    format: obj.userData?.format || null,
    position: vectorSnapshot(obj.position),
    rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
    scale: vectorSnapshot(obj.scale),
    center: vectorSnapshot(center),
  };
}
