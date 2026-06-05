export function disposeMaterial(material) {
  if (!material) return;
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach(mat => {
    Object.values(mat).forEach(value => {
      if (value?.isTexture) value.dispose?.();
    });
    mat.dispose?.();
  });
}

export function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse?.(child => {
    child.geometry?.dispose?.();
    disposeMaterial(child.material);
  });
}
