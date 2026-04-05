// --- VERSION & ENGINE STATE ---
const GAME_VERSION = "0.3.0", GAME_STAGE = "beta";
document.getElementById('main-version-text').innerText = `Vibecraft ${GAME_VERSION} ${GAME_STAGE}`;
document.getElementById('hud-version-display').innerText = GAME_VERSION;

const CHUNK_SIZE = 16, WORLD_HEIGHT = 32;
let WORLD_CHUNKS = 16; 
let RENDER_DIST = 4;     
let db, currentWorldData = null, selectedWorldIdUI = null;
let isPaused = false, isChatting = false, isInventoryOpen = false, gameLoopId = null;
const keys = {};

let playerName = "Player"; 
let playerVelocityY = 0, isGrounded = false, needsChunkUpdate = false;
const GRAVITY = -0.012, JUMP_STRENGTH = 0.22, FLY_SPEED = 0.2;

let frames = 0, lastTime = performance.now();

// Block Breaking State
let breakingBlockPos = null, breakProgress = 0;
let activeSlot = 0;

// THREE.JS Variables
let scene, camera3D, renderer, yaw, pitch, blockOutline; 
let grassMesh, dirtMesh, waterMesh, logMesh, leavesMesh, planksMesh; 

// --- INDEXEDDB SETUP ---
const request = indexedDB.open("VibecraftDB", 1);
request.onupgradeneeded = (e) => {
  db = e.target.result;
  if (!db.objectStoreNames.contains("worlds")) db.createObjectStore("worlds", { keyPath: "id", autoIncrement: true });
};
request.onsuccess = (e) => { 
  db = e.target.result; 
  loadWorldsIntoUI(); 
};

// --- NAVIGATION & PROFILE ---
function saveProfile() {
  const inputEl = document.getElementById('profile-username');
  if (inputEl && inputEl.value.trim()) {
    playerName = inputEl.value.trim();
  }
  navigate('screen-main');
}

function navigate(targetId) {
  // UNPAUSE FIX: If a button tries to return to the game, request pointer lock!
  // The 'pointerlockchange' event listener below will handle actually closing the menu.
  if (targetId === 'screen-game') {
    document.body.requestPointerLock();
    return;
  }

  // SMART REROUTE: Fixes the "Done" button in options sending you to the main menu
  if (targetId === 'screen-main' && currentWorldData && isPaused) {
    targetId = 'screen-pause';
  }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(targetId);
  if (target) target.classList.add('active');

  // Keep 3D world visible behind menus
  if (currentWorldData && (targetId === 'screen-pause' || targetId === 'screen-inventory' || targetId === 'screen-options')) {
    const gameScreen = document.getElementById('screen-game');
    if(gameScreen) gameScreen.classList.add('active');
  }

  if (targetId === 'screen-singleplayer') loadWorldsIntoUI();
}

/// --- RENDER DISTANCE --- ///

function updateRenderDistance(value) {
  // Update the global render distance variable (convert string to integer)
  RENDER_DIST = parseInt(value);
  
  // Update the text label hovering over the slider
  const label = document.getElementById('render-distance-label');
  if (label) {
    label.innerText = `Render Distance: ${RENDER_DIST} chunks`;
  }
  
  // THE MAGIC PART: If you change this while paused in-game, 
  // this forces the engine to instantly load/unload the chunks!
  if (currentWorldData) {
    needsChunkUpdate = true;
  }
}

// --- WORLD CREATION, DELETION & UI ---

let newWorldMode = "survival", newWorldType = "normal", newWorldCheats = false, newWorldSize = 16;

