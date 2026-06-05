import * as THREE from 'three';

export const SUPPORTED_MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae'];
export const MODEL_FILE_ACCEPT = SUPPORTED_MODEL_EXTENSIONS.map(ext => `.${ext}`).join(',');
export const MODEL_ASSET_FILE_ACCEPT = `${MODEL_FILE_ACCEPT},.bin,.mtl,.jpg,.jpeg,.png,.webp,.ktx2,.tga,.bmp`;

function getFileExtension(file) {
  return file.name.split('.').pop()?.toLowerCase() || '';
}

function normalizeFiles(input) {
  if (!input) return [];
  if (input instanceof File) return [input];
  return Array.from(input).filter(file => file instanceof File);
}

function filePath(file) {
  return file.webkitRelativePath || file.name;
}

function fileBaseName(path) {
  return path.split(/[\\/]/).pop();
}

function findMainFile(files) {
  if (!files.length) return null;
  if (files.length === 1) return files[0];
  return files.find(file => SUPPORTED_MODEL_EXTENSIONS.includes(getFileExtension(file))) || files[0];
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

function createUrlResolver(files) {
  const urls = new Map();
  const urlByPath = new Map();
  const urlByName = new Map();

  files.forEach(file => {
    const url = URL.createObjectURL(file);
    urls.set(file, url);
    urlByPath.set(filePath(file), url);
    urlByName.set(file.name, url);
  });

  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const clean = decodeURIComponent(url.split('?')[0].split('#')[0]);
    return urlByPath.get(clean) || urlByName.get(fileBaseName(clean)) || url;
  });

  return {
    manager,
    urlFor(file) {
      return urls.get(file);
    },
    revoke() {
      urls.forEach(url => URL.revokeObjectURL(url));
    },
  };
}

export async function loadModelFromFiles(input) {
  const files = normalizeFiles(input);
  const file = findMainFile(files);
  if (!file) throw new Error('No model file selected.');

  const ext = getFileExtension(file);
  if (!SUPPORTED_MODEL_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported 3D format: .${ext || 'unknown'}`);
  }

  const resolver = createUrlResolver(files);
  const url = resolver.urlFor(file);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const result = await new GLTFLoader(resolver.manager).loadAsync(url);
      return { object: result.scene, format: ext };
    }

    if (ext === 'fbx') {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      return { object: await new FBXLoader(resolver.manager).loadAsync(url), format: ext };
    }

    if (ext === 'obj') {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const loader = new OBJLoader(resolver.manager);
      const materialFile = files.find(candidate => getFileExtension(candidate) === 'mtl');
      if (materialFile) {
        const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js');
        const materials = await new MTLLoader(resolver.manager).loadAsync(resolver.urlFor(materialFile));
        materials.preload();
        loader.setMaterials(materials);
      }
      return { object: await loader.loadAsync(url), format: ext };
    }

    if (ext === 'stl') {
      const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
      const geometry = await new STLLoader(resolver.manager).loadAsync(url);
      return { object: geometryToMesh(geometry, file.name.replace(/\.[^.]+$/, '')), format: ext };
    }

    if (ext === 'ply') {
      const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
      const geometry = await new PLYLoader(resolver.manager).loadAsync(url);
      return { object: geometryToMesh(geometry, file.name.replace(/\.[^.]+$/, ''), 0x9ca3af), format: ext };
    }

    if (ext === 'dae') {
      const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');
      const result = await new ColladaLoader(resolver.manager).loadAsync(url);
      return { object: result.scene, format: ext };
    }
  } finally {
    resolver.revoke();
  }
}

export function loadModelFromFile(file) {
  return loadModelFromFiles(file);
}
