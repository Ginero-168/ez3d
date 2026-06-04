import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clearAutosaveDraftStorage, readAutosaveDraft, writeAutosaveDraft } from './src/autosaveStorage.js';
import { objectDebugSnapshot, vectorSnapshot } from './src/debugSnapshots.js';
import { LIGHT_LAYER_ICONS, OBJECT_LAYER_ICONS } from './src/layerIcons.js';
import './styles.css';

// Ez3d — Exhibition Space 3D Mockup Studio
// v3.0 — Command Pattern Undo/Redo · Full Lighting System · Auto-rotate
// ═══════════════════════════════════════════════════════════════════════

// ─── Core Variables ──────────────────────────────────────────────────────
let scene, camera, renderer, controls, transformControls, gridHelper, boundsLine;
let draggableObjects = [];
let floorTiles = [];
let floorTilesMesh = null;
let selectedObject = null;
let selectedObjects = [];
let tempTransformGroup = null;
let selectionAnchor = null;
let _anchorStartMatrix = null;
let _anchorTargetStarts = [];
let proposalModeActive = false;
let commentPinModeActive = false;
let commentPins = [];
let _pinId = 0;
let cameraTweenId = null;
let turboModeEnabled = false;
let selectedLight = null;
let isDragging = false;
let _isGizmoDragging = false;
let _pendingScenePick = null;
let plane;
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();
const dragOffset = new THREE.Vector3();

// ─── Lights System ────────────────────────────────────────────────────────
let sceneLights  = [];   // { id, type, name, light, helper, marker, targetMarker }
let lightMarkers = [];   // invisible spheres for raycasting
let _lightId     = 0;

// ─── Undo / Redo (Command Pattern) ────────────────────────────────────────
let _undoStack = [];
let _redoStack = [];
const MAX_UNDO = 50;
let _dragStart = null; // {obj|entry, pos, rot, scl} recorded at pointerdown
let _multiDragStart = [];

// ─── App State ────────────────────────────────────────────────────────────
let currentMode         = 'objects';
let activeCarpetBrushColor = '#374151';
let spaceWidth  = 15;
let spaceLength = 15;
let gridSnapSize    = 0.5;
let gridSnapEnabled = true;
let isLightMode     = false;
let autoRotateEnabled = false;
let guidesVisible   = true;
let _tilePaintBatch = []; // group tile paints into one undo entry
let _activeLightUndo = null;
const AUTOSAVE_DEBOUNCE_MS = 700;
let _autosaveTimer = null;
let _suspendAutosave = false;

// ─── Base physical dimensions at scale(1,1,1) in meters ───────────────────
const BASE_DIMS = {
    backdrop:  { w: 1,   h: 2.5,  d: 0.15 },
    table:     { w: 1.5, h: 0.76, d: 0.75 },
    bookshelf: { w: 1.4, h: 1.0,  d: 1.0  },
    cashier:   { w: 1.0, h: 0.95, d: 0.85 },
    rollup:    { w: 0.8, h: 2.0,  d: 0.05 },
};

// (No procedural texture presets in v4.0)

// ══════════════════════════════════════════════════════════════════════════
// COMMAND PATTERN — UNDO / REDO
// ══════════════════════════════════════════════════════════════════════════
function _pushCmd(cmd) {
    _undoStack.push(cmd);
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    _redoStack = [];
    _refreshUndoRedo();
    _queueAutosave();
}

function undo() {
    if (!_undoStack.length) return;
    const cmd = _undoStack.pop();
    cmd.undo();
    _redoStack.push(cmd);
    _refreshUndoRedo();
    _queueAutosave();
}

function redo() {
    if (!_redoStack.length) return;
    const cmd = _redoStack.pop();
    cmd.redo();
    _undoStack.push(cmd);
    _refreshUndoRedo();
    _queueAutosave();
}

function _refreshUndoRedo() {
    const u = document.getElementById('btn-undo');
    const r = document.getElementById('btn-redo');
    if (u) u.disabled = _undoStack.length === 0;
    if (r) r.disabled = _redoStack.length === 0;
}

// Command: Add Object
function _cmdAddObject(obj) {
    _pushCmd({
        undo() { _removeFromScene(obj); updateLayerList(); },
        redo() { _addToScene(obj);     updateLayerList(); }
    });
}

// Command: Remove Object
function _cmdRemoveObject(obj) {
    const idx = draggableObjects.indexOf(obj);
    _pushCmd({
        undo() { _addToScene(obj, idx);  if (selectedObject === null) selectObject(obj); updateLayerList(); },
        redo() { _removeFromScene(obj);  updateLayerList(); }
    });
}

// Command: Transform (called on pointerUp after drag / input change)
function _recordDragStart(obj) {
    if (!obj) return;
    _dragStart = {
        obj,
        pos: obj.position.clone(),
        rot: new THREE.Euler(obj.rotation.x, obj.rotation.y, obj.rotation.z, obj.rotation.order),
        scl: obj.scale.clone(),
    };
    _multiDragStart = selectedObjects.map(o => {
        o.updateMatrixWorld(true);
        const pos = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const scl = new THREE.Vector3();
        o.matrixWorld.decompose(pos, q, scl);
        return {
            obj: o,
            pos,
            q,
            scl
        };
    });
}

function _commitDrag() {
    if (selectedObjects.length > 1) {
        if (!_multiDragStart.length) return;
        let hasChanged = false;
        const newStates = selectedObjects.map(o => {
            o.updateMatrixWorld(true);
            const start = _multiDragStart.find(s => s.obj === o);
            const pos = new THREE.Vector3();
            const q = new THREE.Quaternion();
            const scl = new THREE.Vector3();
            o.matrixWorld.decompose(pos, q, scl);
            
            if (start) {
                if (start.pos.distanceTo(pos) > 0.001 || start.scl.distanceTo(scl) > 0.001 ||
                    start.q.angleTo(q) > 0.001) {
                    hasChanged = true;
                }
            }
            return { obj: o, pos, q, scl };
        });
        const oldStates = [..._multiDragStart];
        _multiDragStart = [];
        _dragStart = null;
        if (!hasChanged) return;
        
        _pushCmd({
            undo() {
                _destroyTempTransformGroup();
                oldStates.forEach(s => {
                    s.obj.position.copy(s.pos);
                    s.obj.quaternion.copy(s.q);
                    s.obj.scale.copy(s.scl);
                });
                _syncSelectionAnchor();
                syncTransformPanel();
            },
            redo() {
                _destroyTempTransformGroup();
                newStates.forEach(s => {
                    s.obj.position.copy(s.pos);
                    s.obj.quaternion.copy(s.q);
                    s.obj.scale.copy(s.scl);
                });
                _syncSelectionAnchor();
                syncTransformPanel();
            }
        });
        return;
    }

    if (!_dragStart) return;
    const { obj, pos, rot, scl } = _dragStart;
    _dragStart = null;
    const newPos = obj.position.clone();
    const newRot = new THREE.Euler(obj.rotation.x, obj.rotation.y, obj.rotation.z, obj.rotation.order);
    const newScl = obj.scale.clone();
    if (pos.distanceTo(newPos) < 0.001 && scl.distanceTo(newScl) < 0.001 &&
        Math.abs(rot.x - newRot.x) < 0.001 &&
        Math.abs(rot.y - newRot.y) < 0.001 &&
        Math.abs(rot.z - newRot.z) < 0.001) return; // no meaningful change
    _pushCmd({
        undo() { obj.position.copy(pos); obj.rotation.copy(rot); obj.scale.copy(scl); if (selectedObject === obj) { _syncSelectionAnchor(); syncTransformPanel(); } },
        redo() { obj.position.copy(newPos); obj.rotation.copy(newRot); obj.scale.copy(newScl); if (selectedObject === obj) { _syncSelectionAnchor(); syncTransformPanel(); } }
    });
}

// Command: Light property change
function _cmdLightProp(entry, prevProps, newProps) {
    _pushCmd({
        undo() { _applyLightProps(entry, prevProps); syncLightPanel(); },
        redo() { _applyLightProps(entry, newProps);  syncLightPanel(); }
    });
}

function _setTileColor(idx, hexColor) {
    if (!floorTilesMesh) return;
    const color = new THREE.Color(hexColor);
    floorTilesMesh.setColorAt(idx, color);
    if (floorTiles[idx]) {
        floorTiles[idx].color = hexColor;
    }
}

// Command: Tile paint batch
function _commitTileBatch() {
    if (!_tilePaintBatch.length) return;
    const batch = [..._tilePaintBatch];
    _tilePaintBatch = [];
    _pushCmd({
        undo() {
            batch.forEach(b => {
                _setTileColor(b.idx, b.prevColor);
            });
            if (floorTilesMesh && floorTilesMesh.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
        },
        redo() {
            batch.forEach(b => {
                _setTileColor(b.idx, b.nextColor);
            });
            if (floorTilesMesh && floorTilesMesh.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
        }
    });
}

function _addToScene(obj, idx) {
    if (idx !== undefined) draggableObjects.splice(idx, 0, obj);
    else draggableObjects.push(obj);
    scene.add(obj);
}

function _removeFromScene(obj) {
    const idx = draggableObjects.indexOf(obj);
    if (idx > -1) draggableObjects.splice(idx, 1);
    if (obj.userData.outlineHelper) { scene.remove(obj.userData.outlineHelper); delete obj.userData.outlineHelper; }
    scene.remove(obj);
    if (selectedObject === obj) {
        deselectObject();
    }
}

// ══════════════════════════════════════════════════════════════════════════
// SETUP MODAL
// ══════════════════════════════════════════════════════════════════════════
function submitDimensions() {
    let w = parseInt(document.getElementById('input-width').value)  || 15;
    let l = parseInt(document.getElementById('input-length').value) || 15;
    w = Math.max(1, w);
    l = Math.max(1, l);
    spaceWidth  = w;
    spaceLength = l;

    document.getElementById('ui-current-dimensions').innerText = `${w} × ${l} ม.`;
    document.getElementById('ui-tile-count').innerText = `${w * l}`;
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('main-ui').classList.remove('hidden');
    init3D(w, l);
    _maybePromptAutosaveRestore();
    _queueAutosave();
}

// ══════════════════════════════════════════════════════════════════════════
// 3D ENGINE INIT
// ══════════════════════════════════════════════════════════════════════════
function init3D(W, L) {
    // WebGL support check
    try {
        const tempCanvas = document.createElement('canvas');
        const supportsWebGL = !!(window.WebGLRenderingContext && (tempCanvas.getContext('webgl') || tempCanvas.getContext('experimental-webgl')));
        if (!supportsWebGL) {
            const errOverlay = document.getElementById('webgl-error-overlay');
            if (errOverlay) errOverlay.classList.remove('hidden');
            return;
        }
    } catch (e) {
        const errOverlay = document.getElementById('webgl-error-overlay');
        if (errOverlay) errOverlay.classList.remove('hidden');
        return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0b0d);
    scene.fog = new THREE.FogExp2(0x0a0b0d, 0.012);

    camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);

    const canvas = document.getElementById('canvas3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(innerWidth, innerHeight);
    
    // Optimize DPR for mobile to ensure high frame rates
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    renderer.setPixelRatio(isMobile ? 1 : Math.min(window.devicePixelRatio, 2));
    
    renderer.shadowMap.enabled  = true;
    renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
    // Research-backed: ACES tone mapping gives cinematic quality for exhibition scenes
    renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping   = true;
    controls.dampingFactor   = 0.05;
    controls.maxPolarAngle   = Math.PI / 2 - 0.01;
    controls.minDistance     = 2;
    controls.maxDistance     = 150;
    controls.autoRotateSpeed = 1.5;

    setCameraAngle('isometric_left');

    // Invisible drag plane
    const pg = new THREE.PlaneGeometry(200, 200);
    pg.rotateX(-Math.PI / 2);
    plane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(plane);

    // Grid (150 size, 150 divisions = 1m spacing)
    gridHelper = new THREE.GridHelper(150, 150, 0x1a2030, 0x0f1520);
    gridHelper.position.x = (W % 2 !== 0) ? 0.5 : 0.0;
    gridHelper.position.y = -0.02;
    gridHelper.position.z = (L % 2 !== 0) ? 0.5 : 0.0;
    gridHelper.visible = guidesVisible;
    scene.add(gridHelper);

    // Floor tiles
    generateCarpetTiles(W, L);

    // Bounds
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 0.04, L));
    boundsLine  = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
    boundsLine.position.set(0, -0.01, 0);
    scene.add(boundsLine);

    // Initialize TransformControls
    transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.size = 0.75;
    transformControls.addEventListener('change', () => {
        if (renderer && scene && camera) renderer.render(scene, camera);
    });
    transformControls.addEventListener('dragging-changed', (event) => {
        _isGizmoDragging = event.value;
        controls.enabled = !event.value;
        if (event.value) {
            if (selectedObjects.length > 0) {
                _recordDragStart(selectedObjects.length === 1 ? selectedObjects[0] : selectionAnchor);
                _beginAnchorTransform();
            }
        } else {
            if (selectedObjects.length > 0) {
                _finishAnchorTransform();
                _commitDrag();
            }
        }
    });
    transformControls.addEventListener('objectChange', () => {
        if (selectedObjects.length > 0) {
            _applyAnchorDeltaToSelection();
            syncTransformPanel();
        }
    });
    scene.add(transformControls);

    // ── DEFAULT LIGHTS ────────────────────────────────────────────────
    // Research: Start with "Exhibition Hall" preset — strong overhead + hemisphere fill
    _addLightInternal('ambient',     { color: '#ffffff', intensity: 0.25, name: 'Ambient Fill' });
    _addLightInternal('hemisphere',  { skyColor: '#c8dff5', groundColor: '#8b6914', intensity: 0.5, name: 'Sky Light' });
    _addLightInternal('directional', {
        color: '#fff5e6', intensity: 1.0, name: 'Key Light',
        position: [W * 0.5, 25, L * 0.8],
        targetPosition: [0, 0, 0], castShadow: true,
    });
    _addLightInternal('directional', {
        color: '#d0e8ff', intensity: 0.4, name: 'Fill Light',
        position: [-W * 0.5, 15, -L],
        targetPosition: [0, 0, 0], castShadow: false,
    });

    // Default backdrop
    const backdrop = spawnItem('backdrop', false);
    backdrop.position.set(0, 1.25, -L / 2 + 0.075);

    // Capture initial state AFTER spawning (so first action is undo-able)
    _undoStack = [];
    _redoStack = [];
    _refreshUndoRedo();

    // Event listeners — capture phase so we intercept before OrbitControls
    addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    renderer.domElement.addEventListener('pointermove', onPointerMove, { capture: true });
    renderer.domElement.addEventListener('pointerup',   onPointerUp,   { capture: true });
    addEventListener('keydown', onKeyDown);

    _syncGridSnapButton();
    updateLayerList();
    animate();
}

