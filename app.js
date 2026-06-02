// EventSpace 3D - Dynamic Grid and Carpet Paint System

let scene, camera, renderer, controls;
let draggableObjects = [];
let floorTiles = []; // Individual carpet tile meshes
let selectedObject = null;
let isDragging = false;
let plane; // Plane for raycaster tracking
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let dragOffset = new THREE.Vector3();

// State variables
let currentMode = 'objects'; // 'objects' or 'paint'
let activeCarpetBrushColor = '#374151'; // Active brush color for floor painting
let spaceWidth = 16;
let spaceLength = 3;
let gridSnapSize = 0.5; // Grid snap interval in meters

// Procedural texture presets
const texturePresets = {
    sample_naiin: createNaiinPresetTexture(),
    sample_kids: createKidsPresetTexture()
};

// Initial submit handler from the Modal overlay
function submitDimensions() {
    const widthInput = document.getElementById('input-width');
    const lengthInput = document.getElementById('input-length');
    
    let w = parseInt(widthInput.value) || 16;
    let l = parseInt(lengthInput.value) || 3;

    // Validate inputs
    w = Math.max(2, Math.min(50, w));
    l = Math.max(1, Math.min(15, l));

    spaceWidth = w;
    spaceLength = l;

    // Update UI labels
    document.getElementById('ui-current-dimensions').innerText = `${w.toFixed(2)} x ${l.toFixed(2)} เมตร`;
    document.getElementById('ui-tile-count').innerText = `${w * l} แผ่น (1m x 1m)`;

    // Hide modal, show viewport UI
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('main-ui').classList.remove('hidden');

    // Initialize 3D Engine with entered dimensions
    init3D(w, l);
}

// Initialize the 3D workspace with dynamic dimensions
function init3D(W, L) {
    // 1. Scene Setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0b0d);
    scene.fog = new THREE.FogExp2(0x0a0b0d, 0.015);

    // 2. Camera Setup
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    setCameraAngle('isometric_left');

    // 3. Renderer Setup
    const canvas = document.getElementById('canvas3d');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // 4. Controls Setup
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.01; // Block looking under floor
    controls.minDistance = 2;
    controls.maxDistance = 100;

    // 5. Lights Setup
    // Soft Ambient for general visibility
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambientLight);

    // Directional light casting soft shadows
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(W, 30, L + 15);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 120;
    const d = Math.max(W, L) * 1.2;
    dirLight.shadow.camera.left = -d;
    dirLight.shadow.camera.right = d;
    dirLight.shadow.camera.top = d;
    dirLight.shadow.camera.bottom = -d;
    dirLight.shadow.bias = -0.0005;
    scene.add(dirLight);

    // Subtle blue spotlight reflecting on the active zone
    const spotLight = new THREE.SpotLight(0x00f0ff, 0.6, 50, Math.PI / 4, 0.5, 1);
    spotLight.position.set(0, 20, 0);
    spotLight.target.position.set(0, 0, 0);
    scene.add(spotLight);

    // 6. Invisible Ground Plane for dragging mathematics
    const planeGeo = new THREE.PlaneGeometry(200, 200);
    planeGeo.rotateX(-Math.PI / 2);
    plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ visible: false }));
    scene.add(plane);

    // 7. Outer Grid Environment (Dark & subtle helper grid)
    const gridHelper = new THREE.GridHelper(120, 60, 0x1f2937, 0x111827);
    gridHelper.position.y = -0.02;
    scene.add(gridHelper);

    // 8. Generate Active Bright Floor tiles (WxL Carpet tiles)
    generateCarpetTiles(W, L);

    // 9. Bounding Frame line showing edge of the active layout
    const boundsGeo = new THREE.BoxGeometry(W, 0.04, L);
    const edges = new THREE.EdgesGeometry(boundsGeo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x06b6d4 }));
    line.position.set(0, -0.01, 0);
    scene.add(line);

    // 10. Default Backdrop Wall matching the exact custom Width at the back edge
    const defaultBackdrop = spawnItem('backdrop', false);
    defaultBackdrop.position.set(0, 1.25, -L / 2 + 0.075);
    applyTextureToObject(defaultBackdrop, texturePresets.sample_naiin);

    // Listeners setup
    window.addEventListener('resize', onWindowResize, false);
    renderer.domElement.addEventListener('pointerdown', onPointerDown, false);
    renderer.domElement.addEventListener('pointermove', onPointerMove, false);
    renderer.domElement.addEventListener('pointerup', onPointerUp, false);

    animate();
}

