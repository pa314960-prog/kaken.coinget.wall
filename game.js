"use strict";

/*
 * シルエットコインゲット
 *
 * 実装ステージ:
 *   Stage 1: カメラ取得 + 鏡像表示
 *   Stage 2: 背景記憶 + 背景差分マスク（シルエット抽出）
 *   Stage 3: ゲームロジック（落下物・当たり判定・スコア・タイマー・スライダー）
 *
 * ビルド不要の Vanilla JS のみで構成。外部ライブラリ・画像素材を使わず、
 * 絵文字と canvas 描画だけでコイン/敵を表現しているため、
 * ローカル HTTP サーバー + 最新ブラウザだけでどの PC でも動作する。
 */

// ---------------------------------------------------------------------------
// DOM 参照
// ---------------------------------------------------------------------------

const els = {
  video: document.getElementById("cam"),
  canvas: document.getElementById("view"),
  status: document.getElementById("status"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  bgBtn: document.getElementById("bgBtn"),
  playBtn: document.getElementById("playBtn"),
  hud: document.getElementById("hud"),
  scoreVal: document.getElementById("scoreVal"),
  timeVal: document.getElementById("timeVal"),
  overlayPanel: document.getElementById("overlayPanel"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  overlayButtons: document.getElementById("overlayButtons"),
  sensitivity: document.getElementById("sensitivity"),
  sensitivityVal: document.getElementById("sensitivityVal"),
  fallSpeed: document.getElementById("fallSpeed"),
  fallSpeedVal: document.getElementById("fallSpeedVal"),
  maskToggle: document.getElementById("maskToggle"),
};

const ctx = els.canvas.getContext("2d", { willReadFrequently: true });
els.hud.style.display = "none"; // ゲーム開始前は HUD を隠す

// 背景差分の計算は処理負荷軽減のため縮小解像度 (PROC_W x PROC_H) で行う。
const PROC_W = 160;
const PROC_H = 120;
const procCanvas = document.createElement("canvas");
procCanvas.width = PROC_W;
procCanvas.height = PROC_H;
const procCtx = procCanvas.getContext("2d", { willReadFrequently: true });

// マスクの可視化描画用（縮小解像度→本画面へ拡大描画）
const maskCanvas = document.createElement("canvas");
maskCanvas.width = PROC_W;
maskCanvas.height = PROC_H;
const maskCtx = maskCanvas.getContext("2d");

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

let stream = null;
let rafId = null;
let lastFrameTime = 0;

// 'idle' | 'camera-ready' | 'bg-ready' | 'playing' | 'gameover'
let gameState = "idle";

let backgroundLuma = null; // Uint8Array(PROC_W*PROC_H) 背景の輝度
let silhouetteMask = null; // Uint8Array(PROC_W*PROC_H) 1=シルエットあり

// 感度: 値が小さいほど敏感（わずかな差分でも反応する）
let sensitivityThreshold = Number(els.sensitivity.value);
// 落下速度倍率（%）
let fallSpeedPercent = Number(els.fallSpeed.value);
let showMask = els.maskToggle.checked;

const GAME_DURATION_SEC = 60;
let timeLeftMs = GAME_DURATION_SEC * 1000;
let score = 0;
let coinsCollected = 0; // BIG 判定用の累計コイン数
let bigUntil = 0; // performance.now() ベースのタイムスタンプ
let powerDownUntil = 0;

let fallingObjects = [];
let spawnCoinTimerMs = 0;
let spawnEnemyTimerMs = 0;

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function now() {
  return performance.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function randRange(min, max) {
  return min + Math.random() * (max - min);
}

function showOverlay(title, text, buttons) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text;
  els.overlayButtons.innerHTML = "";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.textContent = b.label;
    btn.className = b.secondary ? "secondary" : "";
    btn.addEventListener("click", b.onClick);
    els.overlayButtons.appendChild(btn);
  }
  els.overlayPanel.classList.add("visible");
}

function hideOverlay() {
  els.overlayPanel.classList.remove("visible");
}

// ---------------------------------------------------------------------------
// Stage 1: カメラ取得 + 鏡像表示
// ---------------------------------------------------------------------------

function resizeCanvasToVideo() {
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (w && h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
}

async function startCamera() {
  els.startBtn.disabled = true;
  setStatus("カメラへのアクセスを要求しています…");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user",
      },
      audio: false,
    });
  } catch (err) {
    els.startBtn.disabled = false;
    setStatus(
      `カメラを開始できませんでした: ${err.name} (${err.message || "詳細不明"})`,
      true
    );
    return;
  }

  els.video.srcObject = stream;

  await new Promise((resolve) => {
    els.video.onloadedmetadata = () => resolve();
  });

  resizeCanvasToVideo();
  await els.video.play();

  gameState = "camera-ready";
  els.stopBtn.disabled = false;
  els.bgBtn.disabled = false;
  setStatus(
    "カメラ映像を表示中です。画面から自分が外れた状態で「② 背景を記憶」を押してください。"
  );

  lastFrameTime = now();
  rafId = requestAnimationFrame(tick);
}

