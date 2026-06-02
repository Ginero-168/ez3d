// EventSpace 3D — v2.1
// Fix: Capture phase events so raycaster fires BEFORE OrbitControls

// ─── Core Three.js Variables ───────────────────────────────────────────────
let scene, camera, renderer, controls;
let draggableObjects = [];
let floorTiles = [];
let selectedObject = null;
let isDragging = false;
let plane;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let dragOffset = new THREE.Vector3();

// ─── State ────────────────────────────────────────────────────────────────
let currentMode = 'objects'; // 'objects' | 'paint'
let activeCarpetBrushColor = '#374151';
let spaceWidth = 16;
let spaceLength = 3;
let gridSnapSize = 0.5;
let gridSnapEnabled = true;
let isLightMode = false;

// ─── Base physical dimensions at scale(1,1,1) in meters ───────────────────
const BASE_DIMS = {
    backdrop:  { w: 1,   h: 2.5,  d: 0.15 }, // w is dynamic (spaceWidth)
    table:     { w: 1.5, h: 0.76, d: 0.75 },
    bookshelf: { w: 1.4, h: 1.0,  d: 1.0  },
    cashier:   { w: 1.0, h: 0.95, d: 0.85 },
    rollup:    { w: 0.8, h: 2.0,  d: 0.05 },
};

// ─── Procedural Textures (created once) ───────────────────────────────────
const texturePresets = {
    sample_naiin: createNaiinPresetTexture(),
    sample_kids:  createKidsPresetTexture()
};

// ══════════════════════════════════════════════════════════════════════════
// SETUP MODAL
// ══════════════════════════════════════════════════════════════════════════
function submitDimensions() {
    let w = parseInt(document.getElementById('input-width').value) || 16;
    let l = parseInt(document.getElementById('input-length').value) || 3;
    w = Math.max(2, Math.min(50, w));
    l = Math.max(1, Math.min(15, l));
    spaceWidth = w;
    spaceLength = l;

    document.getElementById('ui-current-dimensions').innerText = `${w} × ${l} เมตร`;
    document.getElementById('ui-tile-count').innerText = `${w * l} แผ่น`;
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('main-ui').classList.remove('hidden');

    init3D(w, l);
}

// ══════════════════════════════════════════════════════════════════════════
// 3D ENGINE INIT
// ══════════════════════════════════════════════════════════════════════════
function init3D(W, L) {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0b0d);
    scene.fog = new THREE.FogExp2(0x0a0b0d, 0.015);

    // Camera
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);

    // Renderer
    const canvas = document.getElementById('canvas3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Controls (added BEFORE our listeners — we'll use capture phase to override)
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.01;
    controls.minDistance = 2;
    controls.maxDistance = 100;

    // Camera position
    setCameraAngle('isometric_left');

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(W, 30, L + 15);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    const d = Math.max(W, L) * 1.2;
    Object.assign(dirLight.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);
    const spot = new THREE.SpotLight(0x00f0ff, 0.6, 50, Math.PI / 4, 0.5, 1);
    spot.position.set(0, 20, 0);
    scene.add(spot);

    // Invisible drag plane
    const pg = new THREE.PlaneGeometry(200, 200);
    pg.rotateX(-Math.PI / 2);
    plane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(plane);

    // Grid
    const grid = new THREE.GridHelper(120, 60, 0x1f2937, 0x111827);
    grid.position.y = -0.02;
    scene.add(grid);

    // Floor tiles
    generateCarpetTiles(W, L);

    // Bounds line
    const boundsEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 0.04, L));
    const boundsLine = new THREE.LineSegments(boundsEdges, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
    boundsLine.position.set(0, -0.01, 0);
    scene.add(boundsLine);

    // Default backdrop
    const backdrop = spawnItem('backdrop', false);
    backdrop.position.set(0, 1.25, -L / 2 + 0.075);
    applyTextureToObject(backdrop, texturePresets.sample_naiin);

    // ─── EVENT LISTENERS ─────────────────────────────────────────────────
    // CRITICAL FIX: Use { capture: true } so our handlers fire BEFORE OrbitControls
    // which listens in bubble phase. This lets us call stopPropagation() to
    // prevent orbit when clicking/dragging objects.
    window.addEventListener('resize', onWindowResize);
    renderer.domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    renderer.domElement.addEventListener('pointermove', onPointerMove, { capture: true });
    renderer.domElement.addEventListener('pointerup',   onPointerUp,   { capture: true });
    window.addEventListener('keydown', onKeyDown);

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
                color: 0x27272a, roughness: 0.9, metalness: 0.1,
                emissive: 0x09090b, emissiveIntensity: 0.2
            });
            const tile = new THREE.Mesh(geo, mat);
            tile.position.set(i - W / 2 + 0.5, -0.01, j - L / 2 + 0.5);
            tile.receiveShadow = true;
            tile.name = `tile_${i}_${j}`;
            tile.userData = { type: 'floor_tile' };
            scene.add(tile);
            floorTiles.push(tile);
        }
    }
}