// Generate separate floor tiles that can be individually colored
function generateCarpetTiles(W, L) {
    // Clean old tiles if any
    floorTiles.forEach(tile => scene.remove(tile));
    floorTiles = [];

    // Tile geometry slightly smaller than 1.0m to create nice grout/seam lines (glowing space look)
    const tileGeo = new THREE.BoxGeometry(0.96, 0.02, 0.96);

    for (let i = 0; i < W; i++) {
        for (let j = 0; j < L; j++) {
            // Self-illuminated (emissive) carpet tiles to look bright in dark universe
            const tileMat = new THREE.MeshStandardMaterial({
                color: 0x27272a, // dark gray base
                roughness: 0.9,
                metalness: 0.1,
                emissive: 0x09090b,
                emissiveIntensity: 0.2
            });

            const tile = new THREE.Mesh(tileGeo, tileMat);
            
            // Align center of the grid to (0,0) coordinate
            const xPos = i - W / 2 + 0.5;
            const zPos = j - L / 2 + 0.5;
            
            tile.position.set(xPos, -0.01, zPos);
            tile.receiveShadow = true;
            tile.name = `tile_${i}_${j}`;
            tile.userData = { type: 'floor_tile', x: i, z: j };

            scene.add(tile);
            floorTiles.push(tile);
        }
    }
}

