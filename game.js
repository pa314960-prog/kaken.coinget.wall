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
 * 絵文字と canvas 描画だけでコインを表現しているため、
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

// プレイ中に表示する「ステージ背景」（実写カメラ映像の代わりに表示する）
const stageCanvas = document.createElement("canvas");
const stageCtx = stageCanvas.getContext("2d");

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
let prevSilhouetteMask = null; // 1フレーム前のマスク（手の動きの検出に使う）

// 感度: 値が小さいほど敏感（わずかな差分でも反応する）
let sensitivityThreshold = Number(els.sensitivity.value);
// 落下速度倍率（%）
let fallSpeedPercent = Number(els.fallSpeed.value);
let showMask = els.maskToggle.checked;

const GAME_DURATION_SEC = 60;
let timeLeftMs = GAME_DURATION_SEC * 1000;
let score = 0;
let totalHits = 0; // 弾いた回数の合計（BIG 判定にも使う）
let bestCombo = 0; // 1枚のコインを落とさず連続で弾けた最高回数
let bigUntil = 0; // performance.now() ベースのタイムスタンプ

let fallingObjects = [];
let spawnCoinTimerMs = 0;
let hitEffects = []; // 弾いた瞬間のエフェクト（広がる輪 + 得点表示）

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
    buildStageBackground(w, h);
  }
}

/**
 * USJ「クッパJr.ファイナルバトル」のように、実写カメラ映像の代わりに
 * 明るい逆光スクリーン風の背景を表示するための背景画像を
 * 一度だけ作って使い回す。プレイヤーはこの上に「黒い影」として抜かれる。
 */
function buildStageBackground(w, h) {
  stageCanvas.width = w;
  stageCanvas.height = h;

  // 逆光のスクリーンを思わせる暖色（オレンジ）のグラデーション
  const base = stageCtx.createRadialGradient(
    w / 2, h * 0.42, h * 0.05,
    w / 2, h * 0.5, h * 1.2
  );
  base.addColorStop(0, "#ffc070");
  base.addColorStop(0.45, "#f4782c");
  base.addColorStop(1, "#93300f");
  stageCtx.fillStyle = base;
  stageCtx.fillRect(0, 0, w, h);

  // 背後から差し込む「光の柱」（縦縞）
  const stripeCount = 13;
  const stripeW = w / stripeCount;
  for (let i = 0; i < stripeCount; i++) {
    const x = i * stripeW;
    const g = stageCtx.createLinearGradient(x, 0, x + stripeW * 0.72, 0);
    g.addColorStop(0, "rgba(255,230,180,0)");
    g.addColorStop(
      0.5,
      i % 2 === 0 ? "rgba(255,238,200,0.30)" : "rgba(180,50,10,0.20)"
    );
    g.addColorStop(1, "rgba(255,230,180,0)");
    stageCtx.fillStyle = g;
    stageCtx.fillRect(x, 0, stripeW * 0.72, h);
  }

  // ところどころに滲む光の玉（写真のような照明のボケ）
  const blobs = [
    [w * 0.08, h * 0.12, h * 0.30, "rgba(255,240,190,0.22)"],
    [w * 0.82, h * 0.20, h * 0.34, "rgba(180,255,190,0.14)"],
    [w * 0.60, h * 0.80, h * 0.40, "rgba(255,200,120,0.16)"],
  ];
  for (const [bx, by, br, color] of blobs) {
    const g = stageCtx.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(255,255,255,0)");
    stageCtx.fillStyle = g;
    stageCtx.fillRect(0, 0, w, h);
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
    prevSilhouetteMask = new Uint8Array(PROC_W * PROC_H);
  }

  // 手の動きを検出するために1フレーム前のマスクを残しておく。
  // 毎フレーム確保しないよう、2つのバッファを入れ替えて使い回す。
  const recycled = prevSilhouetteMask;
  prevSilhouetteMask = silhouetteMask;
  silhouetteMask = recycled;

  for (let p = 0; p < cur.length; p++) {
    const diff = Math.abs(cur[p] - backgroundLuma[p]);
    silhouetteMask[p] = diff > sensitivityThreshold ? 1 : 0;
  }
  refineSilhouetteMask();
}

