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
  apiKey: "AIzaSyAMF7y0oabk3QPzCiwQA1KgWMaTvjl-bs4",
  authDomain: "making2color.firebaseapp.com",
  databaseURL: "https://making2color-default-rtdb.firebaseio.com",
  projectId: "making2color",
  storageBucket: "making2color.firebasestorage.app",
  messagingSenderId: "890035221883",
  appId: "1:890035221883:web:2162e41259129b1c86b9de",
  measurementId: "G-SSL5RRN78T"
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

// ============================
// Initialize Canvas
// ============================
function initCanvas() {
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;

  // Clear background pink
  ctx.fillStyle = "#ffc0cb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw uploaded image, scaled to fit the fixed canvas
  if (uploadedImg) {
    const scale = Math.min(CANVAS_W / uploadedImg.width, CANVAS_H / uploadedImg.height);
    const w = uploadedImg.width * scale;
    const h = uploadedImg.height * scale;
    const ox = (CANVAS_W - w) / 2;
    const oy = (CANVAS_H - h) / 2;
    ctx.drawImage(uploadedImg, ox, oy, w, h);
  }

  hideOtherSide();
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
    document.getElementById("sideText").textContent = "No side chosen";
    updateSideButtons();
    initCanvas();
  });
};

function joinRoom(code) {
  roomId = code;
  roomRef = db.ref("rooms/" + roomId);
  connected = true;

  // Load existing image (if partner already uploaded one)
  roomRef.child("image").once("value", snap => {
    if (snap.exists()) loadRemoteImage(snap.val());
  });

  // Side claims
  roomRef.child("sides").on("value", snap => {
    remoteSides = snap.val() || {};
    updateSideButtons();
  });

  // Replays every past stroke in order, then keeps streaming new ones live
  roomRef.child("strokes").on("child_added", snap => {
    const data = snap.val();
    if (!data || data.clientId === CLIENT_ID) return; // it's our own, already drawn
    applyRemoteStroke(data);
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
  hideOtherSide();
}

function resetSide() {
  if (side && roomRef) roomRef.child("sides/" + side).remove();
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
function startDrawing(e) {
  if (!side || !connected) return;
  drawing = true;
  saveState();
  const pos = getCursorPos(e);
  lastX = pos.x;
  lastY = pos.y;

  if (tool === "bucket") {
    if (side === "left" && pos.x > canvas.width / 2) return;
    if (side === "right" && pos.x < canvas.width / 2) return;
    doBucketFill(pos.x, pos.y, color, true);
  }
}

function handleDrawing(e) {
  if (!drawing || !side || tool !== "brush") return;
  const pos = getCursorPos(e);
  paintLine(lastX, lastY, pos.x, pos.y, color, brushSize, { broadcast: true, enforceLimit: true });
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
  const { broadcast = false, enforceLimit = false } = opts;

  if (enforceLimit) {
    if (side === "left" && x1 > canvas.width / 2) return;
    if (side === "right" && x1 < canvas.width / 2) return;
  }

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
// Apply a stroke that came from the partner
// ============================
function applyRemoteStroke(data) {
  if (data.type === "line") {
    paintLine(data.x0, data.y0, data.x1, data.y1, data.color, data.size, { broadcast: false, enforceLimit: false });
  } else if (data.type === "bucket") {
    doBucketFill(data.x, data.y, data.color, false);
  } else if (data.type === "snapshot") {
    applySnapshotLocal(data.data);
  }
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
