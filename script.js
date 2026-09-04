// ==========================================================
// FIREBASE SETUP — replace with YOUR project's config.
// Get this for free in ~3 minutes:
//   1. Go to https://console.firebase.google.com
//   2. Create a project (name doesn't matter)
//   3. Build > Realtime Database > Create Database > start in TEST mode
//   4. Project settings (gear icon) > General > "Your apps" > Web app (</>)
//   5. Copy the firebaseConfig object it gives you and paste it below
// Both you and your partner just open this same website — you don't
// each need your own Firebase project, only whoever hosts the site does.
// ==========================================================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Unique id for this browser tab/session, so we don't re-draw our own strokes
const CLIENT_ID = Math.random().toString(36).slice(2);

let roomRef = null;
let roomId = null;
let connected = false;
let remoteSides = {};

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

// Fixed logical drawing resolution — identical on every device, no matter
// the screen size. This is what makes strokes line up between you and her.
const CANVAS_W = 900;
const CANVAS_H = 600;

let drawing = false;
let side = null;
let color = "#ff00ff"; // default pen color
let brushSize = 2;
let tool = "brush";

let undoStack = [];
let redoStack = [];

let lastX = null;
let lastY = null;

let uploadedImg = null;

// A hidden reference canvas holding just the original photo + pink
// background, untouched by any strokes. The standard eraser "restores"
// pixels from here. Recomputed whenever the image changes.
const baseCanvas = document.createElement("canvas");
baseCanvas.width = CANVAS_W;
baseCanvas.height = CANVAS_H;
const baseCtx = baseCanvas.getContext("2d");

// Every stroke/bucket/erase currently in the room, keyed by its Firebase
// key. Used to redraw the picture from scratch (needed when a stroke is
// erased) and to hit-test which stroke the "stroke eraser" clicked on.
let strokeLog = {};
let currentStrokeId = null;

// "I'm done" / reveal state
let doneStatus = {};
let revealed = false;

// ============================
// Initialize Canvas
// ============================
function drawBaseLayer(targetCtx) {
  targetCtx.fillStyle = "#ffc0cb";
  targetCtx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (uploadedImg) {
    const scale = Math.min(CANVAS_W / uploadedImg.width, CANVAS_H / uploadedImg.height);
    const w = uploadedImg.width * scale;
    const h = uploadedImg.height * scale;
    const ox = (CANVAS_W - w) / 2;
    const oy = (CANVAS_H - h) / 2;
    targetCtx.drawImage(uploadedImg, ox, oy, w, h);
  }
}

function initCanvas() {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  drawBaseLayer(ctx);
  drawBaseLayer(baseCtx);

  if (!revealed) hideOtherSide();
}

// Redraws the whole picture from the base layer + everything in strokeLog,
// in order. Needed after a stroke is erased, since you can't "un-paint"
// a specific line from a flattened canvas any other way.
function rebuildCanvas() {
  drawBaseLayer(ctx);
  Object.keys(strokeLog).sort().forEach(key => applyLoggedEntry(strokeLog[key]));
  if (!revealed) hideOtherSide();
}

function applyLoggedEntry(data) {
  if (data.type === "line") {
    paintLine(data.x0, data.y0, data.x1, data.y1, data.color, data.size, {});
  } else if (data.type === "bucket") {
    doBucketFill(data.x, data.y, data.color, false);
  } else if (data.type === "erase") {
    eraseLineOnly(data.x0, data.y0, data.x1, data.y1, data.size);
  }
}

initCanvas();

// ============================
// Room connection (Firebase)
// ============================
document.getElementById("joinBtn").onclick = () => {
  const code = document.getElementById("roomCode").value.trim();
  if (!code) {
    alert("Enter a room code — agree on any word/number with your partner and both type the same one.");
    return;
  }
  joinRoom(code);
};

document.getElementById("newDrawingBtn").onclick = () => {
  if (!connected) {
    alert("Join a room first.");
    return;
  }
  if (!confirm("This clears the picture for BOTH of you and starts fresh. Continue?")) return;
  roomRef.remove().then(() => {
    uploadedImg = null;
    side = null;
    remoteSides = {};
    undoStack = [];
    redoStack = [];
    strokeLog = {};
    doneStatus = {};
    revealed = false;
    localStorage.removeItem("m2c_side_" + roomId);
    document.getElementById("sideText").textContent = "No side chosen";
    document.getElementById("doneStatus").textContent = "";
    document.getElementById("exportBtn").disabled = true;
    updateSideButtons();
    initCanvas();
  });
};