// ---------------------------------------------------------------------------
// マスク後処理
//
// 単純な背景差分だけだと、服や肌の明るさが背景とたまたま近い部分が「背景」と
// 判定され、体の内側がまばらに抜けた影になってしまう。そこで
//   1) クロージング（膨張→収縮）で、細かい抜けや途切れを繋ぐ
//   2) 穴埋め（外周から到達できない 0 の領域＝体の内側の穴を塗る）
//   3) 小さな孤立点の除去
// を毎フレーム行い、「隙間のない一つの塊」にしてから描画・当たり判定に使う。
// ---------------------------------------------------------------------------

const MASK_CLOSE_RADIUS = 3; // 抜けを塞ぐ強さ（大きいほど影が太くなる）
const MASK_MIN_BLOB_PX = 60; // これ未満の孤立した塊はノイズとして消す

const maskWorkBuf = new Uint8Array(PROC_W * PROC_H);
const maskVisited = new Uint8Array(PROC_W * PROC_H);
const maskStack = new Int32Array(PROC_W * PROC_H);
const maskBlobBuf = new Int32Array(PROC_W * PROC_H);

function refineSilhouetteMask() {
  // 1) 膨張してバラバラの断片を一つに繋ぐ → 内側の穴を埋める → 収縮して元の太さに戻す
  dilateMask(silhouetteMask, MASK_CLOSE_RADIUS);
  fillMaskHoles(silhouetteMask);
  erodeMask(silhouetteMask, MASK_CLOSE_RADIUS);
  // 2) 収縮で再び開いた穴を埋め直す
  fillMaskHoles(silhouetteMask);
  // 3) 体から離れた小さなノイズを消す
  removeSmallBlobs(silhouetteMask, MASK_MIN_BLOB_PX);
}

/**
 * 膨張（1 の領域を radius だけ広げる）。
 * 横方向・縦方向に分けて、移動和で走査することで高速化している。
 */
function dilateMask(mask, radius) {
  const w = PROC_W;
  const h = PROC_H;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= radius && x < w; x++) sum += mask[row + x];
    for (let x = 0; x < w; x++) {
      maskWorkBuf[row + x] = sum > 0 ? 1 : 0;
      const out = x - radius;
      const inn = x + radius + 1;
      if (out >= 0) sum -= mask[row + out];
      if (inn < w) sum += mask[row + inn];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= radius && y < h; y++) sum += maskWorkBuf[y * w + x];
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = sum > 0 ? 1 : 0;
      const out = y - radius;
      const inn = y + radius + 1;
      if (out >= 0) sum -= maskWorkBuf[out * w + x];
      if (inn < h) sum += maskWorkBuf[inn * w + x];
    }
  }
}

/**
 * 収縮（1 の領域を radius だけ削る）。画面の外側は判定に含めないので、
 * 画面端に接している体が端で削れてしまうことはない。
 */
function erodeMask(mask, radius) {
  const w = PROC_W;
  const h = PROC_H;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= radius && x < w; x++) {
      sum += mask[row + x];
      count++;
    }
    for (let x = 0; x < w; x++) {
      maskWorkBuf[row + x] = sum === count ? 1 : 0;
      const out = x - radius;
      const inn = x + radius + 1;
      if (out >= 0) {
        sum -= mask[row + out];
        count--;
      }
      if (inn < w) {
        sum += mask[row + inn];
        count++;
      }
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= radius && y < h; y++) {
      sum += maskWorkBuf[y * w + x];
      count++;
    }
    for (let y = 0; y < h; y++) {
      mask[y * w + x] = sum === count ? 1 : 0;
      const out = y - radius;
      const inn = y + radius + 1;
      if (out >= 0) {
        sum -= maskWorkBuf[out * w + x];
        count--;
      }
      if (inn < h) {
        sum += maskWorkBuf[inn * w + x];
        count++;
      }
    }
  }
}

/**
 * 体の内側の穴を塗りつぶす。画面の外周から 0 を辿って「本当の背景」を塗り分け、
 * どこからも到達できなかった 0 の領域＝内側の穴とみなして 1 にする。
 */
function fillMaskHoles(mask) {
  const w = PROC_W;
  const h = PROC_H;
  maskVisited.fill(0);
  let sp = 0;

  const push = (p) => {
    if (!mask[p] && !maskVisited[p]) {
      maskVisited[p] = 1;
      maskStack[sp++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }

  while (sp > 0) {
    const p = maskStack[--sp];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] && !maskVisited[p]) mask[p] = 1;
  }
}