// ─── Resize ───────────────────────────────────────────────────────────────
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ══════════════════════════════════════════════════════════════════════════
// SPAWN ITEMS
// ══════════════════════════════════════════════════════════════════════════
function spawnItem(type, selectNew = true) {
    const baseMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.1 });
    let mesh;

    switch (type) {
        case 'backdrop': {
            const W = spaceWidth;
            const geo = new THREE.BoxGeometry(W, 2.5, 0.15);
            const mats = [baseMat, baseMat, baseMat, baseMat,
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
                baseMat];
            mesh = new THREE.Mesh(geo, mats);
            mesh.name = `แบคดรอป #${countType('backdrop') + 1}`;
            mesh.userData = { type: 'backdrop', category: 'wall', baseDims: { w: W, h: 2.5, d: 0.15 } };
            break;
        }
        case 'table': {
            mesh = new THREE.Group();
            const skirtMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.7 });
            const skirt = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.72, 0.75), skirtMat);
            skirt.position.y = 0.36; skirt.castShadow = true; mesh.add(skirt);
            const top = new THREE.Mesh(
                new THREE.BoxGeometry(1.54, 0.04, 0.79),
                new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.6 })
            );
            top.position.y = 0.74; top.castShadow = true; mesh.add(top);
            mesh.name = `โต๊ะ #${countType('table') + 1}`;
            mesh.userData = { type: 'table', category: 'prop', targetColorMesh: skirt, baseDims: { w: 1.5, h: 0.76, d: 0.75 } };
            break;
        }
        case 'bookshelf': {
            mesh = new THREE.Group();
            const steps = 4, bw = 1.4, totalH = 1.0, totalD = 1.0;
            const stepH = totalH / steps, stepD = totalD / steps;
            for (let i = 0; i < steps; i++) {
                const bh = stepH * (steps - i);
                const s = new THREE.Mesh(
                    new THREE.BoxGeometry(bw, bh, stepD),
                    new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.7 })
                );
                s.position.set(0, bh / 2, -totalD / 2 + stepD * i + stepD / 2);
                s.castShadow = true; mesh.add(s);
            }
            mesh.name = `ชั้นวาง #${countType('bookshelf') + 1}`;
            mesh.userData = { type: 'bookshelf', category: 'prop', baseDims: { w: 1.4, h: 1.0, d: 1.0 } };
            break;
        }
        case 'cashier': {
            mesh = new THREE.Group();
            const baseMat2 = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
            const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 0.8), baseMat2);
            base.position.y = 0.45; base.castShadow = true; mesh.add(base);
            const cTop = new THREE.Mesh(
                new THREE.BoxGeometry(1.05, 0.05, 0.85),
                new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.3 })
            );
            cTop.position.y = 0.925; mesh.add(cTop);
            const mon = new THREE.Mesh(
                new THREE.BoxGeometry(0.3, 0.2, 0.05),
                new THREE.MeshBasicMaterial({ color: 0x111111 })
            );
            mon.position.set(0.1, 1.15, -0.1); mon.rotation.y = -Math.PI / 12; mesh.add(mon);
            mesh.name = `แคชเชียร์ #${countType('cashier') + 1}`;
            mesh.userData = { type: 'cashier', category: 'prop', targetColorMesh: base, baseDims: { w: 1.0, h: 0.95, d: 0.85 } };
            break;
        }
        case 'rollup': {
            const geo = new THREE.BoxGeometry(0.8, 2.0, 0.05);
            const mats = [baseMat, baseMat, baseMat, baseMat,
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
                baseMat];
            mesh = new THREE.Mesh(geo, mats);
            const rb = new THREE.Mesh(
                new THREE.BoxGeometry(0.84, 0.08, 0.25),
                new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.2 })
            );
            rb.position.y = -1.0; mesh.add(rb);
            mesh.name = `โรลอัป #${countType('rollup') + 1}`;
            mesh.userData = { type: 'rollup', category: 'banner', baseDims: { w: 0.8, h: 2.0, d: 0.05 } };
            break;
        }
    }

    if (!mesh) return null;

    // Initial position
    if (type === 'rollup')   mesh.position.set(0, 1.04, 0);
    else if (type === 'backdrop') mesh.position.set(0, 1.25, 0);
    else                     mesh.position.set(0, 0, 0);

    scene.add(mesh);
    draggableObjects.push(mesh);
    updateLayerList();

    if (selectNew) {
        setMode('objects');
        selectObject(mesh);
    }
    return mesh;
}