function toggleCreateTab(tab) {
  const basic = document.getElementById('create-tab-basic');
  const adv = document.getElementById('create-tab-advanced');
  if(basic) basic.className = `options-content ${tab === 'basic' ? 'active-tab' : 'hidden-tab'}`;
  if(adv) adv.className = `options-content ${tab === 'advanced' ? 'active-tab' : 'hidden-tab'}`;
}
function toggleGameMode() {
  newWorldMode = newWorldMode === "survival" ? "creative" : "survival";
  document.getElementById("create-gamemode-btn").innerText = `Game Mode: ${newWorldMode.charAt(0).toUpperCase() + newWorldMode.slice(1)}`;
}
function toggleWorldType() {
  newWorldType = newWorldType === "normal" ? "superflat" : "normal";
  document.getElementById("create-type-btn").innerText = `World Type: ${newWorldType.charAt(0).toUpperCase() + newWorldType.slice(1)}`;
}
function toggleCheats() {
  newWorldCheats = !newWorldCheats;
  document.getElementById("create-cheats-btn").innerText = `Allow Cheats: ${newWorldCheats ? "ON" : "OFF"}`;
}
function toggleWorldSize() {
  newWorldSize = newWorldSize === 16 ? 32 : (newWorldSize === 32 ? 4 : 16);
  document.getElementById("create-size-btn").innerText = `World Size: ${newWorldSize === 16 ? "16x16 (Default)" : `${newWorldSize}x${newWorldSize}`}`;
}

function createNewWorld() {
  WORLD_CHUNKS = newWorldSize; 
  let seedInput = document.getElementById("world-seed-input");
  let seedVal = seedInput && seedInput.value.trim() ? seedInput.value.trim() : Math.random().toString(36).substring(2, 10);
  
  let nameInput = document.getElementById("world-name-input");
  let worldName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : "New World";

  const newWorld = {
    name: worldName,
    version: GAME_VERSION, gameMode: newWorldMode, worldType: newWorldType, cheats: newWorldCheats, seed: seedVal,
    worldSize: newWorldSize, lastPlayed: new Date().toLocaleString(),
    blocks: generateTerrain(seedVal, newWorldType),
    playerX: (WORLD_CHUNKS * CHUNK_SIZE) / 2, playerY: newWorldType === "superflat" ? 8 : 20, playerZ: (WORLD_CHUNKS * CHUNK_SIZE) / 2,
    hp: 20, hunger: 20, inventory: Array(36).fill(null)
  };
  
  const tx = db.transaction("worlds", "readwrite");
  tx.objectStore("worlds").add(newWorld);
  tx.oncomplete = () => {
    if(nameInput) nameInput.value = "New World";
    // We removed the tab reset logic here since tabs are gone!
    navigate("screen-singleplayer");
    loadWorldsIntoUI(); // Refresh the world list immediately
  }
}

function deleteSelectedWorld() {
  if (!selectedWorldIdUI) return alert("Select a world to delete first!");
  
  // Fetch the world name to display in the modal warning
  db.transaction("worlds").objectStore("worlds").get(selectedWorldIdUI).onsuccess = (e) => {
    const world = e.target.result;
    if (world) {
      document.getElementById('delete-world-name').innerText = world.name;
      document.getElementById('modal-delete-world').style.display = 'flex';
    }
  };
}

// Actually deletes the world if they click the green button
function confirmDeleteWorld() {
  if (!selectedWorldIdUI) return;
  db.transaction("worlds", "readwrite").objectStore("worlds").delete(selectedWorldIdUI).onsuccess = () => {
    selectedWorldIdUI = null;
    document.getElementById('modal-delete-world').style.display = 'none';
    loadWorldsIntoUI();
  };
}

// Hides the modal if they click Cancel
function cancelDeleteWorld() {
  document.getElementById('modal-delete-world').style.display = 'none';
}

// Remove the red X button and revert the layout
function loadWorldsIntoUI() {
  if(!db) return;
  db.transaction("worlds").objectStore("worlds").getAll().onsuccess = (e) => {
    const list = document.getElementById("world-list-ul"); 
    if(!list) return;
    list.innerHTML = "";
    e.target.result.forEach(w => {
      const li = document.createElement("li"); 
      li.className = "world-item";
      
      li.onclick = () => { 
        document.querySelectorAll('.world-item').forEach(el => el.classList.remove('selected')); 
        li.classList.add('selected'); 
        selectedWorldIdUI = w.id; 
      };
      
      li.innerHTML = `
        <div class="world-details">
          <div class="world-name">${w.name}</div>
          <div class="world-meta">${w.gameMode} - ${w.lastPlayed}</div>
        </div>
      `;
      list.appendChild(li);
    });
  };
}

