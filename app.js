// Ez3d — Exhibition Space 3D Mockup Studio
// v3.0 — Command Pattern Undo/Redo · Full Lighting System · Auto-rotate
// ═══════════════════════════════════════════════════════════════════════

// ─── Core Variables ──────────────────────────────────────────────────────
let scene, camera, renderer, controls;
let draggableObjects = [];
let floorTiles = [];
let selectedObject = null;
let selectedLight = null;
let isDragging = false;
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

// ─── App State ────────────────────────────────────────────────────────────
let currentMode         = 'objects';
let activeCarpetBrushColor = '#374151';
let spaceWidth  = 16;
let spaceLength = 3;
let gridSnapSize    = 0.5;
let gridSnapEnabled = true;
let isLightMode     = false;
let autoRotateEnabled = false;
let _tilePaintBatch = []; // group tile paints into one undo entry

// ─── Base physical dimensions at scale(1,1,1) in meters ───────────────────
const BASE_DIMS = {
    backdrop:  { w: 1,   h: 2.5,  d: 0.15 },
    table:     { w: 1.5, h: 0.76, d: 0.75 },
    bookshelf: { w: 1.4, h: 1.0,  d: 1.0  },
    cashier:   { w: 1.0, h: 0.95, d: 0.85 },
    rollup:    { w: 0.8, h: 2.0,  d: 0.05 },
};

// ─── Procedural textures ──────────────────────────────────────────────────
const texturePresets = {
    sample_naiin: createNaiinPresetTexture(),
    sample_kids:  createKidsPresetTexture(),
};

// ══════════════════════════════════════════════════════════════════════════
// COMMAND PATTERN — UNDO / REDO
// ══════════════════════════════════════════════════════════════════════════
function _pushCmd(cmd) {
    _undoStack.push(cmd);
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    _redoStack = [];
    _refreshUndoRedo();
}

function undo() {
    if (!_undoStack.length) return;
    const cmd = _undoStack.pop();
    cmd.undo();
    _redoStack.push(cmd);
    _refreshUndoRedo();
}

function redo() {
    if (!_redoStack.length) return;
    const cmd = _redoStack.pop();
    cmd.redo();
    _undoStack.push(cmd);
    _refreshUndoRedo();
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
}

function _commitDrag() {
    if (!_dragStart) return;
    const { obj, pos, rot, scl } = _dragStart;
    _dragStart = null;
    const newPos = obj.position.clone();
    const newRot = new THREE.Euler(obj.rotation.x, obj.rotation.y, obj.rotation.z, obj.rotation.order);
    const newScl = obj.scale.clone();
    if (pos.distanceTo(newPos) < 0.001 && scl.distanceTo(newScl) < 0.001 &&
        Math.abs(rot.y - newRot.y) < 0.001) return; // no meaningful change
    _pushCmd({
        undo() { obj.position.copy(pos); obj.rotation.copy(rot); obj.scale.copy(scl); if (selectedObject === obj) syncTransformPanel(); },
        redo() { obj.position.copy(newPos); obj.rotation.copy(newRot); obj.scale.copy(newScl); if (selectedObject === obj) syncTransformPanel(); }
    });
}

// Command: Light property change
function _cmdLightProp(entry, prevProps, newProps) {
    _pushCmd({
        undo() { _applyLightProps(entry, prevProps); syncLightPanel(); },
        redo() { _applyLightProps(entry, newProps);  syncLightPanel(); }
    });
}

