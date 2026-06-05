import * as THREE from 'three';

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Texture image failed to load.'));
      image.src = event.target.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function applyTextureToObject(obj, texture) {
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;

  if (Array.isArray(obj.material)) {
    if (obj.material[4]) {
      obj.material[4].map = texture;
      obj.material[4].needsUpdate = true;
    }
    return;
  }

  if (obj.material) {
    obj.material.map = texture;
    obj.material.needsUpdate = true;
  }
}

export async function applyTextureFileToObject(obj, file) {
  if (!obj || !file) return null;
  const image = await fileToImage(file);
  const texture = new THREE.Texture(image);
  texture.needsUpdate = true;
  applyTextureToObject(obj, texture);
  return texture;
}