// --- TERRAIN GENERATION ---
//generateTrees might be obsolete
function generateTrees(worldSize) {
  let currentX = 0;
  
  // Keep placing trees until we hit the world border on the X axis
  while (currentX < worldSize) {
    let currentZ = 0;
    
    // Keep placing trees until we hit the border on the Z axis
    while (currentZ < worldSize) {
      
      // Add a tiny bit of random jitter (0 to 2 blocks) so it doesn't look like a perfect artificial grid
      let treeX = currentX + Math.floor(Math.random() * 3);
      let treeZ = currentZ + Math.floor(Math.random() * 3);
      
      // Ensure the jitter didn't push the tree out of bounds
      if (treeX < worldSize && treeZ < worldSize) {
         // --- YOUR TREE PLACEMENT CODE GOES HERE ---
         // Example: 
         // let groundY = getSurfaceHeight(treeX, treeZ);
         // placeLogBlocks(treeX, groundY, treeZ);
         // placeLeaves(treeX, groundY + 4, treeZ);
      }
      
      // Jump forward on the Z axis by a random number between 3 and 14
      currentZ += Math.floor(Math.random() * (14 - 3 + 1)) + 3; 
    }
    
    // Jump forward on the X axis by a random number between 3 and 14
    currentX += Math.floor(Math.random() * (14 - 3 + 1)) + 3; 
  }
}
function getBlockIdx(x, y, z) { 
  return y * (WORLD_CHUNKS * CHUNK_SIZE)**2 + z * (WORLD_CHUNKS * CHUNK_SIZE) + x; 
}

//dev note: this is where generation actually starts