/** minPixels 未満しかない孤立した塊を、ちらつきノイズとみなして消す */
function removeSmallBlobs(mask, minPixels) {
  const w = PROC_W;
  const h = PROC_H;
  maskVisited.fill(0);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || maskVisited[start]) continue;

    let sp = 0;
    let n = 0;
    maskVisited[start] = 1;
    maskStack[sp++] = start;

    while (sp > 0) {
      const p = maskStack[--sp];
      maskBlobBuf[n++] = p;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && !maskVisited[p - 1]) {
        maskVisited[p - 1] = 1;
        maskStack[sp++] = p - 1;
      }
      if (x < w - 1 && mask[p + 1] && !maskVisited[p + 1]) {
        maskVisited[p + 1] = 1;
        maskStack[sp++] = p + 1;
      }
      if (y > 0 && mask[p - w] && !maskVisited[p - w]) {
        maskVisited[p - w] = 1;
        maskStack[sp++] = p - w;
      }
      if (y < h - 1 && mask[p + w] && !maskVisited[p + w]) {
        maskVisited[p + w] = 1;
        maskStack[sp++] = p + w;
      }
    }

    if (n < minPixels) {
      for (let i = 0; i < n; i++) mask[maskBlobBuf[i]] = 0;
    }
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

// 触れたと判定するのに必要な、円内のシルエット被覆率
const TOUCH_COVERAGE = 0.22;
// 動きを見る範囲は、当たり判定の何倍の広さにするか。
// 手はコインより大きいことが多く、判定円と同じ広さだと手が範囲を覆い尽くして
// しまい「動いていない」と誤判定される。手の“ふち”が入る広さが必要。
const MOTION_RADIUS_MUL = 3.2;
// この割合だけ画素が入れ替わっていれば「最大の勢い」とみなす
const MOTION_FULL_POWER_RATIO = 0.45;

/**
 * 指定した本画面座標(x, y)・半径 r の円内を調べ、
 * 「シルエットが触れているか」と「手がどちら向きにどれくらいの勢いで
 * 動いたか」を返す。
 *
 * 触れたかどうかは半径 r の内側で判定するが、動きの検出は
 * その MOTION_RADIUS_MUL 倍の広い円で行う。判定円と同じ広さで見ると、
 * コインより大きい手が円を覆い尽くしたときに画素の出入りが起きず、
 * 「動いていない」と誤判定されてしまうため。
 *
 * 動きの向きは、前フレームには無く今フレームに現れた画素（手が入ってきた側）
 * の重心と、前フレームにあって今フレームで消えた画素（手が抜けた側）の重心の
 * 差から求める。勢いは、入れ替わった画素の割合から求める。
 */
function measureSilhouetteMotionAt(x, y, r) {
  const result = { touching: false, dirX: 0, dirY: 0, power: 0 };
  if (!silhouetteMask) return result;

  const sx = PROC_W / els.canvas.width;
  const sy = PROC_H / els.canvas.height;
  const px = x * sx;
  const py = y * sy;
  const touchR = Math.max(2, r * ((sx + sy) / 2));
  const touchR2 = touchR * touchR;
  const motionR = touchR * MOTION_RADIUS_MUL;
  const motionR2 = motionR * motionR;

  const x0 = clamp(Math.floor(px - motionR), 0, PROC_W - 1);
  const x1 = clamp(Math.ceil(px + motionR), 0, PROC_W - 1);
  const y0 = clamp(Math.floor(py - motionR), 0, PROC_H - 1);
  const y1 = clamp(Math.ceil(py + motionR), 0, PROC_H - 1);

  let touchTotal = 0;
  let covered = 0;
  let motionTotal = 0;
  let appearedX = 0, appearedY = 0, appearedN = 0;
  let vanishedX = 0, vanishedY = 0, vanishedN = 0;

  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx - px;
      const dy = yy - py;
      const d2 = dx * dx + dy * dy;
      if (d2 > motionR2) continue;

      const p = yy * PROC_W + xx;
      const cur = silhouetteMask[p];
      const prev = prevSilhouetteMask ? prevSilhouetteMask[p] : 0;

      // 触れたかどうかは内側の小さい円だけで判定する
      if (d2 <= touchR2) {
        touchTotal++;
        if (cur) covered++;
      }

      motionTotal++;
      if (cur && !prev) {
        appearedX += dx;
        appearedY += dy;
        appearedN++;
      } else if (!cur && prev) {
        vanishedX += dx;
        vanishedY += dy;
        vanishedN++;
      }
    }
  }

  if (touchTotal === 0 || motionTotal === 0) return result;
  result.touching = covered / touchTotal >= TOUCH_COVERAGE;
  if (!result.touching) return result;

  // 「消えた側 → 現れた側」が手の進行方向
  let mx = 0;
  let my = 0;
  if (appearedN > 0 && vanishedN > 0) {
    mx = appearedX / appearedN - vanishedX / vanishedN;
    my = appearedY / appearedN - vanishedY / vanishedN;
  } else if (appearedN > 0) {
    mx = appearedX / appearedN;
    my = appearedY / appearedN;
  } else if (vanishedN > 0) {
    mx = -vanishedX / vanishedN;
    my = -vanishedY / vanishedN;
  }

  // マスクは横長に縮小されているので、本画面のアスペクト比に戻してから正規化する
  mx /= sx;
  my /= sy;
  const len = Math.hypot(mx, my);
  if (len > 0.0001) {
    result.dirX = mx / len;
    result.dirY = my / len;
  }

  const changeRatio = (appearedN + vanishedN) / motionTotal;
  result.power = clamp(changeRatio / MOTION_FULL_POWER_RATIO, 0, 1);
  return result;
}

