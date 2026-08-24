"use strict";

/*
 * シルエットコインゲット
 *
 * 開発ステージ:
 *   Stage 1 (実装済み) : カメラ取得 + 鏡像表示
 *   Stage 2 (未実装)   : 背景記憶 + 背景差分マスク可視化
 *   Stage 3 (未実装)   : ゲームロジック（落下物・当たり判定・スコア・タイマー）
 *
 * 各ステージは PROGRESS.md に進捗を記録しながら追加していく。
 * このファイルは特別なビルド手順を必要としない Vanilla JS のみで
 * 構成し、Windows / Mac / Linux のどの環境でも
 * 「ローカル HTTP サーバー + 最新ブラウザ」だけで動作するようにする。
 */

const els = {
  video: document.getElementById("cam"),
  canvas: document.getElementById("view"),
  status: document.getElementById("status"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
};

const ctx = els.canvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let rafId = null;

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function resizeCanvasToVideo() {
  const w = els.video.videoWidth;
  const h = els.video.videoHeight;
  if (w && h) {
    els.canvas.width = w;
    els.canvas.height = h;
  }
}

function drawMirroredFrame() {
  if (!els.video.videoWidth) {
    rafId = requestAnimationFrame(drawMirroredFrame);
    return;
  }
  const w = els.canvas.width;
  const h = els.canvas.height;

  ctx.save();
  // 鏡像表示: 横方向に反転してから描画する
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(els.video, 0, 0, w, h);
  ctx.restore();

  rafId = requestAnimationFrame(drawMirroredFrame);
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

  setStatus("カメラ映像を鏡像表示中です。");
  els.stopBtn.disabled = false;

  drawMirroredFrame();
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
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  setStatus("カメラを停止しました。");
}

els.startBtn.addEventListener("click", startCamera);
els.stopBtn.addEventListener("click", stopCamera);

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  setStatus(
    "このブラウザ / この接続方法ではカメラ機能 (getUserMedia) が利用できません。" +
      " http://localhost もしくは https 経由でアクセスしてください。",
    true
  );
  els.startBtn.disabled = true;
}