function generateTerrain(seed, type) {
  const worldWidth = WORLD_CHUNKS * CHUNK_SIZE;
  const blocks = new Uint8Array(worldWidth * worldWidth * WORLD_HEIGHT);
  
  // ==========================================
  // PASS 1: Generate Terrain and Houses
  // ==========================================
  for (let x = 0; x < worldWidth; x++) {
    for (let z = 0; z < worldWidth; z++) {
      // Calculate ground height
      let h = type === "superflat" ? 4 : Math.floor(8 + Math.sin(x/8)*3 + Math.cos(z/10)*2);
      
      // Place Dirt/Stone and Grass
      for (let y = 0; y <= h; y++) {
        if (y < WORLD_HEIGHT) { 
          blocks[getBlockIdx(x, y, z)] = (y === h) ? 1 : 2; 
        }
      }

      // Generate Houses
      if (type !== "superflat") {
        if (x % 64 === 32 && z % 64 === 32) {
          for (let hx = -2; hx <= 2; hx++) {
            for (let hz = -2; hz <= 2; hz++) {
              for (let hy = 1; hy <= 4; hy++) {
                let px = x + hx, py = h + hy, pz = z + hz;
                if (px >= 0 && px < worldWidth && pz >= 0 && pz < worldWidth && py < WORLD_HEIGHT) {
                  if (hx === -2 || hx === 2 || hz === -2 || hz === 2 || hy === 4) {
                    // Leave space for the door
                    if (hz === 2 && hx === 0 && (hy === 1 || hy === 2)) continue; 
                    blocks[getBlockIdx(px, py, pz)] = 6; 
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ==========================================
  // PASS 2: Generate Trees (Randomly Spaced)
  // ==========================================
  if (type !== "superflat") {
    let currentX = 0;
    
    while (currentX < worldWidth) {
      let currentZ = 0;
      
      while (currentZ < worldWidth) {
        // Add random jitter (0 to 2 blocks) so it doesn't look like a grid
        let treeX = currentX + Math.floor(Math.random() * 3);
        let treeZ = currentZ + Math.floor(Math.random() * 3);
        
        // Ensure tree is within world bounds (giving a buffer of 2 blocks for leaves)
        if (treeX > 2 && treeX < worldWidth - 2 && treeZ > 2 && treeZ < worldWidth - 2) {
          
          // Ensure we don't spawn a tree inside a house!
          let isHouseLocation = (treeX % 64 >= 30 && treeX % 64 <= 34 && treeZ % 64 >= 30 && treeZ % 64 <= 34);
          
          if (!isHouseLocation) {
            // Recalculate ground height for this specific tree coordinate
            let h = Math.floor(8 + Math.sin(treeX/8)*3 + Math.cos(treeZ/10)*2);
            
            // Build the Trunk (Block ID: 4)
            for (let ty = 1; ty <= 4; ty++) { 
              if (h + ty < WORLD_HEIGHT) {
                blocks[getBlockIdx(treeX, h + ty, treeZ)] = 4; 
              }
            }
            
            // Build the Leaves (Block ID: 5)
            for (let lx = -1; lx <= 1; lx++) {
              for (let lz = -1; lz <= 1; lz++) { 
                if (h + 4 < WORLD_HEIGHT) {
                  blocks[getBlockIdx(treeX + lx, h + 4, treeZ + lz)] = 5; 
                }
              }
            }
            
            // Top Leaf
            if (h + 5 < WORLD_HEIGHT) {
              blocks[getBlockIdx(treeX, h + 5, treeZ)] = 5;
            }
          }
        }
        
        // Jump forward on the Z axis by a random number between 3 and 14
        // Math.random() * 12 gives 0-11.99. Floor it to 0-11. Add 3 to get 3-14.
        currentZ += Math.floor(Math.random() * 12) + 3; 
      }
      
      // Jump forward on the X axis by a random number between 3 and 14
      currentX += Math.floor(Math.random() * 12) + 3; 
    }
  }

  return blocks;
}

// --- MINING MECHANICS ---
function getTargetBlock() {
  if (!camera3D || !currentWorldData) return null;
  let pos = new THREE.Vector3().setFromMatrixPosition(camera3D.matrixWorld);
  let dir = new THREE.Vector3(0,0,-1).transformDirection(camera3D.matrixWorld);
  for(let i=0; i<5; i+=0.1) { 
    let checkPos = pos.clone().addScaledVector(dir, i);
    let bx = Math.round(checkPos.x), by = Math.round(checkPos.y), bz = Math.round(checkPos.z);
    if (bx >= 0 && by >= 0 && bz >= 0 && by < WORLD_HEIGHT && bx < WORLD_CHUNKS * CHUNK_SIZE && bz < WORLD_CHUNKS * CHUNK_SIZE) {
      let idx = getBlockIdx(bx, by, bz);
      let blockType = currentWorldData.blocks[idx];
      if(blockType > 0 && blockType !== 3) {
        return { x: bx, y: by, z: bz, idx: idx, type: blockType };
      }
    }
  }
  return null;
}

function startBreakingBlock() {
  const target = getTargetBlock();
  if (target) { breakingBlockPos = target; breakProgress = 0; }
}

function stopBreakingBlock() { breakingBlockPos = null; breakProgress = 0; }

function processBlockBreaking() {
  if (!breakingBlockPos) return;
  const target = getTargetBlock();
  if (!target || target.idx !== breakingBlockPos.idx) { stopBreakingBlock(); return; } 

  breakProgress += (currentWorldData.gameMode === "creative") ? 15 : 2; 
  if (breakProgress >= 100) {
    currentWorldData.blocks[breakingBlockPos.idx] = 0; 
    needsChunkUpdate = true; stopBreakingBlock();
  }
}

// --- CLICK TO REGAIN POINTER LOCK ---
document.addEventListener('mousedown', (e) => {
  let invOpen = typeof isInventoryOpen !== 'undefined' && isInventoryOpen;
  
  // If the game is actively playing but the mouse escaped, click to grab it back!
  if (currentWorldData && !isPaused && !isChatting && !invOpen && !document.pointerLockElement) {
    // Try to lock the canvas first, fallback to the body if no canvas exists
    const gameCanvas = document.querySelector('canvas') || document.body;
    gameCanvas.requestPointerLock();
  }
});

// --- KEYBOARD INPUT HANDLING ---
window.addEventListener("keydown", e => {
  let k = e.key.toLowerCase();
  
  // ==========================================
  // ESCAPE KEY HANDLING (Chat, Inventory, Pause)
  // ==========================================
  if (e.key === 'Escape') {
    if (isChatting) {
      // Exit Chat
      isChatting = false;
      document.getElementById('chat-container').style.display = 'none';
      document.body.requestPointerLock();
    } else if (typeof isInventoryOpen !== 'undefined' && isInventoryOpen) {
      // Exit Inventory
      toggleInventory();
    } else if (currentWorldData) {
      // Toggle Pause Menu during normal gameplay
      isPaused = !isPaused;
      if (isPaused) {
        document.exitPointerLock();
        document.getElementById('screen-pause').style.display = 'flex';
        // Clear keys to stop moving!
        for (let key in keys) keys[key] = false;
      } else {
        resumeGame(); // Make sure your resumeGame() function is defined!
      }
    }
    return; // Stop processing other keys if Escape was pressed
  }
  
  // ==========================================
  // CHAT HANDLING
  // ==========================================
  if ((k === 't' || k === '/') && currentWorldData && !isPaused && !isInventoryOpen && !isChatting) {
    e.preventDefault();
    isChatting = true;
    
    // Instantly clear all pressed keys so you don't keep moving!
    for (let key in keys) {
      keys[key] = false;
    }
    
    document.exitPointerLock();
    document.getElementById('chat-container').style.display = 'flex';
    
    const chatInput = document.getElementById('chat-input');
    chatInput.value = (k === '/') ? '/' : ''; 
    
    // Tiny delay to ensure the browser has exited pointer lock before focusing
    setTimeout(() => chatInput.focus(), 10);
    return;
  }

  // Submit chat with Enter
  if (isChatting) {
    if (e.key === 'Enter') handleChatSubmit();
    return; // Block other game inputs while typing
  }

  // ==========================================
  // INVENTORY HANDLING
  // ==========================================
  if (k === 'e' && currentWorldData && !isPaused) {
      toggleInventory();
      return;
  }
  
// ==========================================
 // NORMAL MOVEMENT & HOTBAR
// ==========================================
  let invOpen = typeof isInventoryOpen !== 'undefined' && isInventoryOpen;
  
  if (!isChatting && !isPaused && !invOpen) {
    keys[k] = true;
    if(k === ' ') keys['space'] = true;
    if(k >= '1' && k <= '9') { activeSlot = parseInt(k) - 1; updateHUD(); }
  }
});

// THE FIX: Make absolutely sure this keyup listener is here!
window.addEventListener("keyup", e => {
  let k = e.key.toLowerCase();
  keys[k] = false;
  if (k === ' ') keys['space'] = false;
});

// --- CAMERA MOVEMENT ---
const mouseSensitivity = 0.002; 

window.addEventListener("mousemove", (e) => {
  // Safely check if inventory is open without crashing
  let invOpen = typeof isInventoryOpen !== 'undefined' && isInventoryOpen;
  
  // If the pointer is locked AT ALL, allow camera movement
  if (document.pointerLockElement && !isPaused && !isChatting && !invOpen) {
    
    // THE FIX: Target your THREE.js 'yaw' and 'pitch' objects directly!
    yaw.rotation.y -= e.movementX * mouseSensitivity;
    pitch.rotation.x -= e.movementY * mouseSensitivity;
    
    // Clamp pitch to look straight up or down (so you don't break your neck)
    pitch.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch.rotation.x));
  }
});

// --- PAUSE & INVENTORY ---
document.addEventListener('pointerlockchange', () => {
  if (!currentWorldData || isChatting || isInventoryOpen) return;
  if (!document.pointerLockElement) { 
    isPaused = true; 
    // Show pause menu ONLY if we aren't currently in another menu like options
    if(!document.getElementById('screen-options').classList.contains('active')){
       navigate('screen-pause'); 
    }
  } else { 
    isPaused = false; 
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-game').classList.add('active');
  }
});

// --- PAUSE MENU LOGIC ---

function resumeGame() {
  isPaused = false;
  // Hide the pause menu
  const pauseScreen = document.getElementById('screen-pause'); // Update ID if yours is different
  if (pauseScreen) pauseScreen.style.display = 'none';
  
  // Let the browser know we are trying to re-lock
  const gameCanvas = document.querySelector('canvas') || document.body;
  document.body.requestPointerLock();
}

function toggleInventory() {
  if (!currentWorldData || isPaused) return;
  isInventoryOpen = !isInventoryOpen;
  if (isInventoryOpen) { document.exitPointerLock(); navigate('screen-inventory'); } 
  else { document.body.requestPointerLock(); } // The event listener will switch us back
}

// --- GAME STATE ACTIONS ---
function startGame() {
  if (!selectedWorldIdUI) return alert("Select a world!");
  db.transaction("worlds").objectStore("worlds").get(selectedWorldIdUI).onsuccess = (e) => {
    currentWorldData = e.target.result;
    WORLD_CHUNKS = currentWorldData.worldSize || 16;
    init3D();
    updateHUD();
    yaw.position.set(currentWorldData.playerX, currentWorldData.playerY || 20, currentWorldData.playerZ);
    isPaused = false;
    needsChunkUpdate = true;
    document.body.requestPointerLock(); // Jump directly into the game!
    if (gameLoopId) cancelAnimationFrame(gameLoopId);
    gameLoop();
  };
}

function saveAndQuit() {
  currentWorldData.playerX = yaw.position.x; 
  currentWorldData.playerY = yaw.position.y; 
  currentWorldData.playerZ = yaw.position.z;
  currentWorldData.lastPlayed = new Date().toLocaleString();
  db.transaction("worlds", "readwrite").objectStore("worlds").put(currentWorldData);
  cancelAnimationFrame(gameLoopId); 
  gameLoopId = currentWorldData = null;
  isPaused = false; 
  document.exitPointerLock(); 
  navigate('screen-main'); 
  loadWorldsIntoUI();
}

// --- 3D ENGINE & PROCEDURALLY GENERATED TEXTURES ---
function getProceduralTexture(hexColor, noiseVariance) {
  const canvas = document.createElement('canvas');
  canvas.width = 16; canvas.height = 16;
  const ctx = canvas.getContext('2d');
  const baseColor = new THREE.Color(hexColor);
  
  // Draw pixel by pixel with randomized noise to create a retro blocky texture
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      let noise = (Math.random() - 0.5) * noiseVariance;
      let r = Math.max(0, Math.min(255, Math.floor((baseColor.r + noise) * 255)));
      let g = Math.max(0, Math.min(255, Math.floor((baseColor.g + noise) * 255)));
      let b = Math.max(0, Math.min(255, Math.floor((baseColor.b + noise) * 255)));
      
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter; // Keep pixels perfectly crisp!
  texture.minFilter = THREE.NearestFilter;
  return texture;
}

function init3D() {
  if (scene) return; 
  scene = new THREE.Scene(); 
  scene.background = new THREE.Color(0x87CEEB); 
  scene.fog = new THREE.Fog(0x87CEEB, 10, 60);  
  
  camera3D = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  pitch = new THREE.Object3D(); pitch.add(camera3D); 
  yaw = new THREE.Object3D(); yaw.add(pitch); 
  scene.add(yaw);

  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false });
  renderer.setSize(window.innerWidth, window.innerHeight);

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  let dl = new THREE.DirectionalLight(0xffffff, 0.6); dl.position.set(10, 20, 10); scene.add(dl);

  const outlineGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)); 
  const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }); 
  blockOutline = new THREE.LineSegments(outlineGeo, outlineMat);
  blockOutline.visible = false; 
  scene.add(blockOutline);

  const bg = new THREE.BoxGeometry(1, 1, 1);

  // Generate canvas textures dynamically - No CORS limits, instant loading!
  const grassMat  = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0x55aa55, 0.3) });
  const dirtMat   = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0x79553a, 0.2) });
  const logMat    = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0x5c4033, 0.25) });
  const planksMat = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0xd2a679, 0.15) });
  const leavesMat = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0x228b22, 0.35) });
  const waterMat  = new THREE.MeshLambertMaterial({ map: getProceduralTexture(0x3366ff, 0.1), transparent: true, opacity: 0.8 });

  grassMesh  = new THREE.InstancedMesh(bg, grassMat,  100000);
  dirtMesh   = new THREE.InstancedMesh(bg, dirtMat,   250000); 
  waterMesh  = new THREE.InstancedMesh(bg, waterMat,  100000);
  logMesh    = new THREE.InstancedMesh(bg, logMat,    50000);
  leavesMesh = new THREE.InstancedMesh(bg, leavesMat, 100000);
  planksMesh = new THREE.InstancedMesh(bg, planksMat, 50000);
  
  [grassMesh, dirtMesh, waterMesh, logMesh, leavesMesh, planksMesh].forEach(m => scene.add(m));

  window.addEventListener('resize', () => { 
    renderer.setSize(window.innerWidth, window.innerHeight); 
    camera3D.aspect = window.innerWidth / window.innerHeight; 
    camera3D.updateProjectionMatrix(); 
  });
}