function countType(type) {
    return draggableObjects.filter(o => o.userData.type === type).length;
}

// ══════════════════════════════════════════════════════════════════════════
// POINTER EVENTS — CAPTURE PHASE
// ══════════════════════════════════════════════════════════════════════════
function onPointerDown(event) {
    if (event.target.id !== 'canvas3d') return;

    mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    if (currentMode === 'paint') {
        const hits = raycaster.intersectObjects(floorTiles);
        if (hits.length > 0) {
            paintTile(hits[0].object);
            event.stopPropagation(); // block orbit while painting
        }
        return;
    }

    // Object selection mode
    const hits = raycaster.intersectObjects(draggableObjects, true);
    if (hits.length > 0) {
        // Walk up to find the root object registered in draggableObjects
        let target = hits[0].object;
        while (target && !draggableObjects.includes(target)) {
            target = target.parent;
        }

        if (target) {
            // CRITICAL: stop OrbitControls from receiving this event
            event.stopPropagation();

            selectObject(target);
            isDragging = true;
            controls.enabled = false;

            const planHit = raycaster.intersectObject(plane);
            if (planHit.length > 0) {
                dragOffset.copy(target.position).sub(planHit[0].point);
                dragOffset.y = 0;
            }
        }
    } else {
        deselectObject();
    }
}