// ---------------------------------------------------------------------------
// Stage 3: ゲームロジック（落下物・当たり判定・スコア・タイマー）
// ---------------------------------------------------------------------------

// 影そのものの色（USJのように、逆光でほぼ真っ黒に抜けるシルエット）
const SILHOUETTE_COLOR_NORMAL = [14, 6, 10];
const SILHOUETTE_COLOR_BIG = [38, 24, 0];

// 影の周囲ににじむ光の色（状態が一目で分かるようにする）
const SILHOUETTE_GLOW_NORMAL = [255, 170, 90];
const SILHOUETTE_GLOW_BIG = [255, 213, 61];

const COIN_RADIUS = 22;
const COIN_SCORE = 10;
const BIG_EVERY_N_HITS = 10;
const BIG_DURATION_MS = 8000;

// --- 弾き飛ばしの調整値 -----------------------------------------------------
// 重力加速度(px/秒^2)。落下速度スライダーの値で倍率をかける。
const GRAVITY = 900;
// 弾いたときに上へ跳ね上がる速さ(px/秒)。手をゆっくり動かしても
// ちゃんと飛ぶよう、下限を大きめに取っている。
const FLING_UP_MIN = 420;
const FLING_UP_MAX = 900;
// 手が動いた向きへ与える横方向の速さ(px/秒)
const FLING_SIDE_MAX = 620;
// 壁・天井で跳ね返るときに残る速度の割合
const WALL_BOUNCE = 0.72;
const CEIL_BOUNCE = 0.5;
// 一度弾いてから、次に弾けるようになるまでの時間(ms)
const HIT_COOLDOWN_MS = 260;
// 空中コンボ倍率の上限
const COMBO_MAX = 5;
// 弾いたエフェクトの表示時間(ms)
const HIT_EFFECT_MS = 700;

function isBig() {
  return now() < bigUntil;
}

function spawnCoin() {
  fallingObjects.push({
    x: randRange(COIN_RADIUS + 20, els.canvas.width - COIN_RADIUS - 20),
    y: -COIN_RADIUS,
    r: COIN_RADIUS,
    vx: randRange(-40, 40),
    vy: randRange(60, 120),
    hits: 0, // このコインを床に落とさず連続で弾けた回数
    cooldownMs: 0,
    spin: 0,
    spinSpeed: 0,
  });
}

function resetGameState() {
  score = 0;
  totalHits = 0;
  bestCombo = 0;
  bigUntil = 0;
  timeLeftMs = GAME_DURATION_SEC * 1000;
  fallingObjects = [];
  hitEffects = [];
  spawnCoinTimerMs = 0;
}

function startGame() {
  if (!backgroundLuma) return;
  resetGameState();
  gameState = "playing";
  hideOverlay();
  els.hud.style.display = "flex";
  els.playBtn.disabled = true;
  setStatus(
    "プレイ中！落ちてくるコインを手で弾き飛ばそう。勢いよく弾くほど高得点、床に落ちる前に空中で連続して弾くとコンボ！"
  );
}