function stopCamera() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  gameState = "idle";
  backgroundLuma = null;
  fallingObjects = [];
  els.hud.style.display = "none";
  hideOverlay();
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  els.bgBtn.disabled = true;
  els.playBtn.disabled = true;
  setStatus("カメラを停止しました。");
}

// ---------------------------------------------------------------------------
// Stage 2: 背景記憶 + 背景差分マスク
// ---------------------------------------------------------------------------

/** video の現在フレームを鏡像で procCanvas に描画し、グレースケール輝度配列を返す */
function captureMirroredLuma() {
  procCtx.save();
  procCtx.translate(PROC_W, 0);
  procCtx.scale(-1, 1);
  procCtx.drawImage(els.video, 0, 0, PROC_W, PROC_H);
  procCtx.restore();

  const { data } = procCtx.getImageData(0, 0, PROC_W, PROC_H);
  const luma = new Uint8Array(PROC_W * PROC_H);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // 標準的な輝度換算 (ITU-R BT.601)
    luma[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return luma;
}

function captureBackground() {
  if (gameState === "idle") return;
  backgroundLuma = captureMirroredLuma();
  gameState = "bg-ready";
  els.playBtn.disabled = false;
  setStatus(
    "背景を記憶しました。準備ができたら「③ ゲーム開始」を押してください（背景に映らないよう画面内に戻ってOKです）。"
  );
}

/** 現在フレームと背景の差分からシルエットマスクを更新する */
function updateSilhouetteMask() {
  if (!backgroundLuma) return;
  const cur = captureMirroredLuma();
  if (!silhouetteMask) {
    silhouetteMask = new Uint8Array(PROC_W * PROC_H);
  }
  for (let p = 0; p < cur.length; p++) {
    const diff = Math.abs(cur[p] - backgroundLuma[p]);
    silhouetteMask[p] = diff > sensitivityThreshold ? 1 : 0;
  }
}

/** マスクを半透明の色オーバーレイとして小さい canvas に描画する */
function renderMaskOverlay(color) {
  const imgData = maskCtx.createImageData(PROC_W, PROC_H);
  const d = imgData.data;
  for (let p = 0; p < silhouetteMask.length; p++) {
    const o = p * 4;
    if (silhouetteMask[p]) {
      d[o] = color[0];
      d[o + 1] = color[1];
      d[o + 2] = color[2];
      d[o + 3] = color[3];
    } else {
      d[o + 3] = 0;
    }
  }
  maskCtx.putImageData(imgData, 0, 0);
}

/**
 * 指定した本画面座標(x, y)・半径rの円内で、シルエットマスクが
 * 一定割合以上シルエット判定されているかを調べる（当たり判定用）。
 */
function isSilhouetteAt(x, y, r) {
  if (!silhouetteMask) return false;
  const sx = PROC_W / els.canvas.width;
  const sy = PROC_H / els.canvas.height;
  const px = x * sx;
  const py = y * sy;
  const pr = Math.max(1, r * ((sx + sy) / 2));

  let hits = 0;
  let total = 0;
  const samples = 9;
  for (let i = 0; i < samples; i++) {
    const ang = (i / samples) * Math.PI * 2;
    const rad = i === 0 ? 0 : pr * 0.6;
    const sxp = clamp(Math.round(px + Math.cos(ang) * rad), 0, PROC_W - 1);
    const syp = clamp(Math.round(py + Math.sin(ang) * rad), 0, PROC_H - 1);
    total++;
    if (silhouetteMask[syp * PROC_W + sxp]) hits++;
  }
  return hits / total >= 0.4;
}

// ---------------------------------------------------------------------------
// Stage 3: ゲームロジック（落下物・当たり判定・スコア・タイマー）
// ---------------------------------------------------------------------------

const COIN_RADIUS = 22;
const ENEMY_RADIUS = 24;
const COIN_SCORE = 10;
const ENEMY_PENALTY = 15;
const BIG_EVERY_N_COINS = 10;
const BIG_DURATION_MS = 8000;
const POWERDOWN_DURATION_MS = 3000;

function isBig() {
  return now() < bigUntil;
}
function isPoweredDown() {
  return now() < powerDownUntil;
}

function spawnCoin() {
  fallingObjects.push({
    type: "coin",
    x: randRange(COIN_RADIUS + 10, els.canvas.width - COIN_RADIUS - 10),
    y: -COIN_RADIUS,
    r: COIN_RADIUS,
    speed: randRange(70, 110),
  });
}

function spawnEnemy() {
  fallingObjects.push({
    type: "enemy",
    x: randRange(ENEMY_RADIUS + 10, els.canvas.width - ENEMY_RADIUS - 10),
    y: -ENEMY_RADIUS,
    r: ENEMY_RADIUS,
    speed: randRange(60, 100),
  });
}

function resetGameState() {
  score = 0;
  coinsCollected = 0;
  bigUntil = 0;
  powerDownUntil = 0;
  timeLeftMs = GAME_DURATION_SEC * 1000;
  fallingObjects = [];
  spawnCoinTimerMs = 0;
  spawnEnemyTimerMs = 0;
}

function startGame() {
  if (!backgroundLuma) return;
  resetGameState();
  gameState = "playing";
  hideOverlay();
  els.hud.style.display = "flex";
  els.playBtn.disabled = true;
  setStatus("プレイ中！体を動かしてコインを影でキャッチしよう。敵には触れないように。");
}

function endGame() {
  gameState = "gameover";
  els.hud.style.display = "flex";
  showOverlay(
    "ゲーム終了！",
    `最終スコア: ${score} 点（コイン ${coinsCollected} 枚）`,
    [
      {
        label: "もう一度プレイ",
        onClick: () => {
          startGame();
        },
      },
      {
        label: "背景を撮り直す",
        secondary: true,
        onClick: () => {
          hideOverlay();
          els.hud.style.display = "none";
          gameState = "camera-ready";
          els.playBtn.disabled = true;
          setStatus(
            "画面から自分が外れた状態で「② 背景を記憶」を押してください。"
          );
        },
      },
    ]
  );
}

function updateFallingObjects(dtMs) {
  const speedMul = fallSpeedPercent / 100;
  const poweredDown = isPoweredDown();
  const big = isBig();
  const hitRadiusMul = poweredDown ? 0.6 : 1; // パワーダウン中は当たり判定が小さくなる

  const next = [];
  for (const obj of fallingObjects) {
    obj.y += obj.speed * speedMul * (dtMs / 1000);

    const caught = isSilhouetteAt(obj.x, obj.y, obj.r * hitRadiusMul);
    let remove = false;

    if (caught && obj.type === "coin") {
      coinsCollected++;
      const mul = (big ? 2 : 1) * (poweredDown ? 0.5 : 1);
      score += Math.round(COIN_SCORE * mul);
      if (coinsCollected % BIG_EVERY_N_COINS === 0) {
        bigUntil = now() + BIG_DURATION_MS;
      }
      remove = true;
    } else if (caught && obj.type === "enemy") {
      score = Math.max(0, score - ENEMY_PENALTY);
      powerDownUntil = now() + POWERDOWN_DURATION_MS;
      remove = true;
    } else if (obj.y - obj.r > els.canvas.height) {
      remove = true; // 画面外に落ちた
    }

    if (!remove) next.push(obj);
  }
  fallingObjects = next;

  spawnCoinTimerMs -= dtMs;
  if (spawnCoinTimerMs <= 0) {
    spawnCoin();
    spawnCoinTimerMs = randRange(500, 900);
  }
  spawnEnemyTimerMs -= dtMs;
  if (spawnEnemyTimerMs <= 0) {
    spawnEnemy();
    spawnEnemyTimerMs = randRange(1200, 2000);
  }
}

function drawFallingObjects() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const obj of fallingObjects) {
    if (obj.type === "coin") {
      const big = isBig();
      ctx.font = big ? "42px sans-serif" : "34px sans-serif";
      if (big) {
        ctx.save();
        ctx.shadowColor = "#ffd53d";
        ctx.shadowBlur = 18;
        ctx.fillText("🪙", obj.x, obj.y);
        ctx.restore();
      } else {
        ctx.fillText("🪙", obj.x, obj.y);
      }
    } else {
      ctx.font = "36px sans-serif";
      ctx.fillText("👾", obj.x, obj.y);
    }
  }
}