function onPointerMove(event) {
    mouse.x = (event.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Paint drag
    if (currentMode === 'paint' && event.buttons === 1) {
        raycaster.setFromCamera(mouse, camera);
        const hits = raycaster.intersectObjects(floorTiles);
        if (hits.length > 0) paintTile(hits[0].object);
        return;
    }

    if (!isDragging || !selectedObject) return;

    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(plane);
    if (hits.length > 0) {
        const pos = hits[0].point.clone().add(dragOffset);
        if (gridSnapEnabled) {
            pos.x = Math.round(pos.x / gridSnapSize) * gridSnapSize;
            pos.z = Math.round(pos.z / gridSnapSize) * gridSnapSize;
        }
        const xl = spaceWidth  / 2 + 2;
        const zl = spaceLength / 2 + 2;
        pos.x = Math.max(-xl, Math.min(xl, pos.x));
        pos.z = Math.max(-zl, Math.min(zl, pos.z));

        selectedObject.position.x = pos.x;
        selectedObject.position.z = pos.z;
        syncTransformPanel();
    }
}

function onPointerUp() {
    isDragging = false;
    controls.enabled = true;
}

// ─── Keyboard ────────────────────────────────────────────────────────────
function onKeyDown(event) {
    if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
    switch (event.key) {
        case 'Delete':
        case 'Backspace': deleteSelectedItem(); break;
        case 'Escape':    deselectObject();     break;
        case 'r': case 'R':
            if (selectedObject) { selectedObject.rotation.y += Math.PI / 4; syncTransformPanel(); }
            break;
        case 'g': case 'G':
            gridSnapEnabled = !gridSnapEnabled;
            const btn = document.getElementById('snap-toggle-btn');
            if (btn) btn.textContent = gridSnapEnabled ? '⊞ Snap: ON' : '⊟ Snap: OFF';
            break;
        case 'd': case 'D':
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); duplicateSelected(); }
            break;
    }
}

// ─── Paint Tile ──────────────────────────────────────────────────────────
function paintTile(tile) {
    tile.material.color.set(activeCarpetBrushColor);
    tile.material.emissive.set(activeCarpetBrushColor === '#ffffff' ? '#444444' : activeCarpetBrushColor);
    tile.material.emissiveIntensity = 0.25;
}

// ══════════════════════════════════════════════════════════════════════════
// SELECTION
// ══════════════════════════════════════════════════════════════════════════
function selectObject(object) {
    if (selectedObject === object) return;
    if (selectedObject) deselectObject();

    selectedObject = object;
    selectedObject.userData.outlineHelper = new THREE.BoxHelper(selectedObject, 0x06b6d4);
    scene.add(selectedObject.userData.outlineHelper);

    // Switch right panel to edit tab if currently in paint
    if (currentMode === 'paint') setMode('objects');

    updateUI();
    updateLayerList();
}

function deselectObject() {
    if (selectedObject?.userData?.outlineHelper) {
        scene.remove(selectedObject.userData.outlineHelper);
        selectedObject.userData.outlineHelper.dispose();
        delete selectedObject.userData.outlineHelper;
    }
    selectedObject = null;
    updateUI();
    updateLayerList();
}

// ══════════════════════════════════════════════════════════════════════════
// LAYER LIST
// ══════════════════════════════════════════════════════════════════════════
function updateLayerList() {
    const container = document.getElementById('layer-list');
    if (!container) return;
    container.innerHTML = '';

    if (draggableObjects.length === 0) {
        container.innerHTML = `<div class="text-center py-8 text-white/30 text-xs"><p>ยังไม่มีวัตถุในฉาก</p><p class="mt-1 text-[10px]">เพิ่มจาก Assets →</p></div>`;
        return;
    }

    const icons = { backdrop: '🖼️', table: '🪑', bookshelf: '📚', cashier: '🖥️', rollup: '🪧' };

    // Reverse so newest is on top
    [...draggableObjects].reverse().forEach(obj => {
        const sel = obj === selectedObject;
        const item = document.createElement('div');
        item.className = [
            'flex items-center space-x-2 px-3 py-2 rounded-xl cursor-pointer transition-all text-xs border',
            sel
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-white/5 border-transparent hover:bg-white/10 text-white/80'
        ].join(' ');
        item.onclick = () => { showLeftTab('layers'); selectObject(obj); };
        item.innerHTML = `
            <span class="text-base flex-shrink-0">${icons[obj.userData.type] || '📦'}</span>
            <span class="flex-1 truncate font-medium">${obj.name}</span>
            ${sel ? '<span class="text-cyan-400 text-[10px] flex-shrink-0">✓ Active</span>' : ''}
        `;
        container.appendChild(item);
    });
}