const dummy = new THREE.Object3D();
function renderChunks() {
  let counts = [0, 0, 0, 0, 0, 0];
  const size = WORLD_CHUNKS * CHUNK_SIZE;
  const dist = RENDER_DIST * CHUNK_SIZE;
  
  let sX = Math.max(0, Math.floor(yaw.position.x - dist));
  let eX = Math.min(size, Math.ceil(yaw.position.x + dist));
  let sZ = Math.max(0, Math.floor(yaw.position.z - dist));
  let eZ = Math.min(size, Math.ceil(yaw.position.z + dist));

  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let z = sZ; z < eZ; z++) {
      for (let x = sX; x < eX; x++) {
        const t = currentWorldData.blocks[getBlockIdx(x, y, z)];
        if (!t) continue;
        dummy.position.set(x, y, z); 
        dummy.updateMatrix();
        
        if (t === 1 && counts[0] < grassMesh.count) grassMesh.setMatrixAt(counts[0]++, dummy.matrix);
        else if (t === 2 && counts[1] < dirtMesh.count) dirtMesh.setMatrixAt(counts[1]++, dummy.matrix);
        else if (t === 3 && counts[2] < waterMesh.count) waterMesh.setMatrixAt(counts[2]++, dummy.matrix);
        else if (t === 4 && counts[3] < logMesh.count) logMesh.setMatrixAt(counts[3]++, dummy.matrix);
        else if (t === 5 && counts[4] < leavesMesh.count) leavesMesh.setMatrixAt(counts[4]++, dummy.matrix);
        else if (t === 6 && counts[5] < planksMesh.count) planksMesh.setMatrixAt(counts[5]++, dummy.matrix);
      }
    }
  }
  [grassMesh, dirtMesh, waterMesh, logMesh, leavesMesh, planksMesh].forEach((m, i) => { 
    m.count = counts[i]; 
    m.instanceMatrix.needsUpdate = true; 
  });
}