function joinRoom(code) {
  roomId = code;
  roomRef = db.ref("rooms/" + roomId);
  connected = true;
  strokeLog = {};

  // Restore your side pick for this room if you had one before refreshing —
  // this is the fix for "I can't pick my side back after reloading".
  const savedSide = localStorage.getItem("m2c_side_" + roomId);
  if (savedSide) {
    side = savedSide;
    sideText.textContent = `You have picked ${side} side (restored)`;
    roomRef.child("sides/" + side).set(true);
    if (!revealed) hideOtherSide();
  }

  // Load existing image (if partner already uploaded one)
  roomRef.child("image").once("value", snap => {
    if (snap.exists()) loadRemoteImage(snap.val());
  });

  // Side claims
  roomRef.child("sides").on("value", snap => {
    remoteSides = snap.val() || {};
    updateSideButtons();
  });

  // Replays every past stroke/fill/erase in order, then keeps streaming
  // new ones live. We log everything (even our own) so erasing can find
  // and remove specific strokes later.
  roomRef.child("strokes").on("child_added", snap => {
    const data = snap.val();
    if (!data) return;
    strokeLog[snap.key] = data;
    if (data.clientId === CLIENT_ID) return; // it's our own, already drawn locally
    if (data.type === "snapshot") {
      applySnapshotLocal(data.data);
    } else {
      applyLoggedEntry(data);
    }
  });

  // When a stroke gets erased (by either of you), rebuild the picture
  // from what's left so both screens match.
  roomRef.child("strokes").on("child_removed", snap => {
    delete strokeLog[snap.key];
    rebuildCanvas();
  });

  // "I'm done" tracking — reveals the full picture once both sides
  // have marked themselves finished, even if one of you joins late.
  roomRef.child("done").on("value", snap => {
    doneStatus = snap.val() || {};
    updateDoneStatus();
  });

  // Presence — lets you see if your partner is actually online right now
  const presenceRef = roomRef.child("presence").child(CLIENT_ID);
  db.ref(".info/connected").on("value", snap => {
    if (snap.val() === true) {
      presenceRef.set(true);
      presenceRef.onDisconnect().remove();
    }
  });
  roomRef.child("presence").on("value", snap => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    document.getElementById("roomStatus").textContent =
      `Room "${roomId}" — ${count} ${count === 1 ? "person" : "people"} online`;
  });
}

// ============================
// Upload Image
// ============================
document.getElementById("upload").onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    const img = new Image();
    img.onload = () => {
      uploadedImg = img;
      initCanvas();
      if (connected) {
        roomRef.child("image").set(downscaleImage(img, 1200));
      }
    };
    img.src = evt.target.result;
  };
  reader.readAsDataURL(file);
};

function downscaleImage(img, maxDim) {
  let w = img.width, h = img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.85);
}

function loadRemoteImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    uploadedImg = img;
    initCanvas();
  };
  img.src = dataUrl;
}

// ============================
// Side Selection + Lock
// ============================
const sideText = document.getElementById("sideText");
document.getElementById("leftBtn").onclick = () => pickSide("left");
document.getElementById("rightBtn").onclick = () => pickSide("right");
document.getElementById("resetSide").onclick = () => resetSide();

function pickSide(s) {
  if (side) return;
  if (!connected) {
    alert("Join a room first so you and your partner sync up.");
    return;
  }
  if (remoteSides[s]) {
    alert(`${s} side is already taken by your partner.`);
    return;
  }
  side = s;
  sideText.textContent = `You have picked ${s} side`;
  roomRef.child("sides/" + s).set(true);
  localStorage.setItem("m2c_side_" + roomId, s);
  if (!revealed) hideOtherSide();
}

function resetSide() {
  if (side && roomRef) {
    roomRef.child("sides/" + side).remove();
    roomRef.child("done/" + side).remove();
  }
  if (roomId) localStorage.removeItem("m2c_side_" + roomId);
  side = null;
  sideText.textContent = "No side chosen";
}