// Window resizing adjustments
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Spawns predefined elements procedurally
function spawnItem(type, selectNew = true) {
    let mesh;
    const material = new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.4,
        metalness: 0.1
    });

    switch(type) {
        case 'backdrop': {
            // Width W (matching custom dimensions), Height 2.5m, Depth 0.15m
            const geometry = new THREE.BoxGeometry(spaceWidth, 2.5, 0.15);
            
            // Texture maps only on front face (index 4)
            const materials = [
                material, // right
                material, // left
                material, // top
                material, // bottom
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }), // front face
                material  // back
            ];
            mesh = new THREE.Mesh(geometry, materials);
            mesh.name = `แบคดรอปยาว ${spaceWidth}ม.`;
            mesh.userData = { type: 'backdrop', category: 'wall' };
            break;
        }
        case 'table': {
            mesh = new THREE.Group();
            
            // Fabric cover skirt
            const skirtGeo = new THREE.BoxGeometry(1.5, 0.72, 0.75);
            const skirtMat = new THREE.MeshStandardMaterial({
                color: 0x1d4ed8,
                roughness: 0.7,
                metalness: 0.0
            });
            const skirt = new THREE.Mesh(skirtGeo, skirtMat);
            skirt.position.y = 0.36;
            skirt.castShadow = true;
            skirt.receiveShadow = true;
            mesh.add(skirt);

            // Tabletop
            const topGeo = new THREE.BoxGeometry(1.54, 0.04, 0.79);
            const topMat = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.6 });
            const top = new THREE.Mesh(topGeo, topMat);
            top.position.y = 0.74;
            top.castShadow = true;
            mesh.add(top);

            mesh.name = "โต๊ะจัดแสดงสินค้า";
            mesh.userData = { type: 'table', category: 'prop', targetColorMesh: skirt };
            break;
        }
        case 'bookshelf': {
            mesh = new THREE.Group();
            const stepsCount = 4;
            const w = 1.4;
            const totalH = 1.0;
            const totalD = 1.0;
            const stepH = totalH / stepsCount;
            const stepD = totalD / stepsCount;

            for (let i = 0; i < stepsCount; i++) {
                const boxW = w;
                const boxH = stepH * (stepsCount - i);
                const boxD = stepD;

                const stepGeo = new THREE.BoxGeometry(boxW, boxH, boxD);
                const stepMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.7 });
                const step = new THREE.Mesh(stepGeo, stepMat);
                
                step.position.set(0, boxH / 2, -totalD/2 + (stepD * i) + (stepD/2));
                step.castShadow = true;
                step.receiveShadow = true;
                mesh.add(step);
            }

            mesh.name = "ชั้นวางหนังสือขั้นบันได";
            mesh.userData = { type: 'bookshelf', category: 'prop' };
            break;
        }
        case 'cashier': {
            mesh = new THREE.Group();

            const baseGeo = new THREE.BoxGeometry(1.0, 0.9, 0.8);
            const baseMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.5 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            base.position.y = 0.45;
            base.castShadow = true;
            base.receiveShadow = true;
            mesh.add(base);

            const counterTopGeo = new THREE.BoxGeometry(1.05, 0.05, 0.85);
            const counterTopMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.3 });
            const counterTop = new THREE.Mesh(counterTopGeo, counterTopMat);
            counterTop.position.y = 0.925;
            counterTop.castShadow = true;
            mesh.add(counterTop);

            const monitorGeo = new THREE.BoxGeometry(0.3, 0.2, 0.05);
            const monitorMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
            const monitor = new THREE.Mesh(monitorGeo, monitorMat);
            monitor.position.set(0.1, 1.15, -0.1);
            monitor.rotation.y = -Math.PI / 12;
            mesh.add(monitor);

            const monitorStandGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.2);
            const monitorStand = new THREE.Mesh(monitorStandGeo, baseMat);
            monitorStand.position.set(0.1, 1.025, -0.1);
            mesh.add(monitorStand);

            mesh.name = "เคาน์เตอร์คิดเงิน";
            mesh.userData = { type: 'cashier', category: 'prop' };
            break;
        }
        case 'rollup': {
            const geometry = new THREE.BoxGeometry(0.8, 2.0, 0.05);
            const materials = [
                material, // right
                material, // left
                material, // top
                material, // bottom
                new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }), // front rollup face
                material  // back
            ];
            mesh = new THREE.Mesh(geometry, materials);
            
            const baseGeo = new THREE.BoxGeometry(0.84, 0.08, 0.25);
            const baseMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.2 });
            const base = new THREE.Mesh(baseGeo, baseMat);
            base.position.y = -1.0;
            mesh.add(base);

            mesh.name = "ป้ายโรลอัป";
            mesh.userData = { type: 'rollup', category: 'banner' };
            break;
        }
    }

    if (mesh) {
        // Initial positioning based on grid offsets
        if (type !== 'backdrop' && type !== 'rollup') {
            mesh.position.set(0, 0, 0);
        } else if (type === 'rollup') {
            mesh.position.set(0, 1.04, 0);
        } else {
            mesh.position.set(0, 1.25, 0);
        }

        scene.add(mesh);
        draggableObjects.push(mesh);

        if (selectNew) {
            // Automatically switch back to Object Placement tab
            setMode('objects');
            selectObject(mesh);
        }
        return mesh;
    }
}

// Raycaster clicks and dragging
function onPointerDown(event) {
    if (event.target.id !== 'canvas3d') return;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    if (currentMode === 'paint') {
        // --- PAINT MODE: Click to paint carpet tiles ---
        const intersects = raycaster.intersectObjects(floorTiles);
        if (intersects.length > 0) {
            const clickedTile = intersects[0].object;
            clickedTile.material.color.set(activeCarpetBrushColor);
            
            // Adjust glowing look based on darkness/brightness of custom color
            if (activeCarpetBrushColor === '#ffffff') {
                clickedTile.material.emissive.set('#444444');
            } else {
                clickedTile.material.emissive.set(activeCarpetBrushColor);
            }
        }
    } else {
        // --- OBJECT EDIT MODE: Select & Move 3D items ---
        const intersects = raycaster.intersectObjects(draggableObjects, true);

        if (intersects.length > 0) {
            let target = intersects[0].object;
            while (target.parent && target.parent !== scene) {
                target = target.parent;
            }

            selectObject(target);
            
            isDragging = true;
            controls.enabled = false; // Disable orbit control rotation

            const intersectPlane = raycaster.intersectObject(plane);
            if (intersectPlane.length > 0) {
                dragOffset.copy(target.position).sub(intersectPlane[0].point);
                dragOffset.y = 0;
            }
        } else {
            deselectObject();
        }
    }
}