function handleMovement() {
  let dir = new THREE.Vector3(0,0,0);
  if (keys['w']) dir.z -= 1; if (keys['s']) dir.z += 1;
  if (keys['a']) dir.x -= 1; if (keys['d']) dir.x += 1;
  
  if (dir.length() > 0) {
    dir.normalize().applyEuler(new THREE.Euler(0, yaw.rotation.y, 0));
    yaw.position.addScaledVector(dir, 0.15);
  }

  if (currentWorldData.gameMode === "survival") {
    playerVelocityY += GRAVITY; 
    yaw.position.y += playerVelocityY;
    
    let bY = WORLD_HEIGHT - 1, bX = Math.round(yaw.position.x), bZ = Math.round(yaw.position.z);
    while(bY >= 0 && (!currentWorldData.blocks[getBlockIdx(bX, bY, bZ)] || currentWorldData.blocks[getBlockIdx(bX, bY, bZ)] === 3)) {
        bY--;
    }
    let ground = bY < 0 ? 0 : bY + 2.5; 

    if (yaw.position.y <= ground) { 
      yaw.position.y = ground; playerVelocityY = 0; isGrounded = true; 
    } else {
      isGrounded = false;
    }
    if (keys['space'] && isGrounded) playerVelocityY = JUMP_STRENGTH;
  } else {
    if (keys['space']) yaw.position.y += FLY_SPEED;
    if (keys['shift']) yaw.position.y -= FLY_SPEED;
  }
}