function endGame() {
  gameState = "gameover";
  els.hud.style.display = "flex";
  showOverlay(
    "ゲーム終了！",
    `最終スコア: ${score} 点（弾いた回数 ${totalHits} 回 / 最高コンボ ${bestCombo}）`,
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

/** コインを1枚弾き飛ばし、勢いとコンボに応じて得点を加える */
function flingCoin(obj, motion) {
  obj.hits++;
  totalHits++;
  if (obj.hits > bestCombo) bestCombo = obj.hits;

  // 横方向は手が動いた向きへ、縦方向は必ず上向きに跳ね上げる。
  // カメラ越しの操作では細かい向きを狙いにくいので、
  // 「弾いたら上に飛ぶ」と決め打ちにした方が気持ちよく遊べる。
  obj.vx = obj.vx * 0.35 + motion.dirX * FLING_SIDE_MAX * (0.35 + motion.power);
  obj.vy = -(FLING_UP_MIN + (FLING_UP_MAX - FLING_UP_MIN) * motion.power);
  obj.spinSpeed = (motion.dirX >= 0 ? 1 : -1) * (6 + motion.power * 16);
  obj.cooldownMs = HIT_COOLDOWN_MS;

  const combo = Math.min(obj.hits, COMBO_MAX);
  const bigMul = isBig() ? 2 : 1;
  const gained = Math.round(COIN_SCORE * (1 + motion.power) * combo * bigMul);
  score += gained;

  if (totalHits % BIG_EVERY_N_HITS === 0) {
    bigUntil = now() + BIG_DURATION_MS;
  }

  hitEffects.push({
    x: obj.x,
    y: obj.y,
    text: combo > 1 ? `+${gained}  x${combo}` : `+${gained}`,
    ageMs: 0,
  });
}

function updateFallingObjects(dtMs) {
  const dt = dtMs / 1000;
  const speedMul = fallSpeedPercent / 100;
  const w = els.canvas.width;
  const h = els.canvas.height;

  const next = [];
  for (const obj of fallingObjects) {
    if (obj.cooldownMs > 0) obj.cooldownMs -= dtMs;

    // 物理更新（重力・移動・回転）
    obj.vy += GRAVITY * speedMul * dt;
    obj.x += obj.vx * dt;
    obj.y += obj.vy * dt;
    obj.spin += obj.spinSpeed * dt;
    obj.spinSpeed *= 0.99;

    // 左右の壁と天井では跳ね返す。画面内に留まるので連続で弾きやすい。
    if (obj.x < obj.r) {
      obj.x = obj.r;
      obj.vx = Math.abs(obj.vx) * WALL_BOUNCE;
    } else if (obj.x > w - obj.r) {
      obj.x = w - obj.r;
      obj.vx = -Math.abs(obj.vx) * WALL_BOUNCE;
    }
    if (obj.y < obj.r) {
      obj.y = obj.r;
      obj.vy = Math.abs(obj.vy) * CEIL_BOUNCE;
    }

    // 手で弾いたかどうかの判定
    if (obj.cooldownMs <= 0) {
      const motion = measureSilhouetteMotionAt(obj.x, obj.y, obj.r);
      if (motion.touching) {
        flingCoin(obj, motion);
      }
    }

    // 床より下に落ちたら見逃し（そのコインのコンボはそこで終わり）
    if (obj.y - obj.r > h) continue;
    next.push(obj);
  }
  fallingObjects = next;

  // エフェクトの寿命管理
  const liveEffects = [];
  for (const e of hitEffects) {
    e.ageMs += dtMs;
    if (e.ageMs < HIT_EFFECT_MS) liveEffects.push(e);
  }
  hitEffects = liveEffects;

  spawnCoinTimerMs -= dtMs;
  if (spawnCoinTimerMs <= 0) {
    spawnCoin();
    spawnCoinTimerMs = randRange(700, 1200);
  }
}

function drawFallingObjects() {
  const big = isBig();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const obj of fallingObjects) {
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate(obj.spin);
    ctx.font = big ? "42px sans-serif" : "34px sans-serif";
    // 明るい背景でも見失わないように光らせる
    ctx.shadowColor = big ? "rgba(255,255,255,0.95)" : "rgba(60,16,0,0.85)";
    ctx.shadowBlur = big ? 22 : 14;
    ctx.fillText("🪙", 0, 0);
    ctx.restore();

    // 連続で弾いているコインには、今のコンボ倍率を添える
    if (obj.hits >= 2) {
      const label = `x${Math.min(obj.hits, COMBO_MAX)}`;
      ctx.save();
      ctx.font = "bold 18px sans-serif";
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "rgba(60,16,0,0.9)";
      ctx.lineWidth = 4;
      ctx.strokeText(label, obj.x, obj.y + 30);
      ctx.fillText(label, obj.x, obj.y + 30);
      ctx.restore();
    }
  }
}

/** 弾いた瞬間の「広がる輪」と、獲得点数の浮き上がり表示 */
function drawHitEffects() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const e of hitEffects) {
    const t = e.ageMs / HIT_EFFECT_MS; // 0 → 1
    ctx.save();
    ctx.globalAlpha = 1 - t;

    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 1 + 4 * (1 - t);
    ctx.beginPath();
    ctx.arc(e.x, e.y, 16 + t * 52, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = "bold 26px sans-serif";
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(60,16,0,0.9)";
    ctx.lineWidth = 5;
    // コインと重ならないよう、最初からコインの少し上に出す
    const ty = e.y - 30 - t * 48;
    ctx.strokeText(e.text, e.x, ty);
    ctx.fillText(e.text, e.x, ty);
    ctx.restore();
  }
}