// ─── Floor Tiles ──────────────────────────────────────────────────────────
function generateCarpetTiles(W, L) {
    if (floorTilesMesh) {
        scene.remove(floorTilesMesh);
        if (floorTilesMesh.geometry) floorTilesMesh.geometry.dispose();
        if (floorTilesMesh.material) floorTilesMesh.material.dispose();
    }
    floorTiles = [];

    const geo = new THREE.BoxGeometry(0.96, 0.02, 0.96);
    const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.9, metalness: 0.05,
        emissive: 0x000000
    });
    
    const count = W * L;
    floorTilesMesh = new THREE.InstancedMesh(geo, mat, count);
    floorTilesMesh.receiveShadow = true;
    floorTilesMesh.castShadow = false;
    
    const dummy = new THREE.Object3D();
    const defaultColor = new THREE.Color('#27272a');
    let idx = 0;
    
    for (let i = 0; i < W; i++) {
        for (let j = 0; j < L; j++) {
            dummy.position.set(i - W/2 + 0.5, -0.01, j - L/2 + 0.5);
            dummy.updateMatrix();
            floorTilesMesh.setMatrixAt(idx, dummy.matrix);
            floorTilesMesh.setColorAt(idx, defaultColor);
            
            floorTiles.push({ idx, color: '#27272a' });
            idx++;
        }
    }
    
    floorTilesMesh.instanceMatrix.needsUpdate = true;
    if (floorTilesMesh.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
    scene.add(floorTilesMesh);
}

// ─── Resize ───────────────────────────────────────────────────────────────
function onWindowResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
}

function _syncGridSnapButton() {
    const btn = document.getElementById('snap-toggle-btn');
    if (!btn) return;
    btn.classList.toggle('bg-cyan-500/15', gridSnapEnabled);
    btn.classList.toggle('text-cyan-300', gridSnapEnabled);
    btn.classList.toggle('border-cyan-500/30', gridSnapEnabled);
    btn.classList.toggle('bg-white/5', !gridSnapEnabled);
    btn.classList.toggle('text-white/70', !gridSnapEnabled);
    btn.classList.toggle('border-white/10', !gridSnapEnabled);
    const label = document.getElementById('snap-toggle-text');
    if (label) label.innerText = gridSnapEnabled ? 'จัดยึดตามกริด (Snap: ON)' : 'จัดยึดตามกริด (Snap: OFF)';
}

function toggleGridSnap() {
    gridSnapEnabled = !gridSnapEnabled;
    _syncGridSnapButton();
}

// ══════════════════════════════════════════════════════════════════════════
// SPAWN OBJECTS
// ══════════════════════════════════════════════════════════════════════════
function spawnItem(type, selectNew = true) {
    const baseMat = () => new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.1 });
    let mesh;

    switch (type) {
        case 'backdrop': {
            const W = spaceWidth;
            const mats = [baseMat(), baseMat(), baseMat(), baseMat(),
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }), baseMat()];
            mesh = new THREE.Mesh(new THREE.BoxGeometry(W, 2.5, 0.15), mats);
            mesh.name = `แบคดรอป #${_countType('backdrop') + 1}`;
            mesh.userData = { type: 'backdrop', category: 'wall', baseDims: { w: W, h: 2.5, d: 0.15 } };
            break;
        }
        case 'table': {
            mesh = new THREE.Group();
            const skirtMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.7 });
            const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.72, 0.75), skirtMat);
            skirt.position.y = 0.36; skirt.castShadow = true; skirt.receiveShadow = true; mesh.add(skirt);
            const top = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.04, 0.79),
                new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.6 }));
            top.position.y = 0.74; top.castShadow = true; mesh.add(top);
            mesh.name = `โต๊ะ #${_countType('table') + 1}`;
            mesh.userData = { type: 'table', category: 'prop', targetColorMesh: skirt, baseDims: { w: 1.5, h: 0.76, d: 0.75 } };
            break;
        }
        case 'bookshelf': {
            mesh = new THREE.Group();
            const bw = 1.4, steps = 4, tH = 1.0, tD = 1.0;
            for (let i = 0; i < steps; i++) {
                const bh = (tH / steps) * (steps - i);
                const s = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, tD / steps),
                    new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.7 }));
                s.position.set(0, bh/2, -tD/2 + (tD/steps)*i + (tD/steps)/2);
                s.castShadow = true; s.receiveShadow = true; mesh.add(s);
            }
            mesh.name = `ชั้นวาง #${_countType('bookshelf') + 1}`;
            mesh.userData = { type: 'bookshelf', category: 'prop', baseDims: { w: 1.4, h: 1.0, d: 1.0 } };
            break;
        }
        case 'cashier': {
            mesh = new THREE.Group();
            const bm = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
            const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.8), bm);
            base.position.y = 0.45; base.castShadow = true; base.receiveShadow = true; mesh.add(base);
            const ct = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.05, 0.85),
                new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.3 }));
            ct.position.y = 0.925; mesh.add(ct);
            const mon = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.05),
                new THREE.MeshBasicMaterial({ color: 0x111111 }));
            mon.position.set(0.1, 1.15, -0.1); mon.rotation.y = -Math.PI/12; mesh.add(mon);
            mesh.name = `แคชเชียร์ #${_countType('cashier') + 1}`;
            mesh.userData = { type: 'cashier', category: 'prop', targetColorMesh: base, baseDims: { w: 1.0, h: 0.95, d: 0.85 } };
            break;
        }
        case 'rollup': {
            const mats = [baseMat(), baseMat(), baseMat(), baseMat(),
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }), baseMat()];
            mesh = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.0, 0.05), mats);
            const rb = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.08, 0.25),
                new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.2 }));
            rb.position.y = -1.0; mesh.add(rb);
            mesh.name = `โรลอัป #${_countType('rollup') + 1}`;
            mesh.userData = { type: 'rollup', category: 'banner', baseDims: { w: 0.8, h: 2.0, d: 0.05 } };
            break;
        }
        default: return null;
    }

    if (type === 'rollup')   mesh.position.set(0, 1.04, 0);
    else if (type === 'backdrop') mesh.position.set(0, 1.25, 0);
    else mesh.position.set(0, 0, 0);

    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    draggableObjects.push(mesh);
    updateLayerList();

    if (selectNew) {
        _cmdAddObject(mesh);
        setMode('objects');
        selectObject(mesh);
    }
    return mesh;
}

function _countType(type) { return draggableObjects.filter(o => o.userData.type === type).length; }