// ══════════════════════════════════════════════════════════════════════════
// UI — PROPERTY PANEL
// ══════════════════════════════════════════════════════════════════════════
function updateUI() {
    const unsel = document.getElementById('unselected-panel');
    const sel   = document.getElementById('selected-panel');

    if (!selectedObject) {
        unsel.classList.remove('hidden');
        sel.classList.add('hidden');
        return;
    }

    unsel.classList.add('hidden');
    sel.classList.remove('hidden');

    const type = selectedObject.userData.type;
    document.getElementById('selected-title').innerText = selectedObject.name;
    document.getElementById('selected-badge').innerText = type.toUpperCase();

    // Color control visibility
    const colorCtrl   = document.getElementById('control-color');
    const textureCtrl = document.getElementById('control-texture');
    const colorTypes   = ['table', 'bookshelf', 'cashier'];
    const textureTypes = ['backdrop', 'rollup'];

    if (colorTypes.includes(type)) {
        colorCtrl.classList.remove('hidden');
        textureCtrl.classList.add('hidden');
        // Get current color
        const src = selectedObject.userData.targetColorMesh || selectedObject;
        let hex = '1d4ed8';
        if (src.isMesh && !Array.isArray(src.material)) {
            hex = src.material.color.getHexString();
        } else {
            src.traverse(c => {
                if (c.isMesh && !Array.isArray(c.material) && c.material.metalness < 0.5)
                    hex = c.material.color.getHexString();
            });
        }
        document.getElementById('color-input').value = '#' + hex;
        document.getElementById('color-hex').innerText = '#' + hex.toUpperCase();
    } else if (textureTypes.includes(type)) {
        colorCtrl.classList.add('hidden');
        textureCtrl.classList.remove('hidden');
    } else {
        colorCtrl.classList.add('hidden');
        textureCtrl.classList.add('hidden');
    }

    syncTransformPanel();
}

// ─── Transform Panel Sync ─────────────────────────────────────────────────
function syncTransformPanel() {
    if (!selectedObject) return;
    const { position: p, rotation: r, scale: s } = selectedObject;

    _setInput('tf-pos-x', p.x.toFixed(2));
    _setInput('tf-pos-y', p.y.toFixed(2));
    _setInput('tf-pos-z', p.z.toFixed(2));
    _setInput('tf-rot-x', THREE.MathUtils.radToDeg(r.x).toFixed(1));
    _setInput('tf-rot-y', THREE.MathUtils.radToDeg(r.y).toFixed(1));
    _setInput('tf-rot-z', THREE.MathUtils.radToDeg(r.z).toFixed(1));
    _setInput('tf-scale-x', s.x.toFixed(2));
    _setInput('tf-scale-y', s.y.toFixed(2));
    _setInput('tf-scale-z', s.z.toFixed(2));

    // Physical dimensions in meters
    const dims = selectedObject.userData.baseDims;
    if (dims) {
        _setInput('dim-w', (dims.w * s.x).toFixed(2));
        _setInput('dim-h', (dims.h * s.y).toFixed(2));
        _setInput('dim-d', (dims.d * s.z).toFixed(2));
    }
}

function _setInput(id, val) {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val;
}

// ─── Transform Setters ───────────────────────────────────────────────────
function setPositionX(v) { if (selectedObject) { selectedObject.position.x = _f(v); syncTransformPanel(); } }
function setPositionY(v) { if (selectedObject) { selectedObject.position.y = _f(v); syncTransformPanel(); } }
function setPositionZ(v) { if (selectedObject) { selectedObject.position.z = _f(v); syncTransformPanel(); } }

function setRotationX(v) { if (selectedObject) { selectedObject.rotation.x = THREE.MathUtils.degToRad(_f(v)); syncTransformPanel(); } }
function setRotationY(v) { if (selectedObject) { selectedObject.rotation.y = THREE.MathUtils.degToRad(_f(v)); syncTransformPanel(); } }
function setRotationZ(v) { if (selectedObject) { selectedObject.rotation.z = THREE.MathUtils.degToRad(_f(v)); syncTransformPanel(); } }