function updateHud() {
  els.scoreVal.textContent = String(score);
  els.timeVal.textContent = String(Math.max(0, Math.ceil(timeLeftMs / 1000)));
  els.hud.classList.toggle("big", isBig());
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
  const color = isBig() ? [255, 213, 61, 140] : [70, 220, 130, 140];
  renderMaskOverlay(color);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(maskCanvas, 0, 0, els.canvas.width, els.canvas.height);
  ctx.restore();
}

function drawStageBackground() {
  ctx.drawImage(stageCanvas, 0, 0, els.canvas.width, els.canvas.height);
}

/**
 * USJ「クッパJr.ファイナルバトル」のように、実写映像は見せず、
 * 背景差分マスクから抽出した輪郭を「逆光で黒く抜けた影」として描画する。
 * 影自体はほぼ真っ黒にし、輪郭のまわりに光を滲ませて逆光らしさを出す。
 */
function drawSilhouetteShadow() {
  if (!silhouetteMask) return;
  const [r, g, b] = isBig() ? SILHOUETTE_COLOR_BIG : SILHOUETTE_COLOR_NORMAL;
  const [gr, gg, gb] = isBig() ? SILHOUETTE_GLOW_BIG : SILHOUETTE_GLOW_NORMAL;

  renderMaskOverlay([r, g, b, 242]);
  ctx.save();
  ctx.imageSmoothingEnabled = true; // 拡大時に輪郭をなめらかにする
  // マスクは低解像度(PROC_W x PROC_H)なので、そのまま拡大すると輪郭が
  // カクカクする。軽くぼかして、投影された影らしい柔らかい輪郭にする。
  ctx.filter = `blur(${Math.max(1, els.canvas.width / 400).toFixed(1)}px)`;
  ctx.shadowColor = `rgba(${gr}, ${gg}, ${gb}, 0.75)`;
  ctx.shadowBlur = 30;
  ctx.drawImage(maskCanvas, 0, 0, els.canvas.width, els.canvas.height);
  ctx.shadowBlur = 0;
  ctx.filter = "none";
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
      endGame();
    } else {
      updateFallingObjects(dtMs);
    }
  }

  drawFrame();
  if (gameState === "playing" || gameState === "gameover") {
    updateHud();
  }

  rafId = requestAnimationFrame(tick);
}

function drawFrame() {
  if (gameState === "playing" || gameState === "gameover") {
    // プレイ中〜終了後は実写映像を見せず、影(シルエット)だけを表示する
    drawStageBackground();
    drawSilhouetteShadow();
  } else {
    // カメラ確認〜背景記憶の準備段階は、位置合わせのため実写映像を表示する
    drawMirroredCameraFrame();
    drawMaskOverlayIfNeeded();
  }
  if (gameState === "playing") {
    drawFallingObjects();
    drawHitEffects();
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