function updateSideButtons() {
  document.getElementById("leftBtn").disabled = !!remoteSides.left && side !== "left";
  document.getElementById("rightBtn").disabled = !!remoteSides.right && side !== "right";
}

// ============================
// Cursor Position
// ============================
function getCursorPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  let clientX, clientY;
  if (e.touches) {
    clientX = e.touches[0].clientX;
    clientY = e.touches[0].clientY;
  } else {
    clientX = e.clientX;
    clientY = e.clientY;
  }

  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

// ============================
// Drawing
// ============================
function outOfMySide(x) {
  return (side === "left" && x > canvas.width / 2) || (side === "right" && x < canvas.width / 2);
}

function startDrawing(e) {
  if (!side || !connected) return;
  drawing = true;
  saveState();
  const pos = getCursorPos(e);
  lastX = pos.x;
  lastY = pos.y;

  if (tool === "bucket") {
    if (outOfMySide(pos.x)) return;
    doBucketFill(pos.x, pos.y, color, true);
  } else if (tool === "brush" || tool === "eraser") {
    // Group every segment drawn during this one drag under one id, so the
    // stroke eraser can later delete the whole line in one touch.
    currentStrokeId = CLIENT_ID + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  } else if (tool === "strokeEraser") {
    tryEraseStrokeAt(pos.x, pos.y);
  }
}

function handleDrawing(e) {
  if (!drawing || !side) return;
  const pos = getCursorPos(e);

  if (tool === "brush") {
    paintLine(lastX, lastY, pos.x, pos.y, color, brushSize, {
      broadcast: true, enforceLimit: true, strokeId: currentStrokeId
    });
  } else if (tool === "eraser") {
    eraseAndBroadcast(lastX, lastY, pos.x, pos.y, brushSize);
  } else if (tool === "strokeEraser") {
    tryEraseStrokeAt(pos.x, pos.y);
  }

  lastX = pos.x;
  lastY = pos.y;
}

function stopDrawing() {
  drawing = false;
  lastX = null;
  lastY = null;
}

// Mouse events
canvas.addEventListener("mousedown", startDrawing);
canvas.addEventListener("mousemove", handleDrawing);
canvas.addEventListener("mouseup", stopDrawing);
canvas.addEventListener("mouseleave", stopDrawing);

// Touch events
canvas.addEventListener("touchstart", e => { e.preventDefault(); startDrawing(e); });
canvas.addEventListener("touchmove", e => { e.preventDefault(); handleDrawing(e); });
canvas.addEventListener("touchend", stopDrawing);
canvas.addEventListener("touchcancel", stopDrawing);