function setScaleX(v) { if (selectedObject) { selectedObject.scale.x = Math.max(0.05, _f(v)); syncTransformPanel(); } }
function setScaleY(v) { if (selectedObject) { selectedObject.scale.y = Math.max(0.05, _f(v)); syncTransformPanel(); } }
function setScaleZ(v) { if (selectedObject) { selectedObject.scale.z = Math.max(0.05, _f(v)); syncTransformPanel(); } }

// Dimension → scale conversion
function setDimW(meters) {
    if (!selectedObject?.userData?.baseDims) return;
    setScaleX(_f(meters) / selectedObject.userData.baseDims.w);
}
function setDimH(meters) {
    if (!selectedObject?.userData?.baseDims) return;
    setScaleY(_f(meters) / selectedObject.userData.baseDims.h);
}
function setDimD(meters) {
    if (!selectedObject?.userData?.baseDims) return;
    setScaleZ(_f(meters) / selectedObject.userData.baseDims.d);
}

// Legacy alias
function applyRotation(degrees) { setRotationY(degrees); }

function _f(v) { return parseFloat(v) || 0; }

// ══════════════════════════════════════════════════════════════════════════
// MODE & TABS
// ══════════════════════════════════════════════════════════════════════════
function showLeftTab(tab) {
    const tabA = document.getElementById('tab-assets');
    const tabL = document.getElementById('tab-layers');
    const panA = document.getElementById('panel-assets');
    const panL = document.getElementById('panel-layers');
    const act  = 'py-3 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all flex-1';
    const inact = 'py-3 text-[10px] font-bold uppercase tracking-wider text-white/50 hover:text-white transition-all flex-1';

    if (tab === 'layers') {
        tabA.className = inact; tabL.className = act;
        panA.classList.add('hidden'); panL.classList.remove('hidden');
        updateLayerList();
    } else {
        tabA.className = act; tabL.className = inact;
        panA.classList.remove('hidden'); panL.classList.add('hidden');
    }
}

function setMode(mode) {
    currentMode = mode;
    const tabE  = document.getElementById('tab-edit');
    const tabP  = document.getElementById('tab-paint');
    const panE  = document.getElementById('panel-object-mode');
    const panP  = document.getElementById('panel-paint-mode');
    const act   = 'py-3 text-[10px] font-bold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all flex-1';
    const inact  = 'py-3 text-[10px] font-bold uppercase tracking-wider text-white/50 hover:text-white transition-all flex-1';

    if (mode === 'paint') {
        deselectObject();
        if (tabE) tabE.className = inact;
        if (tabP) tabP.className = act;
        if (panE) panE.classList.add('hidden');
        if (panP) panP.classList.remove('hidden');
    } else {
        if (tabE) tabE.className = act;
        if (tabP) tabP.className = inact;
        if (panE) panE.classList.remove('hidden');
        if (panP) panP.classList.add('hidden');
    }
}

// ══════════════════════════════════════════════════════════════════════════
// OBJECT OPERATIONS
// ══════════════════════════════════════════════════════════════════════════
function changeSelectedColor(hexColor) {
    if (!selectedObject) return;
    document.getElementById('color-hex').innerText = hexColor.toUpperCase();

    const target = selectedObject.userData.targetColorMesh || selectedObject;
    if (target.isMesh && !Array.isArray(target.material)) {
        target.material.color.set(hexColor);
    } else {
        target.traverse(c => {
            if (c.isMesh && !Array.isArray(c.material) && c.material.metalness < 0.5)
                c.material.color.set(hexColor);
        });
    }
}

function duplicateSelected() {
    if (!selectedObject) return;
    const type = selectedObject.userData.type;
    const newObj = spawnItem(type, false);
    if (newObj) {
        newObj.position.copy(selectedObject.position);
        newObj.position.x += 1.0;
        newObj.rotation.copy(selectedObject.rotation);
        newObj.scale.copy(selectedObject.scale);
        selectObject(newObj);
    }
}