// Command: Tile paint batch
function _commitTileBatch() {
    if (!_tilePaintBatch.length) return;
    const batch = [..._tilePaintBatch];
    _tilePaintBatch = [];
    _pushCmd({
        undo() { batch.forEach(b => { b.tile.material.color.set(b.prevColor); b.tile.material.emissive.set(b.prevEmissive); }); },
        redo() { batch.forEach(b => { b.tile.material.color.set(b.nextColor); b.tile.material.emissive.set(b.nextEmissive); }); }
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
    if (selectedObject === obj) { selectedObject = null; updateUI(); }
}

// ══════════════════════════════════════════════════════════════════════════
// SETUP MODAL
// ══════════════════════════════════════════════════════════════════════════
function submitDimensions() {
    let w = parseInt(document.getElementById('input-width').value)  || 16;
    let l = parseInt(document.getElementById('input-length').value) || 3;
    w = Math.max(2, Math.min(50, w));
    l = Math.max(1, Math.min(15, l));
    spaceWidth  = w;
    spaceLength = l;

    document.getElementById('ui-current-dimensions').innerText = `${w} × ${l} ม.`;
    document.getElementById('ui-tile-count').innerText = `${w * l}`;
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('main-ui').classList.remove('hidden');
    init3D(w, l);
}

// ══════════════════════════════════════════════════════════════════════════
// 3D ENGINE INIT
// ══════════════════════════════════════════════════════════════════════════
function init3D(W, L) {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0b0d);
    scene.fog = new THREE.FogExp2(0x0a0b0d, 0.012);

    camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 1000);

    const canvas = document.getElementById('canvas3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled  = true;
    renderer.shadowMap.type     = THREE.PCFSoftShadowMap;
    // Research-backed: ACES tone mapping gives cinematic quality for exhibition scenes
    renderer.toneMapping        = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    controls = new THREE.OrbitControls(camera, renderer.domElement);
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

    // Grid
    const grid = new THREE.GridHelper(150, 75, 0x1a2030, 0x0f1520);
    grid.position.y = -0.02;
    scene.add(grid);

    // Floor tiles
    generateCarpetTiles(W, L);

    // Bounds
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 0.04, L));
    const line  = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
    line.position.set(0, -0.01, 0);
    scene.add(line);

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
    applyTextureToObject(backdrop, texturePresets.sample_naiin);

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

    updateLayerList();
    animate();
}

// ─── Floor Tiles ──────────────────────────────────────────────────────────
function generateCarpetTiles(W, L) {
    floorTiles.forEach(t => scene.remove(t));
    floorTiles = [];
    const geo = new THREE.BoxGeometry(0.96, 0.02, 0.96);
    for (let i = 0; i < W; i++) {
        for (let j = 0; j < L; j++) {
            const mat = new THREE.MeshStandardMaterial({
                color: 0x27272a, roughness: 0.9, metalness: 0.05,
                emissive: 0x09090b, emissiveIntensity: 0.15,
            });
            const tile = new THREE.Mesh(geo, mat);
            tile.position.set(i - W/2 + 0.5, -0.01, j - L/2 + 0.5);
            tile.receiveShadow = true;
            tile.userData = { type: 'floor_tile', tileIdx: floorTiles.length };
            scene.add(tile);
            floorTiles.push(tile);
        }
    }
}