function gameLoop() {
  let now = performance.now();
  if (now >= lastTime + 1000) {
    const fpsCounter = document.getElementById('fps-counter');
    if (fpsCounter) fpsCounter.innerText = `${frames} FPS`;
    frames = 0; lastTime = now;
  }
  frames++;

  if (!isPaused && !isChatting && !isInventoryOpen && currentWorldData) {
    handleMovement();

    // --- COORDINATE TRACKER ---
    const coordsDisplay = document.getElementById('hud-coordinates');
    if (coordsDisplay) {
      // Using Math.floor so you get clean whole numbers instead of crazy decimals!
      let px = Math.floor(yaw.position.x);
      let py = Math.floor(yaw.position.y);
      let pz = Math.floor(yaw.position.z);
      coordsDisplay.innerText = `x: ${px} y: ${py} z: ${pz}`;
    }
    // ---------------------------------------

    processBlockBreaking();
    
    let target = getTargetBlock();
    if (target) {
      blockOutline.position.set(target.x, target.y, target.z);
      blockOutline.visible = true;
    } else {
      blockOutline.visible = false;
    }
    
    if (needsChunkUpdate) { renderChunks(); needsChunkUpdate = false; }
  }
  
  if (renderer && scene && camera3D) renderer.render(scene, camera3D);
  gameLoopId = requestAnimationFrame(gameLoop);
}