// ══════════════════════════════════════════════════════════════════════════
// POINTER EVENTS — CAPTURE PHASE
// ══════════════════════════════════════════════════════════════════════════
function _setPointerFromEvent(event) {
    mouse.x = (event.clientX / innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
}

function _getObjectHitFromRay() {
    const objHits = raycaster.intersectObjects(draggableObjects, true);
    if (objHits.length === 0) return null;
    let target = objHits[0].object;
    while (target && !draggableObjects.includes(target)) target = target.parent;
    return target || null;
}

function _selectSceneObject(target, event) {
    if (!target) return;
    deselectLight();
    const append = event.shiftKey || event.ctrlKey || event.metaKey;
    selectObject(target, append);
}

function onPointerDown(event) {
    if (event.target.id !== 'canvas3d') return;
    
    // Give the canvas keyboard focus so W/E/R shortcuts work
    renderer.domElement.focus({ preventScroll: true });
    _pendingScenePick = null;
    _setPointerFromEvent(event);

    // ── PROPOSAL / COMMENT PIN PLACE MODE
    if (proposalModeActive) {
        if (commentPinModeActive) {
            // Raycast against draggableObjects and floorTilesMesh
            const allTargets = [...draggableObjects];
            if (floorTilesMesh) allTargets.push(floorTilesMesh);
            const hits = raycaster.intersectObjects(allTargets, true);
            if (hits.length > 0) {
                event.stopPropagation();
                const hitPoint = hits[0].point;
                _pinId++;
                const newPin = {
                    id: _pinId,
                    position: hitPoint.clone(),
                    text: '',
                    isEditing: true
                };
                commentPins.push(newPin);
                commentPinModeActive = false;
                
                // Update pin mode button UI
                const btn = document.getElementById('prop-btn-pin');
                const btnText = document.getElementById('prop-pin-btn-text');
                if (btn) btn.classList.remove('active');
                if (btnText) btnText.innerText = "ปักหมุด (Pin Comment)";
                
                renderCommentPins();
                updateProposalCommentsList();
                
                // Focus the newly spawned pin's textarea
                setTimeout(() => {
                    const activePinEl = document.getElementById(`pin-dom-${newPin.id}`);
                    if (activePinEl) {
                        const ta = activePinEl.querySelector('textarea');
                        if (ta) ta.focus();
                    }
                }, 50);
            }
        }
        return; // Don't do standard object editing/selection when in proposal mode
    }

    // Only block clicks when the gizmo is actively being dragged
    if (_isGizmoDragging) {
        return;
    }
    
    // Check if user clicked directly on a gizmo handle — let TransformControls handle it
    if (transformControls && transformControls.visible && selectedObject) {
        const gizmoObjects = [];
        transformControls.traverse(child => {
            if (child.isMesh || child.isLine) gizmoObjects.push(child);
        });
        const gizmoHits = raycaster.intersectObjects(gizmoObjects, true);
        if (gizmoHits.length > 0) {
            return; // Let TransformControls handle its own gizmo click
        }
    }

    // ── PAINT MODE
    if (currentMode === 'paint' && floorTilesMesh) {
        const hits = raycaster.intersectObject(floorTilesMesh);
        if (hits.length > 0 && hits[0].instanceId !== undefined) {
            event.stopPropagation();
            paintTile(hits[0].instanceId, true); // true = start new batch
        }
        return;
    }

    // ── OBJECTS
    const target = _getObjectHitFromRay();
    if (target) {
        event.stopPropagation();
        _pendingScenePick = {
            target,
            append: event.shiftKey || event.ctrlKey || event.metaKey,
            x: event.clientX,
            y: event.clientY,
        };
        _selectSceneObject(target, event);
        if (selectedObjects.length === 1 && selectedObject && transformControls && transformControls.mode === 'translate') {
            isDragging = true;
            controls.enabled = false;
            _recordDragStart(selectedObject);
            const ph = raycaster.intersectObject(plane);
            if (ph.length > 0) { dragOffset.copy(selectedObject.position).sub(ph[0].point); dragOffset.y = 0; }
        }
        return;
    }

    // ── LIGHT MARKERS
    const lHits = raycaster.intersectObjects(lightMarkers);
    if (lHits.length > 0) {
        const entry = sceneLights.find(l => l.marker === lHits[0].object);
        if (entry) {
            event.stopPropagation();
            deselectObject();
            selectLight(entry);
            return;
        }
    }

    deselectObject();
    deselectLight();
}

function onPointerMove(event) {
    _setPointerFromEvent(event);

    // Drag-paint
    if (currentMode === 'paint' && event.buttons === 1 && floorTilesMesh) {
        const hits = raycaster.intersectObject(floorTilesMesh);
        if (hits.length > 0 && hits[0].instanceId !== undefined) paintTile(hits[0].instanceId, false);
        return;
    }

    if (!isDragging || !selectedObject) return;
    const ph = raycaster.intersectObject(plane);
    if (ph.length > 0) {
        const p = ph[0].point.clone().add(dragOffset);
        if (gridSnapEnabled) {
            p.x = Math.round(p.x / gridSnapSize) * gridSnapSize;
            p.z = Math.round(p.z / gridSnapSize) * gridSnapSize;
        }
        p.x = Math.max(-(spaceWidth/2+3),  Math.min(spaceWidth/2+3,  p.x));
        p.z = Math.max(-(spaceLength/2+3), Math.min(spaceLength/2+3, p.z));
        selectedObject.position.x = p.x;
        selectedObject.position.z = p.z;
        _syncSelectionAnchor();
        syncTransformPanel();
    }
}

function onPointerUp(event) {
    if (_pendingScenePick?.target && event?.target?.id === 'canvas3d') {
        const dx = event.clientX - _pendingScenePick.x;
        const dy = event.clientY - _pendingScenePick.y;
        if (!_pendingScenePick.append && Math.hypot(dx, dy) <= 6) {
            const target = _pendingScenePick.target;
            const syntheticEvent = {
                shiftKey: _pendingScenePick.append,
                ctrlKey: false,
                metaKey: false,
            };
            _selectSceneObject(target, syntheticEvent);
        }
    }
    _pendingScenePick = null;
    isDragging = false;
    controls.enabled = true;
    if (selectedObjects.length > 1) {
        _commitDrag();
        _syncSelectionAnchor();
    } else {
        _commitDrag();
        _syncSelectionAnchor();
    }
    _commitTileBatch();
}

// ─── Keyboard ────────────────────────────────────────────────────────────
function onKeyDown(e) {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
    
    // Undo / Redo / Duplicate
    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    if (isCmdOrCtrl && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) {
        e.preventDefault();
        undo();
        return;
    }
    if (isCmdOrCtrl && (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY' || (e.shiftKey && (e.key === 'Z' || e.code === 'KeyZ')))) {
        e.preventDefault();
        redo();
        return;
    }
    if (isCmdOrCtrl && (e.key === 'd' || e.key === 'D' || e.code === 'KeyD')) {
        e.preventDefault();
        duplicateSelected();
        return;
    }

    switch (e.code) {
        case 'Delete':
        case 'Backspace':
            deleteSelectedItem();
            return;
        case 'Escape':
            deselectObject();
            deselectLight();
            return;
        case 'KeyW':
            setGizmoMode('translate');
            return;
        case 'KeyE':
            setGizmoMode('rotate');
            return;
        case 'KeyR':
            setGizmoMode('scale');
            return;
        case 'KeyG':
            toggleGridSnap();
            return;
        case 'KeyA':
            toggleAutoRotate();
            return;
    }

    // Fallback for keyboard layouts (e.g. Thai layout outputting characters instead of English)
    switch (e.key) {
        case 'Delete': case 'Backspace': deleteSelectedItem(); break;
        case 'Escape': deselectObject(); deselectLight(); break;
        case 'w': case 'W': case 'ไ': setGizmoMode('translate'); break;
        case 'e': case 'E': case 'ำ': case 'ณ': setGizmoMode('rotate'); break;
        case 'r': case 'R': case 'พ': setGizmoMode('scale'); break;
        case 'g': case 'G': case 'ด':
            toggleGridSnap();
            break;
        case 'a': case 'A': case 'ฟ': toggleAutoRotate(); break;
    }
}

// ─── Tile Paint ───────────────────────────────────────────────────────────
let _paintedThisStroke = new Set();
function paintTile(tileIdx, newStroke) {
    if (newStroke) _paintedThisStroke = new Set();
    if (_paintedThisStroke.has(tileIdx)) return;
    _paintedThisStroke.add(tileIdx);

    const prevColor = floorTiles[tileIdx] ? floorTiles[tileIdx].color : '#27272a';
    const nextColor = activeCarpetBrushColor;

    if (prevColor !== nextColor) {
        _setTileColor(tileIdx, nextColor);
        if (floorTilesMesh && floorTilesMesh.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
        _tilePaintBatch.push({ idx: tileIdx, prevColor, nextColor });
    }
}

function paintAllTiles() {
    _tilePaintBatch = [];
    floorTiles.forEach(tile => {
        const prevColor = tile.color;
        const nextColor = activeCarpetBrushColor;

        if (prevColor !== nextColor) {
            _setTileColor(tile.idx, nextColor);
            _tilePaintBatch.push({ idx: tile.idx, prevColor, nextColor });
        }
    });
    if (floorTilesMesh && floorTilesMesh.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
    _commitTileBatch();
}

// ══════════════════════════════════════════════════════════════════════════
// OBJECT SELECTION
// ══════════════════════════════════════════════════════════════════════════
function _createTempTransformGroup() {
    _destroyTempTransformGroup();
    if (selectedObjects.length <= 1) return;
    
    tempTransformGroup = new THREE.Group();
    tempTransformGroup.name = "TempTransformGroup";
    
    const box = new THREE.Box3();
    selectedObjects.forEach(obj => box.expandByObject(obj));
    
    const center = new THREE.Vector3();
    box.getCenter(center);
    center.y = 0; // Keep on floor level
    
    tempTransformGroup.position.copy(center);
    scene.add(tempTransformGroup);
    
    // Attach selected items to group (preserving world transform)
    selectedObjects.forEach(obj => {
        tempTransformGroup.attach(obj);
    });
    
    selectedObject = tempTransformGroup;
}

function _destroyTempTransformGroup() {
    if (!tempTransformGroup) return;
    
    const children = [...tempTransformGroup.children];
    children.forEach(child => {
        scene.attach(child);
    });
    
    scene.remove(tempTransformGroup);
    tempTransformGroup = null;
}

function _clearAllOutlines() {
    selectedObjects.forEach(obj => _clearOutline(obj));
}

function _getSelectionCenter(targets = selectedObjects) {
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

function _destroySelectionAnchor() {
    if (transformControls) transformControls.detach();
    if (selectionAnchor) {
        scene.remove(selectionAnchor);
        selectionAnchor = null;
    }
    _anchorStartMatrix = null;
    _anchorTargetStarts = [];
}

function _syncSelectionAnchor() {
    if (!transformControls || selectedObjects.length === 0) {
        _destroySelectionAnchor();
        return;
    }
    const center = _getSelectionCenter();
    if (!selectionAnchor) {
        selectionAnchor = new THREE.Object3D();
        selectionAnchor.name = 'SelectionAnchor';
        scene.add(selectionAnchor);
    }
    selectionAnchor.position.copy(center);
    selectionAnchor.rotation.set(0, 0, 0);
    selectionAnchor.scale.set(1, 1, 1);
    selectionAnchor.updateMatrixWorld(true);
    transformControls.attach(selectionAnchor);
    transformControls.visible = guidesVisible;
}

function _beginAnchorTransform() {
    if (!selectionAnchor || selectedObjects.length === 0) return;
    selectionAnchor.updateMatrixWorld(true);
    _anchorStartMatrix = selectionAnchor.matrixWorld.clone();
    _anchorTargetStarts = selectedObjects.map(obj => {
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
    });
}

function _applyAnchorDeltaToSelection() {
    if (!selectionAnchor || !_anchorStartMatrix || !_anchorTargetStarts.length) return;
    selectionAnchor.updateMatrixWorld(true);
    const delta = new THREE.Matrix4().multiplyMatrices(
        selectionAnchor.matrixWorld,
        new THREE.Matrix4().copy(_anchorStartMatrix).invert()
    );
    _anchorTargetStarts.forEach(start => {
        const nextWorld = new THREE.Matrix4().multiplyMatrices(delta, start.matrixWorld);
        const nextLocal = new THREE.Matrix4().multiplyMatrices(start.parentInv, nextWorld);
        nextLocal.decompose(start.obj.position, start.obj.quaternion, start.obj.scale);
        if (start.obj.userData.outlineHelper) start.obj.userData.outlineHelper.update();
    });
}

function _finishAnchorTransform() {
    _applyAnchorDeltaToSelection();
    _anchorStartMatrix = null;
    _anchorTargetStarts = [];
    _syncSelectionAnchor();
}

function selectObject(obj, append = false) {
    if (selectedLight) {
        if (selectedLight.marker) selectedLight.marker.material.visible = false;
        selectedLight = null;
    }
    
    _destroyTempTransformGroup();
    _destroySelectionAnchor();
    
    if (append) {
        const idx = selectedObjects.indexOf(obj);
        if (idx > -1) {
            _clearOutline(obj);
            selectedObjects.splice(idx, 1);
        } else {
            selectedObjects.push(obj);
            obj.userData.outlineHelper = new THREE.BoxHelper(obj, 0x06b6d4);
            obj.userData.outlineHelper.visible = guidesVisible;
            scene.add(obj.userData.outlineHelper);
        }
    } else {
        _clearAllOutlines();
        selectedObjects = [obj];
        obj.userData.outlineHelper = new THREE.BoxHelper(obj, 0x06b6d4);
        obj.userData.outlineHelper.visible = guidesVisible;
        scene.add(obj.userData.outlineHelper);
    }
    
    if (selectedObjects.length === 0) {
        selectedObject = null;
        _destroySelectionAnchor();
        const gt = document.getElementById('gizmo-toolbar');
        if (gt) gt.classList.add('hidden');
    } else if (selectedObjects.length === 1) {
        selectedObject = selectedObjects[0];
        _syncSelectionAnchor();
        const gt = document.getElementById('gizmo-toolbar');
        if (gt) gt.classList.remove('hidden');
    } else {
        _syncSelectionAnchor();
        selectedObject = selectionAnchor;
        const gt = document.getElementById('gizmo-toolbar');
        if (gt) gt.classList.remove('hidden');
    }
    
    if (currentMode === 'paint') setMode('objects');
    updateUI();
    updateLayerList();
}

function deselectObject() {
    if (selectedObjects.length === 0) return;
    _clearAllOutlines();
    selectedObjects = [];
    selectedObject = null;
    
    _destroyTempTransformGroup();
    _destroySelectionAnchor();
    
    const gt = document.getElementById('gizmo-toolbar');
    if (gt) gt.classList.add('hidden');

    updateUI();
    updateLayerList();
}

function groupSelected() {
    if (selectedObjects.length <= 1) return;
    
    _destroyTempTransformGroup();
    
    const group = new THREE.Group();
    group.name = `กลุ่ม #${_countType('group') + 1}`;
    
    const box = new THREE.Box3();
    selectedObjects.forEach(obj => box.expandByObject(obj));
    const center = new THREE.Vector3();
    box.getCenter(center);
    center.y = 0;
    
    group.position.copy(center);
    scene.add(group);
    
    const items = [...selectedObjects];
    items.forEach(obj => {
        group.attach(obj);
        const idx = draggableObjects.indexOf(obj);
        if (idx > -1) draggableObjects.splice(idx, 1);
    });
    
    group.userData = {
        type: 'group',
        category: 'prop',
        children: items
    };
    
    draggableObjects.push(group);
    
    _pushCmd({
        undo() {
            const idx = draggableObjects.indexOf(group);
            if (idx > -1) draggableObjects.splice(idx, 1);
            
            items.forEach(obj => {
                scene.attach(obj);
                draggableObjects.push(obj);
            });
            scene.remove(group);
            
            selectObject(items[0]);
            items.slice(1).forEach(item => selectObject(item, true));
        },
        redo() {
            items.forEach(obj => {
                group.attach(obj);
                const idx = draggableObjects.indexOf(obj);
                if (idx > -1) draggableObjects.splice(idx, 1);
            });
            scene.add(group);
            draggableObjects.push(group);
            selectObject(group);
        }
    });
    
    selectObject(group);
}

function ungroupSelected() {
    if (selectedObjects.length !== 1) return;
    const group = selectedObjects[0];
    if (group.userData?.type !== 'group') return;
    
    const items = [...group.children];
    
    const idx = draggableObjects.indexOf(group);
    if (idx > -1) draggableObjects.splice(idx, 1);
    
    items.forEach(obj => {
        scene.attach(obj);
        draggableObjects.push(obj);
    });
    scene.remove(group);
    
    _pushCmd({
        undo() {
            items.forEach(obj => {
                group.attach(obj);
                const idx = draggableObjects.indexOf(obj);
                if (idx > -1) draggableObjects.splice(idx, 1);
            });
            scene.add(group);
            draggableObjects.push(group);
            selectObject(group);
        },
        redo() {
            const idx = draggableObjects.indexOf(group);
            if (idx > -1) draggableObjects.splice(idx, 1);
            
            items.forEach(obj => {
                scene.attach(obj);
                draggableObjects.push(obj);
            });
            scene.remove(group);
            
            selectObject(items[0]);
            items.slice(1).forEach(item => selectObject(item, true));
        }
    });
    
    selectObject(items[0]);
    items.slice(1).forEach(item => selectObject(item, true));
}

function setGizmoMode(mode) {
    if (!transformControls) return;
    transformControls.setMode(mode);
    
    const modes = ['translate', 'rotate', 'scale'];
    modes.forEach(m => {
        const btn = document.getElementById(`gizmo-mode-${m}`);
        if (btn) {
            if (m === mode) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });
}

function toggleGuides() {
    guidesVisible = !guidesVisible;
    const btn = document.getElementById('toggle-guides-btn');
    const iconShow = document.getElementById('toggle-guides-icon-show');
    const iconHide = document.getElementById('toggle-guides-icon-hide');
    const textSpan = document.getElementById('toggle-guides-text');
    if (btn) {
        if (guidesVisible) {
            btn.classList.add('bg-cyan-500/15', 'text-cyan-300', 'border-cyan-500/30');
            btn.classList.remove('bg-white/5', 'text-white/40', 'border-white/10');
            if (iconShow) iconShow.classList.remove('hidden');
            if (iconHide) iconHide.classList.add('hidden');
            if (textSpan) textSpan.innerText = "แสดงเส้นไกด์ (Guides: ON)";
        } else {
            btn.classList.remove('bg-cyan-500/15', 'text-cyan-300', 'border-cyan-500/30');
            btn.classList.add('bg-white/5', 'text-white/40', 'border-white/10');
            if (iconShow) iconShow.classList.add('hidden');
            if (iconHide) iconHide.classList.remove('hidden');
            if (textSpan) textSpan.innerText = "ซ่อนเส้นไกด์ (Guides: OFF)";
        }
    }
    if (gridHelper) gridHelper.visible = guidesVisible;
    sceneLights.forEach(e => {
        if (e.helper) e.helper.visible = guidesVisible && (e.light ? e.light.visible : true);
        if (e.marker) e.marker.material.visible = guidesVisible && (e === selectedLight);
    });
    if (selectedObject?.userData?.outlineHelper) selectedObject.userData.outlineHelper.visible = guidesVisible;
    if (transformControls) transformControls.visible = guidesVisible;
    if (renderer && scene && camera) renderer.render(scene, camera);
}

function _clearOutline(obj) {
    if (obj?.userData?.outlineHelper) {
        const helper = obj.userData.outlineHelper;
        scene.remove(helper);
        if (helper.geometry?.dispose) helper.geometry.dispose();
        if (Array.isArray(helper.material)) {
            helper.material.forEach(m => m?.dispose?.());
        } else if (helper.material?.dispose) {
            helper.material.dispose();
        }
        delete obj.userData.outlineHelper;
    }
}

function duplicateSelected() {
    if (selectedObjects.length === 0) return;
    
    _destroyTempTransformGroup();
    const newSelection = [];
    const cmds = [];
    const originalSelection = [...selectedObjects];
    
    selectedObjects.forEach(obj => {
        const type = obj.userData.type;
        let n;
        if (type === 'custom' || type === 'group') {
            n = obj.clone();
            n.traverse(c => {
                if (c.userData && c.userData.outlineHelper) delete c.userData.outlineHelper;
            });
            n.position.copy(obj.position);
            n.position.x += 1;
            scene.add(n);
            draggableObjects.push(n);
        } else {
            n = spawnItem(type, false);
            if (n) {
                n.position.copy(obj.position);
                n.position.x += 1;
                n.rotation.copy(obj.rotation);
                n.scale.copy(obj.scale);
            }
        }
        if (n) {
            newSelection.push(n);
            cmds.push(n);
        }
    });
    
    if (cmds.length > 0) {
        _pushCmd({
            undo() {
                _destroyTempTransformGroup();
                _clearAllOutlines();
                cmds.forEach(n => _removeFromScene(n));
                selectedObjects = [];
                selectedObject = null;
                updateLayerList();
                if (originalSelection.length > 0) {
                    selectObject(originalSelection[0]);
                    originalSelection.slice(1).forEach(item => selectObject(item, true));
                }
            },
            redo() {
                _destroyTempTransformGroup();
                _clearAllOutlines();
                cmds.forEach(n => {
                    scene.add(n);
                    draggableObjects.push(n);
                });
                updateLayerList();
                if (newSelection.length > 0) {
                    selectObject(newSelection[0]);
                    newSelection.slice(1).forEach(item => selectObject(item, true));
                }
            }
        });
    }
    
    if (newSelection.length > 0) {
        selectObject(newSelection[0]);
        newSelection.slice(1).forEach(item => selectObject(item, true));
    }
}

function deleteSelectedItem() {
    if (selectedObjects.length > 0) {
        _destroyTempTransformGroup();
        const items = [...selectedObjects];
        const indices = items.map(o => draggableObjects.indexOf(o));
        
        _clearAllOutlines();
        items.forEach(obj => _removeFromScene(obj));
        selectedObjects = [];
        selectedObject = null;
        
        _pushCmd({
            undo() {
                _destroyTempTransformGroup();
                items.forEach((obj, i) => {
                    _addToScene(obj, indices[i]);
                });
                updateLayerList();
                selectObject(items[0]);
                items.slice(1).forEach(item => selectObject(item, true));
            },
            redo() {
                _destroyTempTransformGroup();
                _clearAllOutlines();
                items.forEach(obj => _removeFromScene(obj));
                selectedObjects = [];
                selectedObject = null;
                updateLayerList();
                updateUI();
            }
        });
        
        updateUI();
        updateLayerList();
    } else if (selectedLight) {
        deleteLightEntry(selectedLight);
    }
}

function clearAllWorkspace() {
    _clearSceneContent();
    floorTiles.forEach(tile => _setTileColor(tile.idx, '#27272a'));
    if (floorTilesMesh?.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
    renderCommentPins();
    updateLayerList();
    updateUI();
    _undoStack = []; _redoStack = [];
    _refreshUndoRedo();
    clearAutosaveDraft();
}

const LAYOUT_TEMPLATES = {
    roadshow: {
        name: 'Roadshow Book Wall',
        objects: [
            { type: 'backdrop', position: [0, 1.25, null] },
            { type: 'cashier', position: [-5, 0, 4], rotationY: 0 },
            { type: 'table', position: [-3, 0, 1.8] },
            { type: 'table', position: [0, 0, 1.8] },
            { type: 'table', position: [3, 0, 1.8] },
            { type: 'bookshelf', position: [-5, 0, -1.4] },
            { type: 'bookshelf', position: [-2.5, 0, -1.4] },
            { type: 'bookshelf', position: [2.5, 0, -1.4] },
            { type: 'bookshelf', position: [5, 0, -1.4] },
            { type: 'rollup', position: [6, 1.04, 3.8] },
        ],
        carpet: '#1e3a8a',
        lightPreset: 'exhibition',
    },
    booth3x3: {
        name: 'Booth 3x3 Focus',
        objects: [
            { type: 'backdrop', position: [0, 1.25, null], scale: [0.22, 1, 1] },
            { type: 'table', position: [0, 0, 0.6] },
            { type: 'rollup', position: [-1.1, 1.04, -0.6] },
            { type: 'rollup', position: [1.1, 1.04, -0.6] },
        ],
        carpet: '#374151',
        lightPreset: 'studio',
    },
    cashierFlow: {
        name: 'Cashier Flow',
        objects: [
            { type: 'backdrop', position: [0, 1.25, null] },
            { type: 'cashier', position: [0, 0, 3.8] },
            { type: 'table', position: [-4, 0, 0.8] },
            { type: 'table', position: [4, 0, 0.8] },
            { type: 'bookshelf', position: [-4.5, 0, -2] },
            { type: 'bookshelf', position: [0, 0, -2] },
            { type: 'bookshelf', position: [4.5, 0, -2] },
            { type: 'rollup', position: [-6, 1.04, 3.2] },
            { type: 'rollup', position: [6, 1.04, 3.2] },
        ],
        carpet: '#15803d',
        lightPreset: 'daylight',
    },
};

function _applyTemplateObject(spec) {
    const obj = spawnItem(spec.type, false);
    if (!obj) return null;
    const pos = spec.position || [0, 0, 0];
    obj.position.set(
        pos[0] ?? 0,
        pos[1] ?? obj.position.y,
        pos[2] === null ? -spaceLength / 2 + 0.075 : (pos[2] ?? 0)
    );
    if (spec.rotationY !== undefined) obj.rotation.y = THREE.MathUtils.degToRad(spec.rotationY);
    if (spec.scale) obj.scale.fromArray(spec.scale);
    return obj;
}

function applyLayoutTemplate(templateKey, skipConfirm = false) {
    const template = LAYOUT_TEMPLATES[templateKey];
    if (!template) return;
    if (!skipConfirm && draggableObjects.length > 0 && !confirm(`ใช้เทมเพลต ${template.name} และแทนที่วัตถุ/ไฟในฉากปัจจุบัน?`)) return;

    _clearSceneContent();
    template.objects.forEach(_applyTemplateObject);
    if (template.carpet) {
        floorTiles.forEach(tile => _setTileColor(tile.idx, template.carpet));
        if (floorTilesMesh?.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;
    }
    if (template.lightPreset) applyLightPreset(template.lightPreset);
    deselectObject();
    updateLayerList();
    updateUI();
    _undoStack = [];
    _redoStack = [];
    _refreshUndoRedo();
    _queueAutosave();
}

// ══════════════════════════════════════════════════════════════════════════
// LIGHTING SYSTEM
// ══════════════════════════════════════════════════════════════════════════
const LIGHT_ICONS = { ambient:'✨', hemisphere:'🌅', directional:'☀️', point:'💡', spot:'🔦' };

// Internal: add light without undo (used for init defaults)
function _addLightInternal(type, props = {}) {
    const entry = _buildLightEntry(type, props);
    sceneLights.push(entry);
    _attachLightToScene(entry);
    return entry;
}

// Public: add light WITH undo tracking
function addLight(type) {
    const entry = _buildLightEntry(type, {});
    sceneLights.push(entry);
    _attachLightToScene(entry);
    updateLayerList();
    selectLight(entry);
    const idx = sceneLights.indexOf(entry);
    _pushCmd({
        undo() { deleteLightEntry(entry, true); updateLayerList(); },
        redo() { sceneLights.push(entry); _attachLightToScene(entry); updateLayerList(); selectLight(entry); }
    });
}

function _buildLightEntry(type, props) {
    let light;
    const col = props.color || '#ffffff';

    switch (type) {
        case 'ambient':
            light = new THREE.AmbientLight(col, props.intensity ?? 0.3);
            break;
        case 'hemisphere':
            light = new THREE.HemisphereLight(
                props.skyColor    || '#87ceeb',
                props.groundColor || '#8b6914',
                props.intensity   ?? 0.5
            );
            break;
        case 'directional': {
            light = new THREE.DirectionalLight(col, props.intensity ?? 0.8);
            light.position.set(...(props.position || [10, 20, 10]));
            light.target.position.set(...(props.targetPosition || [0, 0, 0]));
            if (props.castShadow !== false) {
                light.castShadow = true;
                light.shadow.mapSize.set(1024, 1024);
                light.shadow.camera.near  = 0.5;
                light.shadow.camera.far   = 120;
                const d = Math.max(spaceWidth, spaceLength) * 1.2;
                Object.assign(light.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
                light.shadow.bias = -0.0005;
            }
            break;
        }
        case 'point': {
            light = new THREE.PointLight(col, props.intensity ?? 1.0, props.distance ?? 30, 2);
            light.position.set(...(props.position || [0, 5, 0]));
            if (props.castShadow) {
                light.castShadow = true;
                light.shadow.mapSize.set(512, 512);
            }
            break;
        }
        case 'spot': {
            light = new THREE.SpotLight(col, props.intensity ?? 1.5, props.distance ?? 30,
                props.angle ?? Math.PI/6, props.penumbra ?? 0.2, 2);
            light.position.set(...(props.position || [0, 12, 0]));
            light.target.position.set(...(props.targetPosition || [0, 0, 0]));
            if (props.castShadow !== false) {
                light.castShadow = true;
                light.shadow.mapSize.set(1024, 1024);
                light.shadow.bias = -0.0005;
            }
            break;
        }
    }

    const id = ++_lightId;
    const name = props.name || `${type[0].toUpperCase() + type.slice(1)} Light #${id}`;
    return { id, type, name, light, helper: null, marker: null };
}

function _attachLightToScene(entry) {
    const { type, light } = entry;
    scene.add(light);
    if (light.target) scene.add(light.target);

    // Create visual helper
    let helper = null;
    if (type === 'directional') helper = new THREE.DirectionalLightHelper(light, 1.5);
    else if (type === 'spot')   helper = new THREE.SpotLightHelper(light);
    else if (type === 'point')  helper = new THREE.PointLightHelper(light, 0.5);
    else if (type === 'hemisphere') helper = new THREE.HemisphereLightHelper(light, 1.2);

    if (helper) {
        helper.visible = guidesVisible;
        scene.add(helper);
        entry.helper = helper;
    }

    // Invisible sphere marker for raycasting (for positioned lights)
    if (['directional','point','spot'].includes(type)) {
        const markerGeo = new THREE.SphereGeometry(0.35, 6, 6);
        const markerMat = new THREE.MeshBasicMaterial({ visible: false });
        const marker    = new THREE.Mesh(markerGeo, markerMat);
        marker.position.copy(light.position);
        scene.add(marker);
        entry.marker = marker;
        lightMarkers.push(marker);
    }
}

function selectLight(entry) {
    if (selectedLight === entry) return;
    deselectObject();
    selectedLight = entry;

    // Highlight marker
    if (entry.marker) {
        entry.marker.material.visible = guidesVisible;
        entry.marker.material.color   = new THREE.Color(0x06b6d4);
        entry.marker.material.opacity = 0.4;
        entry.marker.material.transparent = true;
    }

    updateUI();
    updateLayerList();
}

function deselectLight() {
    if (!selectedLight) return;
    if (selectedLight.marker) {
        selectedLight.marker.material.visible = false;
    }
    selectedLight = null;
    updateUI();
    updateLayerList();
}

function deleteLightEntry(entry, noUndo = false) {
    const idx = sceneLights.indexOf(entry);
    if (idx === -1) return;
    sceneLights.splice(idx, 1);
    scene.remove(entry.light);
    if (entry.light.target) scene.remove(entry.light.target);
    if (entry.helper)  { scene.remove(entry.helper);  entry.helper.dispose(); }
    if (entry.marker)  {
        const mi = lightMarkers.indexOf(entry.marker);
        if (mi > -1) lightMarkers.splice(mi, 1);
        scene.remove(entry.marker);
    }
    if (selectedLight === entry) { selectedLight = null; updateUI(); }
    updateLayerList();

    if (!noUndo) {
        _pushCmd({
            undo() { sceneLights.push(entry); _attachLightToScene(entry); updateLayerList(); },
            redo() { deleteLightEntry(entry, true); updateLayerList(); }
        });
    }
}

function updateLightHelper(entry) {
    if (!entry) return;
    if (entry.helper?.update) entry.helper.update();
    if (entry.marker) entry.marker.position.copy(entry.light.position);
}

// Light Presets (research-backed exhibition setups)
function applyLightPreset(preset) {
    // Remove all non-permanent lights
    [...sceneLights].forEach(e => deleteLightEntry(e, true));
    sceneLights = [];
    lightMarkers = [];

    const W = spaceWidth, L = spaceLength;

    switch (preset) {
        case 'studio': // 3-Point Lighting
            _addLightInternal('ambient',     { color:'#ffffff', intensity: 0.15, name:'Ambient' });
            _addLightInternal('directional', { color:'#fff5e0', intensity: 1.2, name:'Key Light',  position:[W*0.5, 20, L], targetPosition:[0,0,0], castShadow:true });
            _addLightInternal('directional', { color:'#d0e8ff', intensity: 0.5, name:'Fill Light', position:[-W*0.5, 10, L*0.5], targetPosition:[0,0,0], castShadow:false });
            _addLightInternal('directional', { color:'#ffffff', intensity: 0.4, name:'Rim Light',  position:[0, 8, -L*1.5], targetPosition:[0,1,0], castShadow:false });
            break;
        case 'exhibition': // Exhibition Hall — overhead fluorescent feel
            _addLightInternal('hemisphere', { skyColor:'#c8dff5', groundColor:'#8b7355', intensity:0.6, name:'Sky Fill' });
            _addLightInternal('directional',{ color:'#ffffff', intensity:1.1, name:'Overhead Key', position:[0,30,L*0.3], targetPosition:[0,0,0], castShadow:true });
            _addLightInternal('point',      { color:'#fff5e6', intensity:0.8, name:'Warm Accent', position:[W*0.3,3,0], distance:20 });
            break;
        case 'dramatic': // Stage drama — low ambient + colored spots
            _addLightInternal('ambient', { color:'#1a0a2e', intensity:0.1, name:'Dark Ambient' });
            _addLightInternal('spot',    { color:'#ff8c42', intensity:3.0, name:'Warm Spot', position:[-W*0.3,15,L*0.3], targetPosition:[0,0,0], angle:Math.PI/8, penumbra:0.3, castShadow:true });
            _addLightInternal('spot',    { color:'#4fc3f7', intensity:2.5, name:'Cool Spot',  position:[W*0.3,15,L*0.3], targetPosition:[0,0,0], angle:Math.PI/8, penumbra:0.3, castShadow:false });
            _addLightInternal('spot',    { color:'#e040fb', intensity:1.5, name:'Back Spot',  position:[0,10,-L*0.5],  targetPosition:[0,0.5,0], angle:Math.PI/6, penumbra:0.5, castShadow:false });
            break;
        case 'daylight': // Bright outdoor daylight
            _addLightInternal('hemisphere', { skyColor:'#87ceeb', groundColor:'#8b7355', intensity:0.8, name:'Sky' });
            _addLightInternal('directional',{ color:'#fffde7', intensity:1.8, name:'Sun', position:[W,40,L*2], targetPosition:[0,0,0], castShadow:true });
            break;
        case 'moody': // Single warm point light
            _addLightInternal('ambient', { color:'#110a00', intensity:0.05, name:'Deep Shadow' });
            _addLightInternal('point',   { color:'#ff9a3c', intensity:4.0, name:'Warm Lamp', position:[0,3,0], distance:15 });
            break;
    }
    updateLayerList();
    _undoStack = []; _redoStack = [];
    _refreshUndoRedo();
}

// ─── Light Property Snapshot ──────────────────────────────────────────────
function _getLightProps(entry) {
    const l = entry.light;
    return {
        color:       '#' + l.color.getHexString(),
        intensity:   l.intensity,
        visible:     l.visible,
        castShadow:  l.castShadow,
        posX: l.position?.x ?? 0, posY: l.position?.y ?? 0, posZ: l.position?.z ?? 0,
        tgtX: l.target?.position.x ?? 0, tgtY: l.target?.position.y ?? 0, tgtZ: l.target?.position.z ?? 0,
        angle:    l.angle,
        penumbra: l.penumbra,
        distance: l.distance,
        skyColor:    entry.type === 'hemisphere' ? ('#' + l.color.getHexString())    : null,
        groundColor: entry.type === 'hemisphere' ? ('#' + l.groundColor?.getHexString()) : null,
    };
}

function _applyLightProps(entry, props) {
    const l = entry.light;
    if (props.color    !== undefined) l.color.set(props.color);
    if (props.intensity !== undefined) l.intensity = props.intensity;
    if (props.visible   !== undefined) l.visible   = props.visible;
    if (props.castShadow !== undefined) l.castShadow = props.castShadow;
    if (props.posX !== undefined && l.position) l.position.set(props.posX, props.posY, props.posZ);
    if (props.tgtX !== undefined && l.target)   l.target.position.set(props.tgtX, props.tgtY, props.tgtZ);
    if (props.angle    !== undefined) l.angle    = props.angle;
    if (props.penumbra !== undefined) l.penumbra = props.penumbra;
    if (props.distance !== undefined) l.distance = props.distance;
    if (props.groundColor && l.groundColor) l.groundColor.set(props.groundColor);
    updateLightHelper(entry);
}

// ─── Light Property Setters (called from HTML) ────────────────────────────
function _withLightUndo(apply) {
    if (!selectedLight) return;
    const prev = _getLightProps(selectedLight);
    apply(selectedLight.light);
    updateLightHelper(selectedLight);
    const next = _getLightProps(selectedLight);
    const entry = selectedLight;
    _pushLightPropCmd(entry, prev, next);
}

function _lightPropsChanged(prev, next) {
    return JSON.stringify(prev) !== JSON.stringify(next);
}

function _pushLightPropCmd(entry, prev, next) {
    if (!entry || !_lightPropsChanged(prev, next)) return;
    _pushCmd({
        undo() { _applyLightProps(entry, prev); syncLightPanel(); },
        redo() { _applyLightProps(entry, next); syncLightPanel(); }
    });
}

function beginLightUndo() {
    if (!selectedLight || _activeLightUndo) return;
    _activeLightUndo = {
        entry: selectedLight,
        prev: _getLightProps(selectedLight)
    };
}

function commitLightUndo() {
    if (!_activeLightUndo) return;
    const { entry, prev } = _activeLightUndo;
    _activeLightUndo = null;
    const next = _getLightProps(entry);
    _pushLightPropCmd(entry, prev, next);
    syncLightPanel();
}

function _applyLightLive(apply, commit = true) {
    if (!selectedLight) return;
    beginLightUndo();
    const entry = selectedLight;
    apply(entry.light, entry);
    updateLightHelper(entry);
    if (commit) commitLightUndo();
}

function setLightColor(hex, commit = true) { _applyLightLive(l => l.color.set(hex), commit); }
function setLightIntensity(v, commit = true) { _applyLightLive(l => { l.intensity = parseFloat(v) || 0; }, commit); }
function setLightVisible(v) {
    _applyLightLive((l, entry) => {
        l.visible = v;
        if (entry.helper) entry.helper.visible = v && guidesVisible;
        if (entry.marker) entry.marker.material.visible = v && entry === selectedLight && guidesVisible;
    });
}
function setLightShadow(v) { _applyLightLive(l => { l.castShadow = v; }); }
function setLightPosX(v){ _applyLightLive(l => { if (l.position) l.position.x = parseFloat(v)||0; }); syncLightPanel(); }
function setLightPosY(v){ _applyLightLive(l => { if (l.position) l.position.y = parseFloat(v)||0; }); syncLightPanel(); }
function setLightPosZ(v){ _applyLightLive(l => { if (l.position) l.position.z = parseFloat(v)||0; }); syncLightPanel(); }
function setLightTgtX(v){ _applyLightLive(l => { if (l.target) l.target.position.x = parseFloat(v)||0; }); }
function setLightTgtY(v){ _applyLightLive(l => { if (l.target) l.target.position.y = parseFloat(v)||0; }); }
function setLightTgtZ(v){ _applyLightLive(l => { if (l.target) l.target.position.z = parseFloat(v)||0; }); }
function setLightAngle(v)    { _applyLightLive(l => { l.angle = THREE.MathUtils.degToRad(parseFloat(v)||30); }); }
function setLightPenumbra(v) { _applyLightLive(l => { l.penumbra = Math.max(0, Math.min(1, parseFloat(v)||0.2)); }); }
function setLightDistance(v) { _applyLightLive(l => { l.distance = parseFloat(v)||0; }); }
function setLightSkyColor(hex, commit = true) { _applyLightLive(l => l.color.set(hex), commit); }
function setLightGroundColor(hex, commit = true) { _applyLightLive(l => { if (l.groundColor) l.groundColor.set(hex); }, commit); }
function renameLightEntry(v)      { if(selectedLight) { selectedLight.name = v; updateLayerList(); }}

// ══════════════════════════════════════════════════════════════════════════
// UI — RIGHT PANEL
// ══════════════════════════════════════════════════════════════════════════
function updateUI() {
    const unsel    = document.getElementById('unselected-panel');
    const objSel   = document.getElementById('selected-panel');
    const lightSel = document.getElementById('light-selected-panel');

    if (selectedLight) {
        unsel.classList.add('hidden');
        objSel.classList.add('hidden');
        lightSel.classList.remove('hidden');
        syncLightPanel();
        return;
    }
    if (selectedObjects.length === 0) {
        unsel.classList.remove('hidden');
        objSel.classList.add('hidden');
        lightSel.classList.add('hidden');
        return;
    }
    unsel.classList.add('hidden');
    lightSel.classList.add('hidden');
    objSel.classList.remove('hidden');

    const colorCtrl   = document.getElementById('control-color');
    const textureCtrl = document.getElementById('control-texture');
    const groupActions = document.getElementById('control-group-actions');
    const btnGroup = document.getElementById('btn-group-selected');
    const btnUngroup = document.getElementById('btn-ungroup-selected');

    if (selectedObjects.length > 1) {
        document.getElementById('selected-title').innerText = `เลือกวัตถุ ${selectedObjects.length} ชิ้น`;
        document.getElementById('selected-badge').innerText = "BATCH";
        colorCtrl.classList.add('hidden');
        textureCtrl.classList.add('hidden');
        if (groupActions) {
            groupActions.classList.remove('hidden');
            if (btnGroup) btnGroup.classList.remove('hidden');
            if (btnUngroup) btnUngroup.classList.add('hidden');
        }
    } else {
        const type = selectedObjects[0].userData.type;
        document.getElementById('selected-title').innerText = selectedObjects[0].name;
        document.getElementById('selected-badge').innerText = type.toUpperCase();
        
        if (type === 'group') {
            colorCtrl.classList.add('hidden');
            textureCtrl.classList.add('hidden');
            if (groupActions) {
                groupActions.classList.remove('hidden');
                if (btnGroup) btnGroup.classList.add('hidden');
                if (btnUngroup) btnUngroup.classList.remove('hidden');
            }
        } else {
            if (groupActions) groupActions.classList.add('hidden');
            if (['table','bookshelf','cashier'].includes(type)) {
                colorCtrl.classList.remove('hidden');
                textureCtrl.classList.add('hidden');
                const src = selectedObjects[0].userData.targetColorMesh || selectedObjects[0];
                let hex = 'ffffff';
                if (src.isMesh && !Array.isArray(src.material)) hex = src.material.color.getHexString();
                else src.traverse(c => { if (c.isMesh && !Array.isArray(c.material) && c.material.metalness < 0.5) hex = c.material.color.getHexString(); });
                document.getElementById('color-input').value  = '#' + hex;
                document.getElementById('color-hex').innerText = '#' + hex.toUpperCase();
            } else if (['backdrop','rollup'].includes(type)) {
                colorCtrl.classList.add('hidden');
                textureCtrl.classList.remove('hidden');
            } else {
                colorCtrl.classList.add('hidden');
                textureCtrl.classList.add('hidden');
            }
        }
    }
    syncTransformPanel();
}

function syncLightPanel() {
    if (!selectedLight) return;
    const e = selectedLight, l = e.light, type = e.type;

    _sv('lp-name',      e.name);
    document.getElementById('lp-badge').innerText = type.toUpperCase();
    _sv('lp-intensity', l.intensity.toFixed(2));
    const intensitySlider = document.getElementById('lp-intensity-slider');
    if (intensitySlider) intensitySlider.value = Math.min(l.intensity, 5);

    // Color
    const colorEl = document.getElementById('lp-color');
    if (colorEl) colorEl.value = '#' + l.color.getHexString();

    // Toggles
    const visEl = document.getElementById('lp-visible');
    if (visEl) visEl.checked = l.visible;
    const shEl = document.getElementById('lp-shadow');
    if (shEl) shEl.checked = l.castShadow || false;

    // Position (directional, point, spot)
    const hasPosEl = document.getElementById('lp-pos-group');
    const hasPos = ['directional','point','spot'].includes(type);
    if (hasPosEl) hasPosEl.classList.toggle('hidden', !hasPos);
    if (hasPos && l.position) {
        _sv('lp-pos-x', l.position.x.toFixed(2));
        _sv('lp-pos-y', l.position.y.toFixed(2));
        _sv('lp-pos-z', l.position.z.toFixed(2));
    }

    // Target (directional, spot)
    const hasTgtEl = document.getElementById('lp-tgt-group');
    const hasTgt = ['directional','spot'].includes(type);
    if (hasTgtEl) hasTgtEl.classList.toggle('hidden', !hasTgt);
    if (hasTgt && l.target) {
        _sv('lp-tgt-x', l.target.position.x.toFixed(2));
        _sv('lp-tgt-y', l.target.position.y.toFixed(2));
        _sv('lp-tgt-z', l.target.position.z.toFixed(2));
    }

    // SpotLight specific
    const spotGrp = document.getElementById('lp-spot-group');
    if (spotGrp) spotGrp.classList.toggle('hidden', type !== 'spot');
    if (type === 'spot') {
        _sv('lp-angle',    THREE.MathUtils.radToDeg(l.angle).toFixed(1));
        _sv('lp-penumbra', l.penumbra.toFixed(2));
        _sv('lp-distance', (l.distance || 0).toFixed(1));
    }

    // PointLight specific
    const pointGrp = document.getElementById('lp-point-group');
    if (pointGrp) pointGrp.classList.toggle('hidden', type !== 'point');
    if (type === 'point') _sv('lp-dist-p', (l.distance||0).toFixed(1));

    // Hemisphere specific
    const hemiGrp = document.getElementById('lp-hemi-group');
    if (hemiGrp) hemiGrp.classList.toggle('hidden', type !== 'hemisphere');
    if (type === 'hemisphere') {
        const skyEl = document.getElementById('lp-sky-color');
        const gndEl = document.getElementById('lp-gnd-color');
        if (skyEl) skyEl.value = '#' + l.color.getHexString();
        if (gndEl && l.groundColor) gndEl.value = '#' + l.groundColor.getHexString();
    }
}

function _sv(id, val) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val;
}

// ─── Object Transform Sync ────────────────────────────────────────────────
function syncTransformPanel() {
    if (!selectedObject) return;
    const { position: p, rotation: r, scale: s, userData: ud } = selectedObject;
    _sv('tf-pos-x', p.x.toFixed(2)); _sv('tf-pos-y', p.y.toFixed(2)); _sv('tf-pos-z', p.z.toFixed(2));
    _sv('tf-rot-x', THREE.MathUtils.radToDeg(r.x).toFixed(1));
    _sv('tf-rot-y', THREE.MathUtils.radToDeg(r.y).toFixed(1));
    _sv('tf-rot-z', THREE.MathUtils.radToDeg(r.z).toFixed(1));
    _sv('tf-scale-x', s.x.toFixed(2)); _sv('tf-scale-y', s.y.toFixed(2)); _sv('tf-scale-z', s.z.toFixed(2));
    if (ud.baseDims) {
        _sv('dim-w', (ud.baseDims.w * s.x).toFixed(2));
        _sv('dim-h', (ud.baseDims.h * s.y).toFixed(2));
        _sv('dim-d', (ud.baseDims.d * s.z).toFixed(2));
    }
    
    // Dynamic recommendation dimensions
    const recText = document.getElementById('graphic-recommendation');
    if (recText) {
        const type = ud.type;
        if (['backdrop','rollup'].includes(type) && ud.baseDims) {
            const w = ud.baseDims.w * s.x;
            const h = ud.baseDims.h * s.y;
            recText.innerText = `แนะนำขนาดกราฟิก: ${Math.round(w * 100)} × ${Math.round(h * 100)} ซม.`;
        } else {
            recText.innerText = '';
        }
    }
}

function _tf(fn) {
    if (!selectedObject) return;
    if (selectedObjects.length > 1 && selectionAnchor) {
        _recordDragStart(selectionAnchor);
        _beginAnchorTransform();
        fn(selectionAnchor);
        selectionAnchor.updateMatrixWorld(true);
        _finishAnchorTransform();
        _commitDrag();
    } else {
        _recordDragStart(selectedObject);
        fn(selectedObject);
        _commitDrag();
        _syncSelectionAnchor();
    }
    syncTransformPanel();
}
function setPositionX(v){ _tf(o=>o.position.x=parseFloat(v)||0); }
function setPositionY(v){ _tf(o=>o.position.y=parseFloat(v)||0); }
function setPositionZ(v){ _tf(o=>o.position.z=parseFloat(v)||0); }
function setRotationX(v){ _tf(o=>o.rotation.x=THREE.MathUtils.degToRad(parseFloat(v)||0)); }
function setRotationY(v){ _tf(o=>o.rotation.y=THREE.MathUtils.degToRad(parseFloat(v)||0)); }
function setRotationZ(v){ _tf(o=>o.rotation.z=THREE.MathUtils.degToRad(parseFloat(v)||0)); }
function setScaleX(v)   { _tf(o=>o.scale.x=Math.max(0.05,parseFloat(v)||1)); }
function setScaleY(v)   { _tf(o=>o.scale.y=Math.max(0.05,parseFloat(v)||1)); }
function setScaleZ(v)   { _tf(o=>o.scale.z=Math.max(0.05,parseFloat(v)||1)); }
function setDimW(m){ if(selectedObject?.userData?.baseDims) setScaleX(parseFloat(m)/selectedObject.userData.baseDims.w); }
function setDimH(m){ if(selectedObject?.userData?.baseDims) setScaleY(parseFloat(m)/selectedObject.userData.baseDims.h); }
function setDimD(m){ if(selectedObject?.userData?.baseDims) setScaleZ(parseFloat(m)/selectedObject.userData.baseDims.d); }
function applyRotation(deg){ setRotationY(deg); }

// ══════════════════════════════════════════════════════════════════════════
// LAYER LIST
// ══════════════════════════════════════════════════════════════════════════
function updateLayerList() {
    const c = document.getElementById('layer-list');
    if (!c) return;
    c.innerHTML = '';

    const totalItems = draggableObjects.length + sceneLights.length;
    if (totalItems === 0) {
        c.innerHTML = `<div class="text-center py-6 text-white/25 text-xs"><p>ยังไม่มีวัตถุหรือไฟ</p></div>`;
        return;
    }

    // ── Objects section
    if (draggableObjects.length) {
        const objHeader = document.createElement('div');
        objHeader.className = 'section-label mb-1 mt-1';
        objHeader.textContent = 'วัตถุ (Objects)';
        c.appendChild(objHeader);

        [...draggableObjects].reverse().forEach(obj => {
            const sel = obj === selectedObject;
            const item = document.createElement('div');
            item.className = 'flex items-center space-x-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all text-xs border ' +
                (sel ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' : 'bg-white/5 border-transparent hover:bg-white/10 text-white/75');
            item.onclick = () => { showLeftTab('layers'); selectObject(obj); };
            const svgIcon = OBJECT_LAYER_ICONS[obj.userData.type] || OBJECT_LAYER_ICONS.custom;
            item.innerHTML = `${svgIcon}<span class="flex-1 truncate font-medium ml-1.5">${obj.name}</span>${sel?'<span class="text-cyan-400 text-[9px] flex-shrink-0">✓</span>':''}`;
            c.appendChild(item);
        });
    }

    // ── Lights section
    if (sceneLights.length) {
        const lHeader = document.createElement('div');
        lHeader.className = 'section-label mb-1 mt-3';
        lHeader.textContent = 'แสงไฟ (Lights)';
        c.appendChild(lHeader);

        [...sceneLights].reverse().forEach(entry => {
            const sel = entry === selectedLight;
            const item = document.createElement('div');
            item.className = 'flex items-center space-x-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all text-xs border ' +
                (sel ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300' : 'bg-white/5 border-transparent hover:bg-white/10 text-white/75');
            item.onclick = () => { showLeftTab('layers'); selectLight(entry); };
            const svgIcon = LIGHT_LAYER_ICONS[entry.type] || LIGHT_LAYER_ICONS.point;
            item.innerHTML = `${svgIcon}<span class="flex-1 truncate font-medium ml-1.5">${entry.name}</span>${sel?'<span class="text-yellow-400 text-[9px] flex-shrink-0">✓</span>':''}`;
            c.appendChild(item);
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// MODE & TOGGLE FLOATING PANELS
// ══════════════════════════════════════════════════════════════════════════
let activeLeftPanel = null; // 'objects' | 'lights' | 'layers' | 'paint' | null

function toggleLeftPanel(panelName) {
    const panelEl = document.getElementById('left-floating-panel');
    const titleEl = document.getElementById('left-panel-title');
    const buttons = {
        objects: document.getElementById('tab-btn-objects'),
        lights: document.getElementById('tab-btn-lights'),
        layers: document.getElementById('tab-btn-layers'),
        paint: document.getElementById('tab-btn-paint')
    };
    const titles = {
        objects: 'เพิ่มวัตถุ (Objects)',
        lights: 'ตั้งค่าแสงไฟ (Lights)',
        layers: 'รายการวัตถุในห้อง',
        paint: 'ระบายสีพื้นพรม'
    };
    
    // Toggle same panel
    if (activeLeftPanel === panelName) {
        activeLeftPanel = null;
        panelEl.classList.add('hidden');
        if (buttons[panelName]) buttons[panelName].classList.remove('active');
        if (panelName === 'paint') currentMode = 'objects';
        return;
    }
    
    // Deactivate previous active button
    if (activeLeftPanel && buttons[activeLeftPanel]) {
        buttons[activeLeftPanel].classList.remove('active');
    }
    
    // Activate new panel
    activeLeftPanel = panelName;
    panelEl.classList.remove('hidden');
    if (buttons[panelName]) buttons[panelName].classList.add('active');
    if (titleEl) titleEl.innerText = titles[panelName] || 'เครื่องมือ';
    
    // Show correct sub-panel
    document.getElementById('panel-objects').classList.toggle('hidden', panelName !== 'objects');
    document.getElementById('panel-lights').classList.toggle('hidden', panelName !== 'lights');
    document.getElementById('panel-layers').classList.toggle('hidden', panelName !== 'layers');
    document.getElementById('panel-paint').classList.toggle('hidden', panelName !== 'paint');
    
    // Manage modes
    if (panelName === 'paint') {
        currentMode = 'paint';
        deselectObject();
        deselectLight();
    } else {
        currentMode = 'objects';
    }

    if (panelName === 'layers') {
        updateLayerList();
    }
}

function showLeftTab(tab) {
    const panelEl = document.getElementById('left-floating-panel');
    const titleEl = document.getElementById('left-panel-title');
    const buttons = {
        objects: document.getElementById('tab-btn-objects'),
        lights: document.getElementById('tab-btn-lights'),
        layers: document.getElementById('tab-btn-layers'),
        paint: document.getElementById('tab-btn-paint')
    };
    const titles = {
        objects: 'เพิ่มวัตถุ (Objects)',
        lights: 'ตั้งค่าแสงไฟ (Lights)',
        layers: 'รายการวัตถุในห้อง',
        paint: 'ระบายสีพื้นพรม'
    };

    if (activeLeftPanel !== tab) {
        if (activeLeftPanel && buttons[activeLeftPanel]) {
            buttons[activeLeftPanel].classList.remove('active');
        }
        activeLeftPanel = tab;
        panelEl.classList.remove('hidden');
        if (buttons[tab]) buttons[tab].classList.add('active');
        if (titleEl) titleEl.innerText = titles[tab] || 'เครื่องมือ';

        document.getElementById('panel-objects').classList.toggle('hidden', tab !== 'objects');
        document.getElementById('panel-lights').classList.toggle('hidden', tab !== 'lights');
        document.getElementById('panel-layers').classList.toggle('hidden', tab !== 'layers');
        document.getElementById('panel-paint').classList.toggle('hidden', tab !== 'paint');
        
        if (tab === 'paint') {
            currentMode = 'paint';
            deselectObject();
            deselectLight();
        } else {
            currentMode = 'objects';
        }
    }
    if (tab === 'layers') updateLayerList();
}

function setMode(mode) {
    currentMode = mode;
    if (mode === 'paint') {
        deselectObject();
        deselectLight();
        if (activeLeftPanel !== 'paint') showLeftTab('paint');
    } else {
        if (activeLeftPanel === 'paint') toggleLeftPanel('paint');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// CARPET & COLOR
// ══════════════════════════════════════════════════════════════════════════
function selectCarpetBrush(color) {
    activeCarpetBrushColor = color;
    const p = document.getElementById('carpet-brush-color-picker');
    const h = document.getElementById('carpet-brush-hex');
    if (p) p.value = color;
    if (h) h.innerText = color.toUpperCase() + ' (Active)';
    if (activeLeftPanel !== 'paint') showLeftTab('paint');
}

function changeSelectedColor(hex) {
    if (!selectedObject) return;
    document.getElementById('color-hex').innerText = hex.toUpperCase();
    const target = selectedObject.userData.targetColorMesh || selectedObject;
    if (target.isMesh && !Array.isArray(target.material)) { target.material.color.set(hex); return; }
    target.traverse(c => { if (c.isMesh && !Array.isArray(c.material) && c.material.metalness < 0.5) c.material.color.set(hex); });
}

// ══════════════════════════════════════════════════════════════════════════
// TEXTURE
// ══════════════════════════════════════════════════════════════════════════
function uploadTexture(input) {
    if (!selectedObject || !input.files?.[0]) return;
    const reader = new FileReader();
    reader.onload = e => { const img = new Image(); img.src = e.target.result; img.onload = () => { const t = new THREE.Texture(img); t.needsUpdate = true; applyTextureToObject(selectedObject, t); }; };
    reader.readAsDataURL(input.files[0]);
}

function applyTextureToObject(obj, texture) {
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    if (Array.isArray(obj.material)) { if (obj.material[4]) { obj.material[4].map = texture; obj.material[4].needsUpdate = true; } }
    else if (obj.material) { obj.material.map = texture; obj.material.needsUpdate = true; }
}

// ══════════════════════════════════════════════════════════════════════════
// CAMERA
// ══════════════════════════════════════════════════════════════════════════
function setCameraAngle(angle) {
    const of = Math.max(spaceWidth, spaceLength) * 0.9;
    if (controls) controls.target.set(0, 1, 0);
    switch (angle) {
        case 'top':              camera.position.set(0,   of*1.5, 0.01); break;
        case 'isometric_left':  camera.position.set(-of, of*0.7, of*0.8); break;
        case 'isometric_right': camera.position.set(of,  of*0.7, of*0.8); break;
    }
    if (controls) controls.update();

    // Update active button state in bottom toolbar
    const map = { 'top': 'top', 'isometric_left': 'left', 'isometric_right': 'right' };
    ['top', 'left', 'right'].forEach(a => {
        const btn = document.getElementById(`cam-angle-${a}`);
        if (btn) {
            if (map[angle] === a) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        }
    });
}

function toggleAutoRotate() {
    autoRotateEnabled = !autoRotateEnabled;
    controls.autoRotate = autoRotateEnabled;
    const btn = document.getElementById('btn-auto-rotate-bottom');
    if (btn) {
        btn.classList.toggle('active', autoRotateEnabled);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// LIGHT / DARK MODE
// ══════════════════════════════════════════════════════════════════════════
function toggleLightMode() {
    isLightMode = !isLightMode;
    document.body.classList.toggle('light-mode', isLightMode);
    if (scene) {
        const bg = isLightMode ? 0xf2ede4 : 0x0a0b0d;
        scene.background = new THREE.Color(bg);
        if (scene.fog) scene.fog.color.set(bg);
    }
    const moonIcon = document.getElementById('theme-icon-moon');
    const sunIcon = document.getElementById('theme-icon-sun');
    if (moonIcon && sunIcon) {
        if (isLightMode) {
            moonIcon.classList.add('hidden');
            sunIcon.classList.remove('hidden');
        } else {
            moonIcon.classList.remove('hidden');
            sunIcon.classList.add('hidden');
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════════════════════
function captureMockup() {
    let helper = null;
    if (selectedObject?.userData?.outlineHelper) { helper = selectedObject.userData.outlineHelper; scene.remove(helper); }
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    if (helper) scene.add(helper);
    Object.assign(document.createElement('a'), { download: `Ez3d-${spaceWidth}x${spaceLength}m.png`, href: url }).click();
}

function _serializeVec3(v) {
    return [v.x, v.y, v.z];
}

function _serializeEuler(e) {
    return [e.x, e.y, e.z, e.order];
}

function _applySerializedTransform(obj, data) {
    if (data.position) obj.position.fromArray(data.position);
    if (data.rotation) obj.rotation.set(data.rotation[0] || 0, data.rotation[1] || 0, data.rotation[2] || 0, data.rotation[3] || 'XYZ');
    if (data.scale) obj.scale.fromArray(data.scale);
}

function _getObjectColor(obj) {
    const target = obj.userData.targetColorMesh || obj;
    if (target.isMesh && !Array.isArray(target.material) && target.material?.color) {
        return '#' + target.material.color.getHexString();
    }
    let hex = null;
    target.traverse?.(c => {
        if (!hex && c.isMesh && !Array.isArray(c.material) && c.material?.color) {
            hex = '#' + c.material.color.getHexString();
        }
    });
    return hex;
}

function _setObjectColor(obj, hex) {
    if (!hex) return;
    const target = obj.userData.targetColorMesh || obj;
    if (target.isMesh && !Array.isArray(target.material) && target.material?.color) {
        target.material.color.set(hex);
        return;
    }
    target.traverse?.(c => {
        if (c.isMesh && !Array.isArray(c.material) && c.material?.color && c.material.metalness < 0.5) {
            c.material.color.set(hex);
        }
    });
}

function _serializeObject(obj) {
    const type = obj.userData?.type;
    if (!['backdrop', 'table', 'bookshelf', 'cashier', 'rollup'].includes(type)) return null;
    return {
        type,
        name: obj.name,
        position: _serializeVec3(obj.position),
        rotation: _serializeEuler(obj.rotation),
        scale: _serializeVec3(obj.scale),
        color: _getObjectColor(obj),
    };
}

function _serializeLight(entry) {
    return {
        type: entry.type,
        name: entry.name,
        props: _getLightProps(entry),
    };
}

function _serializePin(pin) {
    return {
        id: pin.id,
        position: _serializeVec3(pin.position),
        text: pin.text || '',
    };
}

function createProjectSnapshot() {
    return {
        schema: 'ez3d.project',
        version: 1,
        savedAt: new Date().toISOString(),
        space: { width: spaceWidth, length: spaceLength },
        settings: {
            gridSnapEnabled,
            gridSnapSize,
            guidesVisible,
            isLightMode,
        },
        objects: draggableObjects.map(_serializeObject).filter(Boolean),
        lights: sceneLights.map(_serializeLight),
        carpet: floorTiles.map(t => t.color),
        comments: commentPins.filter(p => !p.isEditing).map(_serializePin),
    };
}

function _queueAutosave() {
    if (_suspendAutosave || !scene) return;
    clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(_writeAutosaveNow, AUTOSAVE_DEBOUNCE_MS);
}

function _writeAutosaveNow() {
    if (_suspendAutosave || !scene) return;
    writeAutosaveDraft(createProjectSnapshot());
}

function _readAutosave() {
    return readAutosaveDraft();
}

function clearAutosaveDraft() {
    clearTimeout(_autosaveTimer);
    clearAutosaveDraftStorage();
}

function restoreAutosaveDraft() {
    const snapshot = _readAutosave();
    if (!snapshot) return false;
    loadProjectSnapshot(snapshot, { preserveAutosave: true });
    return true;
}

function _maybePromptAutosaveRestore() {
    if (_suspendAutosave) return;
    const snapshot = _readAutosave();
    if (!snapshot) return;
    const savedAt = snapshot.savedAt ? new Date(snapshot.savedAt).toLocaleString('th-TH') : 'ไม่ทราบเวลา';
    if (confirm(`พบงานร่าง Ez3d ที่บันทึกอัตโนมัติไว้เมื่อ ${savedAt}\nต้องการกู้คืนงานนี้หรือไม่?`)) {
        loadProjectSnapshot(snapshot, { preserveAutosave: true });
    } else {
        clearAutosaveDraft();
    }
}

function downloadProjectFile() {
    const snapshot = createProjectSnapshot();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
        download: `Ez3d-${spaceWidth}x${spaceLength}m.ez3d.json`,
        href: url,
    });
    a.click();
    URL.revokeObjectURL(url);
}

function _rebuildSpaceGeometry(W, L) {
    spaceWidth = Math.max(1, parseInt(W, 10) || 15);
    spaceLength = Math.max(1, parseInt(L, 10) || 15);

    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.geometry?.dispose?.();
        gridHelper.material?.dispose?.();
    }
    gridHelper = new THREE.GridHelper(150, 150, 0x1a2030, 0x0f1520);
    gridHelper.position.x = (spaceWidth % 2 !== 0) ? 0.5 : 0.0;
    gridHelper.position.y = -0.02;
    gridHelper.position.z = (spaceLength % 2 !== 0) ? 0.5 : 0.0;
    gridHelper.visible = guidesVisible;
    scene.add(gridHelper);

    generateCarpetTiles(spaceWidth, spaceLength);

    if (boundsLine) {
        scene.remove(boundsLine);
        boundsLine.geometry?.dispose?.();
        boundsLine.material?.dispose?.();
    }
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(spaceWidth, 0.04, spaceLength));
    boundsLine = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
    boundsLine.position.set(0, -0.01, 0);
    scene.add(boundsLine);

    document.getElementById('ui-current-dimensions').innerText = `${spaceWidth} × ${spaceLength} ม.`;
    document.getElementById('ui-tile-count').innerText = `${spaceWidth * spaceLength}`;
}

function _clearSceneContent() {
    deselectObject();
    deselectLight();
    [...draggableObjects].forEach(obj => _removeFromScene(obj));
    draggableObjects = [];
    [...sceneLights].forEach(entry => deleteLightEntry(entry, true));
    sceneLights = [];
    lightMarkers = [];
    commentPins = [];
    _pinId = 0;
}

function loadProjectSnapshot(snapshot, options = {}) {
    if (!snapshot || snapshot.schema !== 'ez3d.project') {
        alert('ไฟล์นี้ไม่ใช่ Ez3d project JSON ที่ถูกต้อง');
        return;
    }

    _suspendAutosave = true;
    const W = snapshot.space?.width || 15;
    const L = snapshot.space?.length || 15;
    if (!scene) {
        document.getElementById('input-width').value = W;
        document.getElementById('input-length').value = L;
        submitDimensions();
    }

    _clearSceneContent();
    _rebuildSpaceGeometry(W, L);

    (snapshot.objects || []).forEach(item => {
        const obj = spawnItem(item.type, false);
        if (!obj) return;
        obj.name = item.name || obj.name;
        _applySerializedTransform(obj, item);
        _setObjectColor(obj, item.color);
    });

    (snapshot.lights || []).forEach(item => {
        const entry = _buildLightEntry(item.type, { ...(item.props || {}), name: item.name });
        sceneLights.push(entry);
        _attachLightToScene(entry);
        _applyLightProps(entry, item.props || {});
    });

    (snapshot.carpet || []).forEach((color, idx) => {
        if (idx < floorTiles.length) _setTileColor(idx, color);
    });
    if (floorTilesMesh?.instanceColor) floorTilesMesh.instanceColor.needsUpdate = true;

    commentPins = (snapshot.comments || []).map(pin => {
        _pinId = Math.max(_pinId, pin.id || 0);
        return {
            id: pin.id,
            position: new THREE.Vector3().fromArray(pin.position || [0, 0, 0]),
            text: pin.text || '',
            isEditing: false,
        };
    });

    const settings = snapshot.settings || {};
    gridSnapEnabled = settings.gridSnapEnabled ?? gridSnapEnabled;
    gridSnapSize = settings.gridSnapSize ?? gridSnapSize;
    guidesVisible = settings.guidesVisible ?? guidesVisible;
    if ((settings.isLightMode ?? false) !== isLightMode) toggleLightMode();

    _syncGridSnapButton();
    updateLayerList();
    updateUI();
    renderCommentPins();
    _undoStack = [];
    _redoStack = [];
    _refreshUndoRedo();
    _suspendAutosave = false;
    if (!options.preserveAutosave) _queueAutosave();
}

function loadProjectFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            loadProjectSnapshot(JSON.parse(reader.result));
        } catch (err) {
            console.error('Error loading project file:', err);
            alert('โหลดไฟล์โปรเจกต์ไม่สำเร็จ กรุณาตรวจสอบไฟล์ JSON');
        }
    };
    reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════════════════════
// CUSTOM GLTF MODEL LOADER
// ══════════════════════════════════════════════════════════════════════════
function loadGLTFObject(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const loader = new GLTFLoader();
    
    // Show loader overlay
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.remove('hidden');
    
    loader.load(url, (gltf) => {
        const model = gltf.scene;
        
        // Enable shadows for custom model meshes
        model.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
        
        // Calculate dimensions
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        // Align model center X/Z and Y-bottom on floor
        model.position.x = -center.x;
        model.position.z = -center.z;
        model.position.y = -box.min.y;
        
        // Wrap in parent group for clean transformation anchors
        const wrapper = new THREE.Group();
        wrapper.add(model);
        wrapper.name = file.name.replace(/\.[^.]+$/, '');
        wrapper.userData = {
            type: 'custom',
            category: 'prop',
            baseDims: { w: size.x, h: size.y, d: size.z }
        };
        
        // Position at spawn coordinates (origin)
        wrapper.position.set(0, 0, 0);
        
        scene.add(wrapper);
        draggableObjects.push(wrapper);
        updateLayerList();
        
        _cmdAddObject(wrapper);
        selectObject(wrapper);
        URL.revokeObjectURL(url);
        
        // Hide loader overlay
        if (overlay) overlay.classList.add('hidden');
    }, undefined, (error) => {
        console.error("Error loading GLTF model:", error);
        alert("ไม่สามารถโหลดไฟล์ 3D นี้ได้ กรุณาตรวจสอบว่าเป็นไฟล์ GLTF/GLB ที่ถูกต้อง");
        
        // Hide loader overlay
        if (overlay) overlay.classList.add('hidden');
    });
}

// ══════════════════════════════════════════════════════════════════════════
// INTERACTIVE PROPOSAL MODE & 3D COMMENT PINS
// ══════════════════════════════════════════════════════════════════════════
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
}

function toggleProposalMode() {
    proposalModeActive = !proposalModeActive;
    
    const mainUI = document.getElementById('main-ui');
    const propOverlay = document.getElementById('proposal-overlay');
    const pinsOverlay = document.getElementById('pins-overlay');
    
    if (proposalModeActive) {
        // Clear selection to keep view clean
        deselectObject();
        deselectLight();
        
        if (transformControls) {
            transformControls.detach();
            transformControls.visible = false;
        }
        
        // Hide edit tools panel
        const leftPanel = document.getElementById('left-floating-panel');
        if (leftPanel) leftPanel.classList.add('hidden');
        if (activeLeftPanel) {
            const btn = document.getElementById(`tab-btn-${activeLeftPanel}`);
            if (btn) btn.classList.remove('active');
            activeLeftPanel = null;
        }
        
        if (mainUI) mainUI.classList.add('hidden');
        if (propOverlay) propOverlay.classList.remove('hidden');
        if (pinsOverlay) pinsOverlay.style.pointerEvents = 'auto'; // allow clicking on pins
        
        document.body.classList.add('proposal-mode');
        
        // Fill dimensions
        const dimSpan = document.getElementById('prop-dimensions');
        if (dimSpan) dimSpan.innerText = `${spaceWidth} × ${spaceLength} ม.`;
        
        updateProposalInventory();
        updateProposalCostEstimate();
        updateProposalCommentsList();
        renderCommentPins();
    } else {
        commentPinModeActive = false;
        
        // Turn off pin mode active styling
        const btnPin = document.getElementById('prop-btn-pin');
        const btnPinText = document.getElementById('prop-pin-btn-text');
        if (btnPin) btnPin.classList.remove('active');
        if (btnPinText) btnPinText.innerText = "ปักหมุด (Pin Comment)";
        
        if (mainUI) mainUI.classList.remove('hidden');
        if (propOverlay) propOverlay.classList.add('hidden');
        if (pinsOverlay) {
            pinsOverlay.style.pointerEvents = 'none';
            pinsOverlay.innerHTML = ''; // Hide all pins
        }
        
        document.body.classList.remove('proposal-mode');
        
        // Clear active states of comment pins
        commentPins.forEach(p => { p.isEditing = false; });
        
        // Refresh editor UI
        updateUI();
    }
}

function toggleCommentPinMode() {
    if (!proposalModeActive) return;
    commentPinModeActive = !commentPinModeActive;
    
    const btn = document.getElementById('prop-btn-pin');
    const btnText = document.getElementById('prop-pin-btn-text');
    
    if (btn) {
        if (commentPinModeActive) {
            btn.classList.add('active');
            if (btnText) btnText.innerText = "โหมดปักหมุด: เปิดอยู่";
        } else {
            btn.classList.remove('active');
            if (btnText) btnText.innerText = "ปักหมุด (Pin Comment)";
        }
    }
}

function renderCommentPins() {
    const container = document.getElementById('pins-overlay');
    if (!container) return;
    
    container.innerHTML = '';
    if (!proposalModeActive) return;
    
    commentPins.forEach(pin => {
        const pinEl = document.createElement('div');
        pinEl.id = `pin-dom-${pin.id}`;
        pinEl.className = 'comment-pin animate-bounce';
        if (pin.isEditing) pinEl.classList.add('active');
        
        // Pin ID display
        pinEl.innerText = pin.id;
        
        // Tooltip container
        const tooltip = document.createElement('div');
        tooltip.className = 'comment-tooltip';
        tooltip.style.display = 'block'; // Ensure we control visibility directly
        
        if (pin.isEditing) {
            tooltip.innerHTML = `
                <div class="flex flex-col gap-1.5 pointer-events-auto">
                    <div class="font-bold text-[10px] text-cyan-400 mb-0.5">เพิ่มคำเสนอแนะ (หมุด #${pin.id})</div>
                    <textarea class="w-full bg-white/10 border border-white/20 rounded p-1.5 text-white text-[10px] resize-none outline-none focus:border-cyan-500/50" rows="2" placeholder="เขียนความเห็นของคุณ..." style="font-family: inherit; color: #fff;"></textarea>
                    <div class="flex justify-end gap-1 mt-1">
                        <button onclick="savePin(${pin.id}, this)" class="bg-cyan-500 hover:bg-cyan-600 text-white rounded px-2.5 py-1 text-[9px] font-medium transition-all">บันทึก</button>
                        <button onclick="cancelPin(${pin.id})" class="bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded px-2.5 py-1 text-[9px] font-medium transition-all">ยกเลิก</button>
                    </div>
                </div>
            `;
            tooltip.addEventListener('pointerdown', e => e.stopPropagation());
            tooltip.addEventListener('click', e => e.stopPropagation());
        } else {
            tooltip.innerHTML = `
                <div class="space-y-1 pointer-events-auto select-text">
                    <div class="font-bold text-cyan-400 text-[10px]">หมุดที่ #${pin.id}</div>
                    <div class="text-white/90 text-xs leading-relaxed break-words max-h-32 overflow-y-auto">${escapeHTML(pin.text)}</div>
                    <div class="flex justify-between items-center mt-2 pt-1 border-t border-white/5">
                        <button onclick="focusCameraOnPin(${pin.id})" class="text-cyan-400 hover:underline text-[9px]">ดูตำแหน่ง</button>
                        <button onclick="deletePin(${pin.id})" class="text-red-400 hover:text-red-300 hover:underline text-[9px]">ลบออก</button>
                    </div>
                </div>
            `;
            tooltip.addEventListener('pointerdown', e => e.stopPropagation());
            tooltip.addEventListener('click', e => e.stopPropagation());
        }
        
        pinEl.appendChild(tooltip);
        
        pinEl.addEventListener('click', (e) => {
            e.stopPropagation();
            focusCameraOnPin(pin.id);
        });
        
        container.appendChild(pinEl);
    });
}

function savePin(id, btn) {
    const pin = commentPins.find(p => p.id === id);
    if (!pin) return;
    
    const textarea = btn.closest('.comment-tooltip').querySelector('textarea');
    const text = textarea.value.trim();
    
    if (!text) {
        alert("กรุณากรอกข้อความความคิดเห็น");
        return;
    }
    
    pin.text = text;
    pin.isEditing = false;
    
    renderCommentPins();
    updateProposalCommentsList();
}

function cancelPin(id) {
    const idx = commentPins.findIndex(p => p.id === id);
    if (idx > -1) {
        commentPins.splice(idx, 1);
    }
    renderCommentPins();
    updateProposalCommentsList();
}

function deletePin(id) {
    const idx = commentPins.findIndex(p => p.id === id);
    if (idx > -1) {
        commentPins.splice(idx, 1);
    }
    renderCommentPins();
    updateProposalCommentsList();
}

function focusCameraOnPin(id) {
    const pin = commentPins.find(p => p.id === id);
    if (!pin) return;
    
    // Highlight pin DOM element as active
    document.querySelectorAll('.comment-pin').forEach(el => {
        el.classList.remove('active');
    });
    
    const activeEl = document.getElementById(`pin-dom-${pin.id}`);
    if (activeEl) {
        activeEl.classList.add('active');
    }
    
    // Cancel previous tween if any to prevent race conditions
    if (cameraTweenId) {
        cancelAnimationFrame(cameraTweenId);
        cameraTweenId = null;
    }
    
    // Smooth transition
    if (controls && camera) {
        const targetPos = pin.position.clone();
        const duration = 800;
        const startTarget = controls.target.clone();
        const startCam = camera.position.clone();
        
        // Set camera offset looking down slightly
        const endCam = targetPos.clone().add(new THREE.Vector3(5, 5, 5));
        const startTime = performance.now();
        
        function smoothZoom(now) {
            const progress = Math.min((now - startTime) / duration, 1);
            const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
            
            controls.target.lerpVectors(startTarget, targetPos, ease);
            camera.position.lerpVectors(startCam, endCam, ease);
            controls.update();
            
            if (progress < 1) {
                cameraTweenId = requestAnimationFrame(smoothZoom);
            } else {
                cameraTweenId = null;
            }
        }
        
        cameraTweenId = requestAnimationFrame(smoothZoom);
    }
}

function updateProposalInventory() {
    const list = document.getElementById('prop-assets-list');
    if (!list) return;
    list.innerHTML = '';

    const items = collectProposalInventory();
    if (items.length === 0) {
        list.innerHTML = `<div class="text-white/30 text-center py-2">ไม่มีวัตถุในห้องจัดแสดง</div>`;
        return;
    }

    items.forEach(({ name, count }) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center py-1 border-b border-white/5 last:border-b-0';
        row.innerHTML = `
            <span class="text-white/80 truncate pr-2">${name}</span>
            <span class="font-bold text-cyan-400">x${count}</span>
        `;
        list.appendChild(row);
    });
}

function collectProposalInventory() {
    const counts = {};
    const typeNames = {
        backdrop: 'แบคดรอปผนัง (Backdrop)',
        table: 'โต๊ะโชว์สินค้า (Table)',
        bookshelf: 'ชั้นวางของ (Bookshelf)',
        cashier: 'เคาน์เตอร์แคชเชียร์ (Cashier)',
        rollup: 'ป้ายโรลอัปแบนเนอร์ (Rollup)',
        group: 'กลุ่มวัตถุ (Group)',
        custom: 'โมเดล 3D พิเศษ (GLTF)'
    };
    
    // Scan draggableObjects and populate counts recursively
    function scan(obj) {
        if (obj.userData?.type && obj.userData.type !== 'group') {
            const t = obj.userData.type;
            const name = typeNames[t] || obj.name || 'วัตถุอื่น ๆ';
            counts[name] = (counts[name] || 0) + 1;
        } else if (obj.userData?.type === 'group' && obj.userData.children) {
            obj.userData.children.forEach(c => scan(c));
        } else if (obj.isGroup || obj.type === 'Group') {
            obj.children.forEach(c => scan(c));
        }
    }
    
    draggableObjects.forEach(o => scan(o));
    return Object.entries(counts).map(([name, count]) => ({ name, count }));
}

function updateProposalCostEstimate() {
    const list = document.getElementById('prop-cost-estimate');
    if (!list) return;
    list.innerHTML = '';

    const { lines, totalCost } = collectProposalCostEstimate();
    lines.forEach(line => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center py-1 border-b border-white/5 last:border-b-0';
        row.innerHTML = `
            <span class="text-white/60 truncate pr-2">${line.name}</span>
            <span class="text-white/80">฿${line.cost.toLocaleString()}</span>
        `;
        list.appendChild(row);
    });

    const totalRow = document.createElement('div');
    totalRow.className = 'flex justify-between items-center pt-2 mt-2 border-t border-cyan-500/30 text-xs font-bold';
    totalRow.innerHTML = `
        <span class="text-cyan-400">รวมประมาณการทั้งสิ้น</span>
        <span class="text-cyan-300 font-mono">฿${totalCost.toLocaleString()}</span>
    `;
    list.appendChild(totalRow);
}

function collectProposalCostEstimate() {
    let totalCost = 0;
    const lines = [];
    
    // Carpet tiles
    const carpetArea = spaceWidth * spaceLength;
    const carpetPrice = carpetArea * 150;
    totalCost += carpetPrice;
    lines.push({
        name: `ปูพื้นพรม (${carpetArea} ตร.ม.)`,
        cost: carpetPrice
    });
    
    // Objects prices
    const prices = {
        backdrop: 4500,
        table: 1200,
        bookshelf: 1800,
        cashier: 2500,
        rollup: 950,
        custom: 3000
    };
    
    const typeNames = {
        backdrop: 'แบคดรอปผนัง',
        table: 'โต๊ะโชว์สินค้า',
        bookshelf: 'ชั้นวางของ',
        cashier: 'เคาน์เตอร์แคชเชียร์',
        rollup: 'ป้ายโรลอัป',
        custom: 'วัตถุโครงสร้างพิเศษ'
    };
    
    const counts = {};
    function scan(obj) {
        if (obj.userData?.type && obj.userData.type !== 'group') {
            const t = obj.userData.type;
            counts[t] = (counts[t] || 0) + 1;
        } else if (obj.userData?.type === 'group' && obj.userData.children) {
            obj.userData.children.forEach(c => scan(c));
        } else if (obj.isGroup || obj.type === 'Group') {
            obj.children.forEach(c => scan(c));
        }
    }
    
    draggableObjects.forEach(o => scan(o));
    
    Object.entries(counts).forEach(([type, count]) => {
        const unitPrice = prices[type] || 1500;
        const price = unitPrice * count;
        totalCost += price;
        lines.push({
            name: `${typeNames[type] || 'วัตถุโครงสร้างเพิ่มเติม'} (x${count})`,
            cost: price
        });
    });
    
    // Flat setup fee
    const setupFee = 2000;
    totalCost += setupFee;
    lines.push({
        name: 'ค่าติดตั้งและดำเนินการจัดแสดง',
        cost: setupFee
    });
    
    return { lines, totalCost };
}

function updateProposalCommentsList() {
    const list = document.getElementById('prop-comments-list');
    if (!list) return;
    list.innerHTML = '';
    
    const savedPins = commentPins.filter(p => !p.isEditing);
    
    if (savedPins.length === 0) {
        list.innerHTML = `
            <div class="text-center py-6 text-white/20 text-[10px]">
                <p>ยังไม่มีข้อเสนอแนะ</p>
                <p class="mt-1">คลิกปุ่มปักหมุดด้านล่างเพื่อเพิ่ม</p>
            </div>
        `;
        return;
    }
    
    savedPins.forEach(pin => {
        const item = document.createElement('div');
        item.className = 'bg-white/5 border border-white/5 hover:border-cyan-500/20 hover:bg-white/10 rounded-xl p-3 cursor-pointer transition-all flex flex-col gap-1';
        item.onclick = () => focusCameraOnPin(pin.id);
        
        item.innerHTML = `
            <div class="flex justify-between items-center">
                <span class="text-[10px] font-bold text-cyan-400 font-mono">หมุดที่ #${pin.id}</span>
                <button onclick="event.stopPropagation(); deletePin(${pin.id})" class="text-red-400/70 hover:text-red-400 text-[9px] transition-colors">ลบ</button>
            </div>
            <p class="text-white/80 text-xs leading-normal break-words">${escapeHTML(pin.text)}</p>
        `;
        list.appendChild(item);
    });
}

function _tableRowsHtml(rows, emptyText) {
    if (!rows.length) return `<tr><td colspan="2" class="muted">${escapeHTML(emptyText)}</td></tr>`;
    return rows.map(row => `
        <tr>
            <td>${escapeHTML(row.name)}</td>
            <td class="num">${row.count !== undefined ? `x${row.count}` : `฿${row.cost.toLocaleString()}`}</td>
        </tr>
    `).join('');
}

function downloadProposalSummary() {
    const inventory = collectProposalInventory();
    const cost = collectProposalCostEstimate();
    const comments = commentPins.filter(p => !p.isEditing);
    const screenshot = renderer ? renderer.domElement.toDataURL('image/png') : '';
    const generatedAt = new Date().toLocaleString('th-TH');
    const commentsHtml = comments.length
        ? comments.map(pin => `<li><strong>หมุด #${pin.id}</strong> ${escapeHTML(pin.text)}</li>`).join('')
        : '<li class="muted">ยังไม่มีข้อเสนอแนะ</li>';

    const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ez3d Proposal ${spaceWidth}x${spaceLength}m</title>
<style>
body{font-family:Inter,Arial,sans-serif;background:#f6f7f9;color:#111827;margin:0;padding:32px}
.page{max-width:980px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(15,23,42,.08)}
header{padding:28px 32px;border-bottom:1px solid #e5e7eb;background:#0b0c10;color:#fff}
h1{margin:0 0 6px;font-size:24px;letter-spacing:.02em} h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:#0891b2;margin:28px 0 10px}
.meta{font-size:12px;color:rgba(255,255,255,.65)} main{padding:28px 32px}.shot{width:100%;border-radius:10px;border:1px solid #e5e7eb;background:#111;margin-bottom:22px}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:10px 0;border-bottom:1px solid #edf0f3}.num{text-align:right;font-weight:700;color:#0e7490}.total td{font-size:15px;color:#0e7490;font-weight:800;border-bottom:0;padding-top:14px}
ul{margin:0;padding-left:20px;font-size:13px;line-height:1.7}.muted{color:#6b7280}.grid{display:grid;grid-template-columns:1fr 1fr;gap:28px}@media(max-width:760px){body{padding:12px}.grid{grid-template-columns:1fr}main,header{padding:20px}}
</style>
</head>
<body>
<div class="page">
<header><h1>Ez3d Proposal Summary</h1><div class="meta">พื้นที่ ${spaceWidth} × ${spaceLength} ม. · สร้างเมื่อ ${escapeHTML(generatedAt)}</div></header>
<main>
${screenshot ? `<img class="shot" src="${screenshot}" alt="Ez3d mockup screenshot">` : ''}
<div class="grid">
<section><h2>Assets Inventory</h2><table>${_tableRowsHtml(inventory, 'ไม่มีวัตถุในฉาก')}</table></section>
<section><h2>Cost Estimate</h2><table>${_tableRowsHtml(cost.lines, 'ไม่มีรายการค่าใช้จ่าย')}<tr class="total"><td>รวมประมาณการทั้งสิ้น</td><td class="num">฿${cost.totalCost.toLocaleString()}</td></tr></table></section>
</div>
<section><h2>Review Comments</h2><ul>${commentsHtml}</ul></section>
</main>
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
        download: `Ez3d-Proposal-${spaceWidth}x${spaceLength}m.html`,
        href: url,
    }).click();
    URL.revokeObjectURL(url);
}

function updateCommentPinsProjection() {
    if (!proposalModeActive) return;
    
    commentPins.forEach(pin => {
        const pinDom = document.getElementById(`pin-dom-${pin.id}`);
        if (!pinDom) return;
        
        const tempV = new THREE.Vector3().copy(pin.position);
        tempV.project(camera);
        
        // Z is between -1 and 1 if within view frustum
        if (tempV.z > 1) {
            pinDom.style.display = 'none';
        } else {
            const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
            const y = (tempV.y * -0.5 + 0.5) * window.innerHeight;
            pinDom.style.display = 'flex';
            pinDom.style.left = `${x}px`;
            pinDom.style.top = `${y}px`;
        }
    });
}

function toggleTurboMode() {
    turboModeEnabled = !turboModeEnabled;
    const btn = document.getElementById('turbo-toggle-btn');
    const text = document.getElementById('turbo-toggle-text');
    if (btn) {
        btn.classList.toggle('bg-yellow-500/15', turboModeEnabled);
        btn.classList.toggle('text-yellow-300', turboModeEnabled);
        btn.classList.toggle('border-yellow-500/30', turboModeEnabled);
    }
    if (text) {
        text.innerText = turboModeEnabled ? "เทอร์โบไฟ: เปิด (Turbo: ON)" : "เทอร์โบไฟ: ปิด (Turbo: OFF)";
    }
}

function _debugObjectSnapshot(obj) {
    const center = _getSelectionCenter([obj]);
    return objectDebugSnapshot(obj, center);
}

function _installDebugHooks() {
    const host = window.location.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';
    if (!isLocal) return;

    window.__ez3dDebug = {
        getState() {
            const selectionCenter = selectedObjects.length ? _getSelectionCenter() : null;
            return {
                objects: draggableObjects.map(_debugObjectSnapshot),
                selectedNames: selectedObjects.map(obj => obj.name),
                selectedObjectName: selectedObject?.name || null,
                selectedCount: selectedObjects.length,
                selectionCenter: selectionCenter ? vectorSnapshot(selectionCenter) : null,
                anchor: selectionAnchor ? {
                    position: vectorSnapshot(selectionAnchor.position),
                    rotation: { x: selectionAnchor.rotation.x, y: selectionAnchor.rotation.y, z: selectionAnchor.rotation.z },
                    scale: vectorSnapshot(selectionAnchor.scale),
                } : null,
                transformMode: transformControls?.mode || null,
            };
        },
        selectByName(names) {
            const list = Array.isArray(names) ? names : [names];
            const targets = list
                .map(name => draggableObjects.find(obj => obj.name === name))
                .filter(Boolean);
            if (targets.length === 0) return false;
            selectObject(targets[0]);
            targets.slice(1).forEach(obj => selectObject(obj, true));
            return targets.length === list.length;
        },
        flushAutosave() {
            clearTimeout(_autosaveTimer);
            _writeAutosaveNow();
            return _readAutosave();
        },
        clearAutosave: clearAutosaveDraft,
        restoreAutosave: restoreAutosaveDraft,
    };
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER LOOP
// ══════════════════════════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);
    if (selectedObject?.userData?.outlineHelper) selectedObject.userData.outlineHelper.update();
    
    // Update all light helpers only if Turbo mode is enabled (optimized performance)
    if (turboModeEnabled) {
        sceneLights.forEach(e => { if (e.helper?.update) e.helper.update(); });
    }
    
    // Update comment pins projection in proposal mode
    updateCommentPinsProjection();
    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
}

// ══════════════════════════════════════════════════════════════════════════
// GLOBAL BINDINGS (accessible from HTML onclick)
// ══════════════════════════════════════════════════════════════════════════
const _g = window;
_g.submitDimensions    = submitDimensions;
_g.spawnItem           = spawnItem;
_g.setMode             = setMode;
_g.showLeftTab         = showLeftTab;
_g.applyLayoutTemplate = applyLayoutTemplate;
_g.selectCarpetBrush   = selectCarpetBrush;
_g.deleteSelectedItem  = deleteSelectedItem;
_g.clearAllWorkspace   = clearAllWorkspace;
_g.changeSelectedColor = changeSelectedColor;
_g.uploadTexture       = uploadTexture;
_g.setCameraAngle      = setCameraAngle;
_g.captureMockup       = captureMockup;
_g.createProjectSnapshot = createProjectSnapshot;
_g.loadProjectSnapshot = loadProjectSnapshot;
_g.restoreAutosaveDraft = restoreAutosaveDraft;
_g.clearAutosaveDraft = clearAutosaveDraft;
_g.downloadProjectFile = downloadProjectFile;
_g.loadProjectFile     = loadProjectFile;
_g.duplicateSelected   = duplicateSelected;
_g.toggleLightMode     = toggleLightMode;
_g.toggleAutoRotate    = toggleAutoRotate;
_g.undo = undo; _g.redo = redo;
_g.applyRotation       = applyRotation;
_g.setPositionX=setPositionX; _g.setPositionY=setPositionY; _g.setPositionZ=setPositionZ;
_g.setRotationX=setRotationX; _g.setRotationY=setRotationY; _g.setRotationZ=setRotationZ;
_g.setScaleX=setScaleX; _g.setScaleY=setScaleY; _g.setScaleZ=setScaleZ;
_g.setDimW=setDimW; _g.setDimH=setDimH; _g.setDimD=setDimD;
// Light system
_g.addLight           = addLight;
_g.deleteLightEntry   = deleteLightEntry;
_g.applyLightPreset   = applyLightPreset;
_g.setLightColor      = setLightColor;
_g.setLightIntensity  = setLightIntensity;
_g.setLightVisible    = setLightVisible;
_g.setLightShadow     = setLightShadow;
_g.setLightPosX=setLightPosX; _g.setLightPosY=setLightPosY; _g.setLightPosZ=setLightPosZ;
_g.setLightTgtX=setLightTgtX; _g.setLightTgtY=setLightTgtY; _g.setLightTgtZ=setLightTgtZ;
_g.setLightAngle=setLightAngle; _g.setLightPenumbra=setLightPenumbra; _g.setLightDistance=setLightDistance;
_g.setLightSkyColor=setLightSkyColor; _g.setLightGroundColor=setLightGroundColor;
_g.renameLightEntry=renameLightEntry;
_g.toggleLeftPanel     = toggleLeftPanel;
_g.loadGLTFObject      = loadGLTFObject;
_g.paintAllTiles       = paintAllTiles;
_g.setGizmoMode        = setGizmoMode;
_g.toggleGuides        = toggleGuides;
_g.toggleGridSnap      = toggleGridSnap;

// Group & Proposal features
_g.groupSelected       = groupSelected;
_g.ungroupSelected     = ungroupSelected;
_g.toggleProposalMode  = toggleProposalMode;
_g.downloadProposalSummary = downloadProposalSummary;
_g.toggleCommentPinMode= toggleCommentPinMode;
_g.savePin             = savePin;
_g.cancelPin           = cancelPin;
_g.deletePin           = deletePin;
_g.focusCameraOnPin    = focusCameraOnPin;
_g.toggleTurboMode     = toggleTurboMode;
_g.beginLightUndo      = beginLightUndo;
_g.commitLightUndo     = commitLightUndo;
_installDebugHooks();
window.addEventListener('beforeunload', () => {
    clearTimeout(_autosaveTimer);
    _writeAutosaveNow();
});