function onPointerMove(event) {
    if (!isDragging || !selectedObject || currentMode !== 'objects') return;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObject(plane);

    if (intersects.length > 0) {
        const newPos = intersects[0].point.clone().add(dragOffset);
        
        // Snapping alignment
        newPos.x = Math.round(newPos.x / gridSnapSize) * gridSnapSize;
        newPos.z = Math.round(newPos.z / gridSnapSize) * gridSnapSize;

        // Dynamic boundaries constraint matching W x L dimensions
        const xLimit = spaceWidth / 2;
        const zLimit = spaceLength / 2;
        newPos.x = Math.max(-xLimit, Math.min(xLimit, newPos.x));
        newPos.z = Math.max(-zLimit, Math.min(zLimit, newPos.z));

        selectedObject.position.x = newPos.x;
        selectedObject.position.z = newPos.z;
    }
}

function onPointerUp() {
    isDragging = false;
    controls.enabled = true;
}

// Mode setting controller
function setMode(mode) {
    currentMode = mode;
    
    const tabObj = document.getElementById('tab-objects');
    const tabPaint = document.getElementById('tab-paint');
    const panelObj = document.getElementById('panel-object-mode');
    const panelPaint = document.getElementById('panel-paint-mode');

    if (mode === 'paint') {
        deselectObject(); // Remove glows on selection
        tabPaint.className = "py-4 text-xs font-semibold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all";
        tabObj.className = "py-4 text-xs font-semibold uppercase tracking-wider text-white/50 hover:text-white transition-all";
        panelPaint.classList.remove('hidden');
        panelObj.classList.add('hidden');
    } else {
        tabObj.className = "py-4 text-xs font-semibold uppercase tracking-wider text-cyan-400 border-b-2 border-cyan-400 bg-white/5 transition-all";
        tabPaint.className = "py-4 text-xs font-semibold uppercase tracking-wider text-white/50 hover:text-white transition-all";
        panelObj.classList.remove('hidden');
        panelPaint.classList.add('hidden');
    }
}

// Carpet brush picking
function selectCarpetBrush(color) {
    activeCarpetBrushColor = color;
    document.getElementById('carpet-brush-color-picker').value = color;
    document.getElementById('carpet-brush-hex').innerText = `${color.toUpperCase()} (Active)`;

    // Auto-switch to Paint Mode when clicking a color
    if (currentMode !== 'paint') {
        setMode('paint');
    }
}

// Selects an object and highlights it visually
function selectObject(object) {
    if (selectedObject) deselectObject();

    selectedObject = object;
    
    // Add visual outline bounds helper
    selectedObject.userData.outlineHelper = new THREE.BoxHelper(selectedObject, 0x06b6d4);
    scene.add(selectedObject.userData.outlineHelper);

    updateUI();
}

// Deselects and cleans helper outlines
function deselectObject() {
    if (selectedObject && selectedObject.userData.outlineHelper) {
        scene.remove(selectedObject.userData.outlineHelper);
        selectedObject.userData.outlineHelper.dispose();
    }
    selectedObject = null;
    updateUI();
}

// Deletes the selected object
function deleteSelectedItem() {
    if (!selectedObject) return;

    const index = draggableObjects.indexOf(selectedObject);
    if (index > -1) {
        draggableObjects.splice(index, 1);
    }
    
    scene.remove(selectedObject);
    selectedObject.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
            if (Array.isArray(node.material)) {
                node.material.forEach(m => m.dispose());
            } else {
                node.material.dispose();
            }
        }
    });

    deselectObject();
}

