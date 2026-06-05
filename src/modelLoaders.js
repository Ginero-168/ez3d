import * as THREE from 'three';

export const SUPPORTED_MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae'];
export const MODEL_FILE_ACCEPT = SUPPORTED_MODEL_EXTENSIONS.map(ext => `.${ext}`).join(',');

function getFileExtension(file) {
  return file.name.split('.').pop()?.toLowerCase() || '';
}

function geometryToMesh(geometry, name, color = 0x94a3b8) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  return mesh;
}

export async function loadModelFromFile(file) {
  const ext = getFileExtension(file);
  if (!SUPPORTED_MODEL_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported 3D format: .${ext || 'unknown'}`);
  }

  const url = URL.createObjectURL(file);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const result = await new GLTFLoader().loadAsync(url);
      return { object: result.scene, format: ext };
    }

    if (ext === 'fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return { object: await new FBXLoader().loadAsync(url), format: ext };
    }

    if (ext === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      return { object: await new OBJLoader().loadAsync(url), format: ext };
    }

    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geometry = await new STLLoader().loadAsync(url);
      return { object: geometryToMesh(geometry, file.name.replace(/\.[^.]+$/, '')), format: ext };
    }

    if (ext === 'ply') {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geometry = await new PLYLoader().loadAsync(url);
      return { object: geometryToMesh(geometry, file.name.replace(/\.[^.]+$/, ''), 0x9ca3af), format: ext };
    }

    if (ext === 'dae') {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      const result = await new ColladaLoader().loadAsync(url);
      return { object: result.scene, format: ext };
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