// ─── Resize ───────────────────────────────────────────────────────────────
function onWindowResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
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
function onPointerDown(event) {
    if (event.target.id !== 'canvas3d') return;
    mouse.x = (event.clientX / innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    // ── PAINT MODE
    if (currentMode === 'paint') {
        const hits = raycaster.intersectObjects(floorTiles);
        if (hits.length > 0) {
            event.stopPropagation();
            paintTile(hits[0].object, true); // true = start new batch
        }
        return;
    }

    // ── OBJECTS
    const objHits = raycaster.intersectObjects(draggableObjects, true);
    if (objHits.length > 0) {
        let target = objHits[0].object;
        while (target && !draggableObjects.includes(target)) target = target.parent;
        if (target) {
            event.stopPropagation();
            deselectLight();
            selectObject(target);
            isDragging = true;
            controls.enabled = false;
            _recordDragStart(target);
            const ph = raycaster.intersectObject(plane);
            if (ph.length > 0) { dragOffset.copy(target.position).sub(ph[0].point); dragOffset.y = 0; }
            return;
        }
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
    mouse.x = (event.clientX / innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / innerHeight) * 2 + 1;

    // Drag-paint
    if (currentMode === 'paint' && event.buttons === 1) {
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(floorTiles);
        if (hits.length > 0) paintTile(hits[0].object, false);
        return;
    }

    if (!isDragging || !selectedObject) return;
    raycaster.setFromCamera(mouse, camera);
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
        syncTransformPanel();
    }
}

function onPointerUp() {
    isDragging = false;
    controls.enabled = true;
    _commitDrag();
    _commitTileBatch();
}

// ─── Keyboard ────────────────────────────────────────────────────────────
function onKeyDown(e) {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
    if ((e.ctrlKey||e.metaKey) && e.key==='z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey||e.metaKey) && (e.key==='y'||(e.shiftKey&&e.key==='Z'))) { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey||e.metaKey) && e.key==='d') { e.preventDefault(); duplicateSelected(); return; }
    switch (e.key) {
        case 'Delete': case 'Backspace': deleteSelectedItem(); break;
        case 'Escape': deselectObject(); deselectLight(); break;
        case 'r': case 'R':
            if (selectedObject) { _recordDragStart(selectedObject); selectedObject.rotation.y += Math.PI/4; _commitDrag(); syncTransformPanel(); }
            break;
        case 'g': case 'G':
            gridSnapEnabled = !gridSnapEnabled;
            const sb = document.getElementById('snap-toggle-btn');
            if (sb) sb.textContent = gridSnapEnabled ? '⊞ Snap: ON' : '⊟ Snap: OFF';
            break;
        case 'a': case 'A': toggleAutoRotate(); break;
    }
}

// ─── Tile Paint ───────────────────────────────────────────────────────────
let _paintedThisStroke = new Set();
function paintTile(tile, newStroke) {
    if (newStroke) _paintedThisStroke = new Set();
    if (_paintedThisStroke.has(tile)) return;
    _paintedThisStroke.add(tile);

    // Record previous state for undo
    const prevColor   = '#' + tile.material.color.getHexString();
    const prevEmissive = '#' + tile.material.emissive.getHexString();

    tile.material.color.set(activeCarpetBrushColor);
    const isWhite = activeCarpetBrushColor === '#ffffff';
    tile.material.emissive.set(isWhite ? '#444444' : activeCarpetBrushColor);
    tile.material.emissiveIntensity = 0.2;

    const nextColor   = '#' + tile.material.color.getHexString();
    const nextEmissive = '#' + tile.material.emissive.getHexString();

    // Only add to batch if color actually changed
    if (prevColor !== nextColor) {
        _tilePaintBatch.push({ tile, prevColor, prevEmissive, nextColor, nextEmissive });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// OBJECT SELECTION
// ══════════════════════════════════════════════════════════════════════════
function selectObject(obj) {
    if (selectedObject === obj) return;
    if (selectedObject) _clearOutline(selectedObject);
    selectedObject = obj;
    obj.userData.outlineHelper = new THREE.BoxHelper(obj, 0x06b6d4);
    scene.add(obj.userData.outlineHelper);
    if (currentMode === 'paint') setMode('objects');
    updateUI();
    updateLayerList();
}

function deselectObject() {
    if (!selectedObject) return;
    _clearOutline(selectedObject);
    selectedObject = null;
    updateUI();
    updateLayerList();
}

function _clearOutline(obj) {
    if (obj?.userData?.outlineHelper) {
        scene.remove(obj.userData.outlineHelper);
        obj.userData.outlineHelper.dispose();
        delete obj.userData.outlineHelper;
    }
}

function duplicateSelected() {
    if (!selectedObject) return;
    const n = spawnItem(selectedObject.userData.type, false);
    if (n) {
        n.position.copy(selectedObject.position); n.position.x += 1;
        n.rotation.copy(selectedObject.rotation); n.scale.copy(selectedObject.scale);
        _cmdAddObject(n);
        selectObject(n);
    }
}

function deleteSelectedItem() {
    if (selectedObject) {
        _cmdRemoveObject(selectedObject);
        _removeFromScene(selectedObject);
        selectedObject = null;
        updateUI(); updateLayerList();
    } else if (selectedLight) {
        deleteLightEntry(selectedLight);
    }
}

function clearAllWorkspace() {
    deselectObject(); deselectLight();
    [...draggableObjects].forEach(obj => _removeFromScene(obj));
    draggableObjects = [];
    updateLayerList();
    _undoStack = []; _redoStack = [];
    _refreshUndoRedo();
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

    const name = props.name || `${type[0].toUpperCase() + type.slice(1)} Light #${++_lightId}`;
    return { id: _lightId, type, name, light, helper: null, marker: null };
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

    if (helper) { scene.add(helper); entry.helper = helper; }

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
        entry.marker.material.visible = true;
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
    _pushCmd({
        undo() { _applyLightProps(entry, prev); syncLightPanel(); },
        redo() { _applyLightProps(entry, next); syncLightPanel(); }
    });
}

function setLightColor(hex) {
    if (!selectedLight) return;
    selectedLight.light.color.set(hex);
    updateLightHelper(selectedLight);
}
function setLightIntensity(v) {
    if (!selectedLight) return;
    selectedLight.light.intensity = parseFloat(v) || 0;
}
function setLightVisible(v) {
    if (!selectedLight) return;
    selectedLight.light.visible = v;
    if (selectedLight.helper) selectedLight.helper.visible = v;
    if (selectedLight.marker) selectedLight.marker.visible = v && selectedLight === selectedLight; // keep marker
}
function setLightShadow(v) {
    if (!selectedLight) return;
    selectedLight.light.castShadow = v;
}
function setLightPosX(v){ if(selectedLight?.light?.position) { selectedLight.light.position.x = parseFloat(v)||0; updateLightHelper(selectedLight); syncLightPanel(); }}
function setLightPosY(v){ if(selectedLight?.light?.position) { selectedLight.light.position.y = parseFloat(v)||0; updateLightHelper(selectedLight); syncLightPanel(); }}
function setLightPosZ(v){ if(selectedLight?.light?.position) { selectedLight.light.position.z = parseFloat(v)||0; updateLightHelper(selectedLight); syncLightPanel(); }}
function setLightTgtX(v){ if(selectedLight?.light?.target) { selectedLight.light.target.position.x = parseFloat(v)||0; updateLightHelper(selectedLight); }}
function setLightTgtY(v){ if(selectedLight?.light?.target) { selectedLight.light.target.position.y = parseFloat(v)||0; updateLightHelper(selectedLight); }}
function setLightTgtZ(v){ if(selectedLight?.light?.target) { selectedLight.light.target.position.z = parseFloat(v)||0; updateLightHelper(selectedLight); }}
function setLightAngle(v)    { if(selectedLight?.light) { selectedLight.light.angle    = THREE.MathUtils.degToRad(parseFloat(v)||30); updateLightHelper(selectedLight); }}
function setLightPenumbra(v) { if(selectedLight?.light) { selectedLight.light.penumbra = Math.max(0, Math.min(1, parseFloat(v)||0.2)); updateLightHelper(selectedLight); }}
function setLightDistance(v) { if(selectedLight?.light) { selectedLight.light.distance = parseFloat(v)||0; updateLightHelper(selectedLight); }}
function setLightSkyColor(hex)    { if(selectedLight?.light) selectedLight.light.color.set(hex); }
function setLightGroundColor(hex) { if(selectedLight?.light?.groundColor) selectedLight.light.groundColor.set(hex); }
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
    if (!selectedObject) {
        unsel.classList.remove('hidden');
        objSel.classList.add('hidden');
        lightSel.classList.add('hidden');
        return;
    }
    unsel.classList.add('hidden');
    lightSel.classList.add('hidden');
    objSel.classList.remove('hidden');

    const type = selectedObject.userData.type;
    document.getElementById('selected-title').innerText = selectedObject.name;
    document.getElementById('selected-badge').innerText = type.toUpperCase();

    const colorCtrl   = document.getElementById('control-color');
    const textureCtrl = document.getElementById('control-texture');
    if (['table','bookshelf','cashier'].includes(type)) {
        colorCtrl.classList.remove('hidden');
        textureCtrl.classList.add('hidden');
        const src = selectedObject.userData.targetColorMesh || selectedObject;
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
}

function _tf(fn) {
    if (!selectedObject) return;
    _recordDragStart(selectedObject);
    fn(selectedObject);
    _commitDrag();
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
        objHeader.textContent = '📦 วัตถุ';
        c.appendChild(objHeader);

        const objIcons = {backdrop:'🖼️', table:'🪑', bookshelf:'📚', cashier:'🖥️', rollup:'🪧'};
        [...draggableObjects].reverse().forEach(obj => {
            const sel = obj === selectedObject;
            const item = document.createElement('div');
            item.className = 'flex items-center space-x-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all text-xs border ' +
                (sel ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300' : 'bg-white/5 border-transparent hover:bg-white/10 text-white/75');
            item.onclick = () => { showLeftTab('layers'); selectObject(obj); };
            item.innerHTML = `<span class="text-sm flex-shrink-0">${objIcons[obj.userData.type]||'📦'}</span><span class="flex-1 truncate font-medium">${obj.name}</span>${sel?'<span class="text-cyan-400 text-[9px]">✓</span>':''}`;
            c.appendChild(item);
        });
    }

    // ── Lights section
    if (sceneLights.length) {
        const lHeader = document.createElement('div');
        lHeader.className = 'section-label mb-1 mt-3';
        lHeader.textContent = '💡 แสง';
        c.appendChild(lHeader);

        [...sceneLights].reverse().forEach(entry => {
            const sel = entry === selectedLight;
            const item = document.createElement('div');
            item.className = 'flex items-center space-x-2 px-2.5 py-1.5 rounded-xl cursor-pointer transition-all text-xs border ' +
                (sel ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300' : 'bg-white/5 border-transparent hover:bg-white/10 text-white/75');
            item.onclick = () => { showLeftTab('layers'); selectLight(entry); };
            item.innerHTML = `<span class="text-sm flex-shrink-0">${LIGHT_ICONS[entry.type]||'💡'}</span><span class="flex-1 truncate font-medium">${entry.name}</span>${sel?'<span class="text-yellow-400 text-[9px]">✓</span>':''}`;
            c.appendChild(item);
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════
// MODE & TABS
// ══════════════════════════════════════════════════════════════════════════
function showLeftTab(tab) {
    const act  = 'py-3 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all flex-1';
    const inact = 'py-3 text-[10px] font-bold uppercase tracking-wider text-white/50 hover:text-white transition-all flex-1';
    document.getElementById('tab-assets').className  = tab==='assets'  ? act : inact;
    document.getElementById('tab-layers').className  = tab==='layers'  ? act : inact;
    document.getElementById('panel-assets').classList.toggle('hidden',  tab!=='assets');
    document.getElementById('panel-layers').classList.toggle('hidden',  tab!=='layers');
    if (tab === 'layers') updateLayerList();
}

function setMode(mode) {
    currentMode = mode;
    const act  = 'py-3 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all flex-1';
    const inact = 'py-3 text-[10px] font-bold uppercase tracking-wider text-white/50 hover:text-white transition-all flex-1';
    document.getElementById('tab-edit').className  = mode==='objects' ? act : inact;
    document.getElementById('tab-paint').className = mode==='paint'   ? act : inact;
    document.getElementById('panel-object-mode').classList.toggle('hidden',  mode==='paint');
    document.getElementById('panel-paint-mode').classList.toggle('hidden',   mode!=='paint');
    if (mode === 'paint') { deselectObject(); deselectLight(); }
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
    if (currentMode !== 'paint') setMode('paint');
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

function applyPresetTexture(key) { if (selectedObject && texturePresets[key]) applyTextureToObject(selectedObject, texturePresets[key]); }

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
}

function toggleAutoRotate() {
    autoRotateEnabled = !autoRotateEnabled;
    controls.autoRotate = autoRotateEnabled;
    const btn = document.getElementById('btn-auto-rotate');
    if (btn) {
        btn.textContent = autoRotateEnabled ? '⏸ Stop Rotate' : '🔄 Auto Rotate';
        btn.classList.toggle('bg-cyan-500/20', autoRotateEnabled);
        btn.classList.toggle('border-cyan-500/40', autoRotateEnabled);
        btn.classList.toggle('text-cyan-300', autoRotateEnabled);
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
    const btn = document.getElementById('light-mode-btn');
    if (btn) btn.textContent = isLightMode ? '🌙 Dark' : '☀️ Light';
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

// ══════════════════════════════════════════════════════════════════════════
// PROCEDURAL TEXTURES
// ══════════════════════════════════════════════════════════════════════════
function createNaiinPresetTexture() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle='#0f172a'; ctx.fillRect(0,0,2048,256);
    ctx.fillStyle='#f97316'; ctx.beginPath(); ctx.moveTo(100,0); ctx.lineTo(250,0); ctx.lineTo(150,256); ctx.lineTo(0,256); ctx.fill();
    ctx.fillStyle='#ea580c'; ctx.beginPath(); ctx.moveTo(250,0); ctx.lineTo(350,0); ctx.lineTo(250,256); ctx.lineTo(150,256); ctx.fill();
    ctx.strokeStyle='#06b6d4'; ctx.lineWidth=4; ctx.strokeRect(550,40,948,176);
    ctx.fillStyle='#ffffff'; ctx.font='bold 56px sans-serif'; ctx.fillText('ร้านนายอินทร์ NAIIN ROADSHOW 2026',620,110);
    ctx.fillStyle='#f97316'; ctx.font='500 36px sans-serif'; ctx.fillText('@ MRT พหลโยธิน - ขีดความสุขของการอ่านหนังสือ',620,170);
    ctx.fillStyle='#a855f7'; ctx.beginPath(); ctx.arc(1750,128,60,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#ffffff'; ctx.font='bold 70px sans-serif'; ctx.fillText('📚',1715,150);
    return new THREE.CanvasTexture(c);
}

function createKidsPresetTexture() {
    const c = document.createElement('canvas'); c.width = 2048; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,2048,0); g.addColorStop(0,'#a855f7'); g.addColorStop(1,'#ec4899');
    ctx.fillStyle=g; ctx.fillRect(0,0,2048,256);
    ctx.fillStyle='rgba(255,255,255,0.15)';
    for(let i=0;i<15;i++){ctx.beginPath();ctx.arc(Math.random()*2048,Math.random()*256,20+Math.random()*50,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#ffffff'; ctx.shadowColor='rgba(0,0,0,0.3)'; ctx.shadowBlur=10;
    ctx.font='bold 72px sans-serif'; ctx.fillText('นายอินทร์ KIDS & MANGA FAIR 🧸',480,120);
    ctx.shadowBlur=0; ctx.fillStyle='#fef08a'; ctx.font='bold 36px sans-serif';
    ctx.fillText('ลดสูงสุด 50% • การ์ตูน วรรณกรรมเยาวชน และไลท์โนเวลครบครันที่นี่!',485,180);
    ctx.fillStyle='#fef08a'; _star(ctx,300,128,5,50,20); _star(ctx,1750,128,5,50,20);
    return new THREE.CanvasTexture(c);
}

function _star(ctx,cx,cy,spikes,outer,inner){
    let rot=Math.PI/2*3,x=cx,y=cy,step=Math.PI/spikes;
    ctx.beginPath();ctx.moveTo(cx,cy-outer);
    for(let i=0;i<spikes;i++){x=cx+Math.cos(rot)*outer;y=cy+Math.sin(rot)*outer;ctx.lineTo(x,y);rot+=step;x=cx+Math.cos(rot)*inner;y=cy+Math.sin(rot)*inner;ctx.lineTo(x,y);rot+=step;}
    ctx.lineTo(cx,cy-outer);ctx.closePath();ctx.fill();
}

// ══════════════════════════════════════════════════════════════════════════
// RENDER LOOP
// ══════════════════════════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);
    if (selectedObject?.userData?.outlineHelper) selectedObject.userData.outlineHelper.update();
    // Update all light helpers
    sceneLights.forEach(e => { if (e.helper?.update) e.helper.update(); });
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
_g.selectCarpetBrush   = selectCarpetBrush;
_g.deleteSelectedItem  = deleteSelectedItem;
_g.clearAllWorkspace   = clearAllWorkspace;
_g.changeSelectedColor = changeSelectedColor;
_g.uploadTexture       = uploadTexture;
_g.applyPresetTexture  = applyPresetTexture;
_g.setCameraAngle      = setCameraAngle;
_g.captureMockup       = captureMockup;
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