// Reset workspace objects
function clearAllWorkspace() {
    deselectObject();
    
    const objectsToRemove = [...draggableObjects];
    objectsToRemove.forEach(obj => {
        scene.remove(obj);
        obj.traverse((node) => {
            if (node.geometry) node.geometry.dispose();
            if (node.material) {
                if (Array.isArray(node.material)) {
                    node.material.forEach(m => m.dispose());
                } else {
                    node.material.dispose();
                }
            }
        });
    });

    draggableObjects = [];
}

// Change colors of selected table cloths
function changeSelectedColor(hexColor) {
    if (!selectedObject) return;

    document.getElementById('color-hex').innerText = hexColor;
    const targetMesh = selectedObject.userData.targetColorMesh || selectedObject;
    
    if (targetMesh.material) {
        targetMesh.material.color.set(hexColor);
    }
}

// Custom texture uploading
function uploadTexture(input) {
    if (!selectedObject || !input.files || !input.files[0]) return;

    const file = input.files[0];
    const reader = new FileReader();

    reader.onload = function(event) {
        const image = new Image();
        image.src = event.target.result;
        image.onload = function() {
            const texture = new THREE.Texture(image);
            texture.needsUpdate = true;
            applyTextureToObject(selectedObject, texture);
        };
    };

    reader.readAsDataURL(file);
}

// Preset texture picker
function applyPresetTexture(presetKey) {
    if (!selectedObject || !texturePresets[presetKey]) return;
    applyTextureToObject(selectedObject, texturePresets[presetKey]);
}

function applyTextureToObject(obj, texture) {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;

    if (Array.isArray(obj.material)) {
        // Front face mapping (index 4)
        if (obj.material[4]) {
            obj.material[4].map = texture;
            obj.material[4].needsUpdate = true;
        }
    } else if (obj.material) {
        obj.material.map = texture;
        obj.material.needsUpdate = true;
    }
}

// Viewport UI toggle values
function updateUI() {
    const unselected = document.getElementById('unselected-panel');
    const selected = document.getElementById('selected-panel');

    if (!selectedObject) {
        unselected.classList.remove('hidden');
        selected.classList.add('hidden');
    } else {
        unselected.classList.add('hidden');
        selected.classList.remove('hidden');

        const type = selectedObject.userData.type;
        const titleEl = document.getElementById('selected-title');
        const badgeEl = document.getElementById('selected-badge');
        
        titleEl.innerText = selectedObject.name;
        badgeEl.innerText = type.toUpperCase();

        const colorCtrl = document.getElementById('control-color');
        const textureCtrl = document.getElementById('control-texture');

        if (type === 'table') {
            colorCtrl.classList.remove('hidden');
            textureCtrl.classList.add('hidden');
            const activeColor = selectedObject.userData.targetColorMesh.material.color.getHexString();
            document.getElementById('color-input').value = '#' + activeColor;
            document.getElementById('color-hex').innerText = '#' + activeColor;
        } else if (type === 'backdrop' || type === 'rollup') {
            colorCtrl.classList.add('hidden');
            textureCtrl.classList.remove('hidden');
        } else {
            colorCtrl.classList.add('hidden');
            textureCtrl.classList.add('hidden');
        }
    }
}

// Reset camera view angles based on dynamic dimensions to frame the grid
function setCameraAngle(angle) {
    const targetX = 0;
    const targetY = 1;
    const targetZ = 0;
    
    if (controls) controls.target.set(targetX, targetY, targetZ);

    const W = spaceWidth;
    const L = spaceLength;
    const offsetFactor = Math.max(W, L) * 0.9;

    switch(angle) {
        case 'top':
            camera.position.set(0, offsetFactor * 1.5, 0.01);
            break;
        case 'isometric_left':
            camera.position.set(-offsetFactor, offsetFactor * 0.7, offsetFactor * 0.8);
            break;
        case 'isometric_right':
            camera.position.set(offsetFactor, offsetFactor * 0.7, offsetFactor * 0.8);
            break;
    }
}