function updateHud() {
  els.scoreVal.textContent = String(score);
  els.timeVal.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
  els.hud.classList.toggle("big", isBig());
  els.hud.classList.toggle("powerdown", isPoweredDown());
}

// ---------------------------------------------------------------------------
// メインループ
// ---------------------------------------------------------------------------

function drawMirroredCameraFrame() {
  const w = els.canvas.width;
  const h = els.canvas.height;
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(els.video, 0, 0, w, h);
  ctx.restore();
}

function drawMaskOverlayIfNeeded() {
  if (!showMask || !silhouetteMask) return;
  const color = isPoweredDown()
    ? [255, 80, 80, 140]
    : isBig()
    ? [255, 213, 61, 140]
    : [70, 220, 130, 140];
  renderMaskOverlay(color);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskCanvas, 0, 0, els.canvas.width, els.canvas.height);
  ctx.restore();
}

function tick(t) {
  if (!els.video.videoWidth) {
    rafId = requestAnimationFrame(tick);
    return;
  }
  const dtMs = clamp(t - lastFrameTime, 0, 100);
  lastFrameTime = t;

  if (backgroundLuma) {
    updateSilhouetteMask();
  }

  if (gameState === "playing") {
    timeLeftMs -= dtMs;
    if (timeLeftMs <= 0) {
      timeLeftMs = 0;
      updateFallingObjects(0);
      drawFrame();
      updateHud();
      endGame();
      return;
    }
    updateFallingObjects(dtMs);
  }

  drawFrame();
  if (gameState === "playing" || gameState === "gameover") {
    updateHud();
  }

  rafId = requestAnimationFrame(tick);
}

function drawFrame() {
  drawMirroredCameraFrame();
  drawMaskOverlayIfNeeded();
  if (gameState === "playing") {
    drawFallingObjects();
  }
}

// ---------------------------------------------------------------------------
// イベント配線
// ---------------------------------------------------------------------------

els.startBtn.addEventListener("click", startCamera);
els.stopBtn.addEventListener("click", stopCamera);
els.bgBtn.addEventListener("click", captureBackground);
els.playBtn.addEventListener("click", startGame);

els.sensitivity.addEventListener("input", () => {
  sensitivityThreshold = Number(els.sensitivity.value);
  els.sensitivityVal.textContent = String(sensitivityThreshold);
});
els.fallSpeed.addEventListener("input", () => {
  fallSpeedPercent = Number(els.fallSpeed.value);
  els.fallSpeedVal.textContent = `${fallSpeedPercent}%`;
});
els.maskToggle.addEventListener("change", () => {
  showMask = els.maskToggle.checked;
});

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus(
    "このブラウザ / この接続方法ではカメラ機能 (getUserMedia) が利用できません。" +
      " http://localhost もしくは https 経由でアクセスしてください。",
    true
  );
  els.startBtn.disabled = true;
}