function deleteSelectedItem() {
    if (!selectedObject) return;
    const idx = draggableObjects.indexOf(selectedObject);
    if (idx > -1) draggableObjects.splice(idx, 1);
    if (selectedObject.userData.outlineHelper) scene.remove(selectedObject.userData.outlineHelper);
    scene.remove(selectedObject);
    selectedObject.traverse(n => {
        if (n.geometry) n.geometry.dispose();
        if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m.dispose());
    });
    selectedObject = null;
    updateUI();
    updateLayerList();
}

function clearAllWorkspace() {
    deselectObject();
    [...draggableObjects].forEach(obj => {
        scene.remove(obj);
        obj.traverse(n => {
            if (n.geometry) n.geometry.dispose();
            if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => m.dispose());
        });
    });
    draggableObjects = [];
    updateLayerList();
}

// ─── Carpet ───────────────────────────────────────────────────────────────
function selectCarpetBrush(color) {
    activeCarpetBrushColor = color;
    const p = document.getElementById('carpet-brush-color-picker');
    const h = document.getElementById('carpet-brush-hex');
    if (p) p.value = color;
    if (h) h.innerText = color.toUpperCase() + ' (Active)';
    if (currentMode !== 'paint') setMode('paint');
}

// ─── Texture ──────────────────────────────────────────────────────────────
function uploadTexture(input) {
    if (!selectedObject || !input.files?.[0]) return;
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.src = e.target.result;
        img.onload = () => {
            const tex = new THREE.Texture(img);
            tex.needsUpdate = true;
            applyTextureToObject(selectedObject, tex);
        };
    };
    reader.readAsDataURL(input.files[0]);
}

function applyPresetTexture(key) {
    if (!selectedObject || !texturePresets[key]) return;
    applyTextureToObject(selectedObject, texturePresets[key]);
}

function applyTextureToObject(obj, texture) {
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    if (Array.isArray(obj.material)) {
        if (obj.material[4]) { obj.material[4].map = texture; obj.material[4].needsUpdate = true; }
    } else if (obj.material) {
        obj.material.map = texture; obj.material.needsUpdate = true;
    }
}

// ─── Camera ───────────────────────────────────────────────────────────────
function setCameraAngle(angle) {
    const of = Math.max(spaceWidth, spaceLength) * 0.9;
    if (controls) controls.target.set(0, 1, 0);
    switch (angle) {
        case 'top':              camera.position.set(0, of * 1.5, 0.01); break;
        case 'isometric_left':  camera.position.set(-of, of * 0.7, of * 0.8); break;
        case 'isometric_right': camera.position.set(of,  of * 0.7, of * 0.8); break;
    }
    if (controls) controls.update();
}

// ─── Light Mode ───────────────────────────────────────────────────────────
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

// ─── Export ───────────────────────────────────────────────────────────────
function captureMockup() {
    let helper = null;
    if (selectedObject?.userData?.outlineHelper) {
        helper = selectedObject.userData.outlineHelper;
        scene.remove(helper);
    }
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    if (helper) scene.add(helper);
    const a = document.createElement('a');
    a.download = `EventSpace-${spaceWidth}x${spaceLength}m.png`;
    a.href = url; a.click();
}

// ══════════════════════════════════════════════════════════════════════════
// PROCEDURAL TEXTURES
// ══════════════════════════════════════════════════════════════════════════
function createNaiinPresetTexture() {
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 2048, 256);
    ctx.fillStyle = '#f97316';
    ctx.beginPath(); ctx.moveTo(100,0); ctx.lineTo(250,0); ctx.lineTo(150,256); ctx.lineTo(0,256); ctx.fill();
    ctx.fillStyle = '#ea580c';
    ctx.beginPath(); ctx.moveTo(250,0); ctx.lineTo(350,0); ctx.lineTo(250,256); ctx.lineTo(150,256); ctx.fill();
    ctx.strokeStyle = '#06b6d4'; ctx.lineWidth = 4; ctx.strokeRect(550, 40, 948, 176);
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 56px sans-serif';
    ctx.fillText('ร้านนายอินทร์ NAIIN ROADSHOW 2026', 620, 110);
    ctx.fillStyle = '#f97316'; ctx.font = '500 36px sans-serif';
    ctx.fillText('@ MRT พหลโยธิน - ขีดความสุขของการอ่านหนังสือ', 620, 170);
    ctx.fillStyle = '#a855f7'; ctx.beginPath(); ctx.arc(1750,128,60,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 70px sans-serif'; ctx.fillText('📚', 1715, 150);
    return new THREE.CanvasTexture(c);
}