// ============================
// Paint a line segment (used for both local drawing and remote strokes)
// ============================
function paintLine(x0, y0, x1, y1, strokeColor, size, opts = {}) {
  const { broadcast = false, enforceLimit = false, strokeId = null } = opts;

  if (enforceLimit && outOfMySide(x1)) return;

  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  if (broadcast && connected) {
    roomRef.child("strokes").push({
      type: "line",
      x0, y0, x1, y1,
      color: strokeColor,
      size,
      strokeId,
      clientId: CLIENT_ID,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  }
}

// ============================
// Bucket Fill
// ============================
function doBucketFill(x, y, fillColor, broadcast) {
  bucketFill(x, y, fillColor);
  if (broadcast && connected) {
    roomRef.child("strokes").push({
      type: "bucket",
      x, y,
      color: fillColor,
      clientId: CLIENT_ID,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  }
}

function bucketFill(x, y, fillColor) {
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  const stack = [[Math.floor(x), Math.floor(y)]];
  const start = (Math.floor(y) * canvas.width + Math.floor(x)) * 4;
  const target = [data[start], data[start + 1], data[start + 2]];
  const fill = hexToRGB(fillColor);

  while (stack.length) {
    let [px, py] = stack.pop();
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
    let idx = (py * canvas.width + px) * 4;
    if (data[idx] === target[0] && data[idx + 1] === target[1] && data[idx + 2] === target[2]) {
      data[idx] = fill[0];
      data[idx + 1] = fill[1];
      data[idx + 2] = fill[2];
      stack.push([px + 1, py]);
      stack.push([px - 1, py]);
      stack.push([px, py + 1]);
      stack.push([px, py - 1]);
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

function hexToRGB(hex) {
  let r = parseInt(hex.substr(1, 2), 16);
  let g = parseInt(hex.substr(3, 2), 16);
  let b = parseInt(hex.substr(5, 2), 16);
  return [r, g, b];
}

// ============================
// Standard Eraser — restores original photo/background pixels
// ============================
function eraseLineOnly(x0, y0, x1, y1, size) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(2, size / 4)));
  for (let i = 0; i <= steps; i++) {
    const px = x0 + ((x1 - x0) * i) / steps;
    const py = y0 + ((y1 - y0) * i) / steps;
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(baseCanvas, 0, 0);
    ctx.restore();
  }
}

function eraseAndBroadcast(x0, y0, x1, y1, size) {
  if (outOfMySide(x1)) return;
  eraseLineOnly(x0, y0, x1, y1, size);
  if (connected) {
    roomRef.child("strokes").push({
      type: "erase",
      x0, y0, x1, y1, size,
      clientId: CLIENT_ID,
      ts: firebase.database.ServerValue.TIMESTAMP
    });
  }
}

// ============================
// Stroke Eraser — removes an entire brushed line in one touch, for both of you
// ============================
function pointToSegmentDist(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function tryEraseStrokeAt(x, y) {
  if (outOfMySide(x)) return;

  let hitStrokeId = null;
  for (const key of Object.keys(strokeLog)) {
    const d = strokeLog[key];
    if (d.type !== "line" || !d.strokeId) continue;
    if (pointToSegmentDist(x, y, d.x0, d.y0, d.x1, d.y1) <= d.size / 2 + 6) {
      hitStrokeId = d.strokeId;
      break;
    }
  }
  if (!hitStrokeId) return;

  Object.keys(strokeLog)
    .filter(k => strokeLog[k].strokeId === hitStrokeId)
    .forEach(k => {
      delete strokeLog[k];
      if (connected) roomRef.child("strokes/" + k).remove();
    });

  rebuildCanvas();
}

// ============================
// "I'm Done" / Reveal
// ============================
document.getElementById("doneBtn").onclick = () => {
  if (!side) { alert("Pick a side first."); return; }
  if (!connected) { alert("Join a room first."); return; }
  roomRef.child("done/" + side).set(true);
};

function updateDoneStatus() {
  const statusEl = document.getElementById("doneStatus");
  const leftDone = !!doneStatus.left;
  const rightDone = !!doneStatus.right;

  if (leftDone && rightDone) {
    if (!revealed) revealDrawing();
    statusEl.textContent = "Both of you are done! The full picture is revealed \u2014 you can export now.";
  } else if (leftDone || rightDone) {
    statusEl.textContent = `${leftDone ? "Left" : "Right"} side is done — waiting for the other side...`;
  } else {
    statusEl.textContent = "";
  }
}

function revealDrawing() {
  revealed = true;
  rebuildCanvas();
  document.getElementById("exportBtn").disabled = false;
}

// ============================
// Hide Other Side (Opaque Grey)
// ============================
function hideOtherSide() {
  if (!side) return;
  ctx.fillStyle = "grey";
  if (side === "left") ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
  if (side === "right") ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
}

// ============================
// Undo / Redo (synced so you two never drift apart)
// ============================
function saveState() {
  undoStack.push(canvas.toDataURL());
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(canvas.toDataURL());
  const dataUrl = undoStack.pop();
  applySnapshotLocal(dataUrl);
  broadcastSnapshot(dataUrl);
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(canvas.toDataURL());
  const dataUrl = redoStack.pop();
  applySnapshotLocal(dataUrl);
  broadcastSnapshot(dataUrl);
}

function applySnapshotLocal(dataUrl) {
  const img = new Image();
  img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.src = dataUrl;
}

function broadcastSnapshot(dataUrl) {
  if (!connected) return;
  roomRef.child("strokes").push({
    type: "snapshot",
    data: dataUrl,
    clientId: CLIENT_ID,
    ts: firebase.database.ServerValue.TIMESTAMP
  });
}

// ============================
// Export Canvas
// ============================
function exportImage() {
  const link = document.createElement("a");
  link.download = "coloring.png";
  link.href = canvas.toDataURL();
  link.click();
}