// Export canvas image mockup
function captureMockup() {
    let cachedHelper = null;
    if (selectedObject && selectedObject.userData.outlineHelper) {
        cachedHelper = selectedObject.userData.outlineHelper;
        scene.remove(cachedHelper);
    }

    renderer.render(scene, camera);
    const imgData = renderer.domElement.toDataURL('image/png');
    
    if (selectedObject && cachedHelper) {
        scene.add(cachedHelper);
    }

    const link = document.createElement('a');
    link.download = `EventSpace-Mockup-${spaceWidth}mx${spaceLength}m.png`;
    link.href = imgData;
    link.click();
}

// Procedural Canvas Texture 1
function createNaiinPresetTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.moveTo(100, 0);
    ctx.lineTo(250, 0);
    ctx.lineTo(150, 256);
    ctx.lineTo(0, 256);
    ctx.fill();

    ctx.fillStyle = '#ea580c';
    ctx.beginPath();
    ctx.moveTo(250, 0);
    ctx.lineTo(350, 0);
    ctx.lineTo(250, 256);
    ctx.lineTo(150, 256);
    ctx.fill();

    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 4;
    ctx.strokeRect(550, 40, 948, 176);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText("ร้านนายอินทร์ NAIIN ROADSHOW 2026", 620, 110);

    ctx.fillStyle = '#f97316';
    ctx.font = '500 36px sans-serif';
    ctx.fillText("@ MRT พหลโยธิน - ขีดความสุขของการอ่านหนังสือ", 620, 170);

    ctx.fillStyle = '#a855f7';
    ctx.beginPath();
    ctx.arc(1750, 128, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 70px sans-serif';
    ctx.fillText("📚", 1715, 150);

    return new THREE.CanvasTexture(canvas);
}

// Procedural Canvas Texture 2
function createKidsPresetTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, '#a855f7');
    gradient.addColorStop(1, '#ec4899');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    for(let i=0; i<15; i++) {
        ctx.beginPath();
        ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height, 20 + Math.random()*50, 0, Math.PI*2);
        ctx.fill();
    }

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 10;
    
    ctx.font = 'bold 72px sans-serif';
    ctx.fillText("นายอินทร์ KIDS & MANGA FAIR 🧸", 480, 120);

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fef08a';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText("ลดสูงสุด 50% • การ์ตูน วรรณกรรมเยาวชน และไลท์โนเวลครบครันที่นี่!", 485, 180);

    ctx.fillStyle = '#fef08a';
    drawStar(ctx, 300, 128, 5, 50, 20);
    drawStar(ctx, 1750, 128, 5, 50, 20);

    return new THREE.CanvasTexture(canvas);
}

function drawStar(ctx, cx, cy, spikes, outerRadius, innerRadius) {
    let rot = Math.PI / 2 * 3;
    let x = cx;
    let y = cy;
    let step = Math.PI / spikes;

    ctx.beginPath();
    ctx.moveTo(cx, cy - outerRadius);
    for (let i = 0; i < spikes; i++) {
        x = cx + Math.cos(rot) * outerRadius;
        y = cy + Math.sin(rot) * outerRadius;
        ctx.lineTo(x, y);
        rot += step;

        x = cx + Math.cos(rot) * innerRadius;
        y = cy + Math.sin(rot) * innerRadius;
        ctx.lineTo(x, y);
        rot += step;
    }
    ctx.lineTo(cx, cy - outerRadius);
    ctx.closePath();
    ctx.fill();
}

// Render loop
function animate() {
    requestAnimationFrame(animate);

    if (selectedObject && selectedObject.userData.outlineHelper) {
        selectedObject.userData.outlineHelper.update();
    }

    if (controls) controls.update();
    if (renderer) renderer.render(scene, camera);
}

// Bind functions to window object so they are globally accessible for HTML inline onclick event handlers
window.submitDimensions = submitDimensions;
window.spawnItem = spawnItem;
window.setMode = setMode;
window.selectCarpetBrush = selectCarpetBrush;
window.deleteSelectedItem = deleteSelectedItem;
window.clearAllWorkspace = clearAllWorkspace;
window.changeSelectedColor = changeSelectedColor;
window.uploadTexture = uploadTexture;
window.applyPresetTexture = applyPresetTexture;
window.setCameraAngle = setCameraAngle;
window.captureMockup = captureMockup;
