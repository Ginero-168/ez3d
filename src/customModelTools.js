import * as THREE from 'three';
import { SUPPORTED_MODEL_EXTENSIONS } from './modelLoaders.js';

export function normalizeModelInput(input) {
  if (!input) return [];
  if (input instanceof File) return [input];
  return Array.from(input).filter(file => file instanceof File);
}

export function modelFileExtension(file) {
  return file?.name?.split('.').pop()?.toLowerCase() || '';
}

export function findMainModelFile(files) {
  return files.find(file => SUPPORTED_MODEL_EXTENSIONS.includes(modelFileExtension(file))) || files[0] || null;
}

export function modelDisplayName(file) {
  return file.name.replace(/\.[^.]+$/, '');
}

export function prepareCustomModel(model, file, format) {
  model.traverse(child => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  if (size.length() === 0) {
    throw new Error('Model has no renderable geometry.');
  }

  model.position.x = -center.x;
  model.position.z = -center.z;
  model.position.y = -box.min.y;

  const wrapper = new THREE.Group();
  wrapper.add(model);
  wrapper.name = modelDisplayName(file);
  wrapper.userData = {
    type: 'custom',
    category: 'prop',
    format,
    baseDims: { w: size.x, h: size.y, d: size.z },
  };

  return wrapper;
}