function createKidsPresetTexture() {
    const c = document.createElement('canvas');
    c.width = 2048; c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 2048, 0);
    g.addColorStop(0, '#a855f7'); g.addColorStop(1, '#ec4899');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 2048, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    for (let i = 0; i < 15; i++) {
        ctx.beginPath();
        ctx.arc(Math.random()*2048, Math.random()*256, 20+Math.random()*50, 0, Math.PI*2);
        ctx.fill();
    }
    ctx.fillStyle = '#ffffff'; ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 10;
    ctx.font = 'bold 72px sans-serif';
    ctx.fillText('นายอินทร์ KIDS & MANGA FAIR 🧸', 480, 120);
    ctx.shadowBlur = 0; ctx.fillStyle = '#fef08a'; ctx.font = 'bold 36px sans-serif';
    ctx.fillText('ลดสูงสุด 50% • การ์ตูน วรรณกรรมเยาวชน และไลท์โนเวลครบครันที่นี่!', 485, 180);
    ctx.fillStyle = '#fef08a';
    drawStar(ctx,300,128,5,50,20); drawStar(ctx,1750,128,5,50,20);
    return new THREE.CanvasTexture(c);
}

function drawStar(ctx, cx, cy, spikes, outer, inner) {
    let rot = Math.PI/2*3, x=cx, y=cy, step=Math.PI/spikes;
    ctx.beginPath(); ctx.moveTo(cx, cy - outer);
    for (let i = 0; i < spikes; i++) {
        x = cx + Math.cos(rot)*outer; y = cy + Math.sin(rot)*outer; ctx.lineTo(x,y); rot+=step;
        x = cx + Math.cos(rot)*inner; y = cy + Math.sin(rot)*inner; ctx.lineTo(x,y); rot+=step;
    }
    ctx.lineTo(cx, cy-outer); ctx.closePath(); ctx.fill();
}

// ─── Render Loop ──────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    if (selectedObject?.userData?.outlineHelper) selectedObject.userData.outlineHelper.update();
    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
}

// ─── Global Bindings ──────────────────────────────────────────────────────
window.submitDimensions  = submitDimensions;
window.spawnItem         = spawnItem;
window.setMode           = setMode;
window.showLeftTab       = showLeftTab;
window.selectCarpetBrush = selectCarpetBrush;
window.deleteSelectedItem = deleteSelectedItem;
window.clearAllWorkspace = clearAllWorkspace;
window.changeSelectedColor = changeSelectedColor;
window.uploadTexture     = uploadTexture;
window.applyPresetTexture = applyPresetTexture;
window.setCameraAngle    = setCameraAngle;
window.captureMockup     = captureMockup;
window.duplicateSelected = duplicateSelected;
window.toggleLightMode   = toggleLightMode;
window.applyRotation     = applyRotation;
window.setPositionX = setPositionX; window.setPositionY = setPositionY; window.setPositionZ = setPositionZ;
window.setRotationX = setRotationX; window.setRotationY = setRotationY; window.setRotationZ = setRotationZ;
window.setScaleX    = setScaleX;    window.setScaleY    = setScaleY;    window.setScaleZ    = setScaleZ;
window.setDimW = setDimW; window.setDimH = setDimH; window.setDimD = setDimD;