// --- HUD STUBS & INVENTORY ---
function updateHUD() {
  if (!currentWorldData) return;
  
  // 1. Update Hotbar
  let hb = document.getElementById('hud-hotbar'); 
  if(hb) {
    hb.innerHTML = "";
    for(let i=0; i<9; i++) {
      hb.innerHTML += `<div class="hotbar-slot ${i === activeSlot ? 'active' : ''}"></div>`;
    }
  }

  // 2. Update Survival Stats (Hearts & Hunger)
  let stats = document.getElementById('hud-stats');
  if (stats) {
    // ONLY show in Survival mode
    if (currentWorldData.gameMode === "survival") {
      stats.style.display = "flex";
      
      let heartsHtml = "";
      for(let i=0; i<10; i++) heartsHtml += `<div class="hud-stat-icon">❤️</div>`;
      document.getElementById('hud-hearts').innerHTML = heartsHtml;

      let hungerHtml = "";
      for(let i=0; i<10; i++) hungerHtml += `<div class="hud-stat-icon">🍖</div>`;
      document.getElementById('hud-hunger').innerHTML = hungerHtml;

    } else {
      // Hide stats in Creative mode
      stats.style.display = "none";
    }
  }
}

function addToInventory(id, amount) { console.log(`Picked up ${amount} of block ID ${id}`); }

function renderInventoryUI() { console.log("Inventory rendered"); }

function addChatMessage(message, color = "white") {
  const messagesDiv = document.getElementById('chat-messages');
  if (!messagesDiv) return;
  
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message';
  msgEl.style.color = color;
  msgEl.innerText = message;
  
  messagesDiv.appendChild(msgEl);
  
  // Keep only the last 10 messages so it doesn't flood the screen
  while (messagesDiv.children.length > 10) {
    messagesDiv.removeChild(messagesDiv.firstChild);
  }
}

function handleChatSubmit() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  
  if (text !== "") {
    // Process simple commands or send as chat
    if (text === "/gamemode creative") {
      currentWorldData.gameMode = "creative";
      addChatMessage("Your gamemode has been set to Creative", "yellow");
      updateHUD();
    } else if (text === "/gamemode survival") {
      currentWorldData.gameMode = "survival";
      addChatMessage("Your gamemode has been set to Survival", "yellow");
      updateHUD();
    } else {
      // Make sure 'playerName' is defined somewhere in your code!
      let name = typeof playerName !== 'undefined' ? playerName : "Player";
      addChatMessage(`<${name}> ${text}`);
    }
  }
  
  // Close chat and return to game
  input.value = "";
  isChatting = false;
  document.getElementById('chat-container').style.display = 'none';
  
  const gameCanvas = document.querySelector('canvas') || document.body;
  gameCanvas.requestPointerLock();
}
