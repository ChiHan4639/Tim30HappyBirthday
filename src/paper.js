// 紙：程序生成的蛋殼紋顆粒，以及「紙 + 墨 + 上光」的貼圖合成。
import { CONFIG } from './config.js';

const smooth = (t) => t * t * (3 - 2 * t);

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 可無縫重複的 value noise。fx / fy 分開給，就能做出有方向性的紋理 */
function noise(x, y, fx, fy, seed) {
  const px = x * fx, py = y * fy;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const tx = smooth(px - x0), ty = smooth(py - y0);
  const mx = (v) => ((v % fx) + fx) % fx;
  const my = (v) => ((v % fy) + fy) % fy;
  const X0 = mx(x0), X1 = mx(x0 + 1), Y0 = my(y0), Y1 = my(y0 + 1);
  const a = hash2(X0, Y0, seed), b = hash2(X1, Y0, seed);
  const c = hash2(X0, Y1, seed), d = hash2(X1, Y1, seed);
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

const iso = (x, y, f, seed) => noise(x, y, f, f, seed);

/**
 * 蛋殼紋的高度圖（灰階，可無縫鋪排）。
 *
 * 對比要夠 —— bump 看的是梯度不是絕對高度，
 * 壓在中灰附近的話 bumpScale 拉再高也不會有效果。
 */
export function makeGrainCanvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let n = iso(u, v, 16, 1) * 0.42 + iso(u, v, 37, 2) * 0.30
            + iso(u, v, 83, 3) * 0.18 + iso(u, v, 179, 4) * 0.10;
      // 一層很淡的橫向紋理，純噪訊會太像砂紙
      n = n * 0.82 + noise(u, v, 211, 46, 9) * 0.18;
      const g = Math.max(0, Math.min(255, (0.5 + (n - 0.5) * 1.9) * 255));
      const o = (y * size + x) * 4;
      d[o] = d[o + 1] = d[o + 2] = g;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** 把墨跡的 alpha 形狀染成單一顏色，用來做 roughness map */
function tintAlpha(inkCanvas, color) {
  const c = document.createElement('canvas');
  c.width = inkCanvas.width; c.height = inkCanvas.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(inkCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** contain：把圖等比縮放塞進留白框內 */
function containRect(iw, ih, bw, bh, bx, by) {
  const s = Math.min(bw / iw, bh / ih);
  const w = iw * s, h = ih * s;
  return [bx + (bw - w) / 2, by + (bh - h) / 2, w, h];
}

/** 把顆粒圖以正確的物理尺寸鋪滿整張貼圖 */
function tileGrain(ctx, grain, px, py, mode, alpha) {
  const k = px / (grain.width * CONFIG.paper.grainScale);
  ctx.save();
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = alpha;
  ctx.scale(k, k);
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.fillRect(0, 0, px / k, py / k);
  ctx.restore();
}

/**
 * 合成一面卡片要用的三張貼圖：色彩、粗糙度、上光遮罩。
 *
 * 墨跡用 multiply 疊上去 —— 墨是「吃進紙裡」不是「浮在上面」，
 * 所以紙的顆粒會透過筆畫，看起來才像真的寫上去。
 */
export function composeFace({ ink, mask, grain, px, py, paperColor, margin }) {
  const P = CONFIG.paper;

  const color = document.createElement('canvas');
  color.width = px; color.height = py;
  const ctx = color.getContext('2d');
  ctx.fillStyle = paperColor;
  ctx.fillRect(0, 0, px, py);
  if (grain && P.mottle > 0) tileGrain(ctx, grain, px, py, 'overlay', P.mottle);

  const rough = document.createElement('canvas');
  rough.width = px; rough.height = py;
  const rctx = rough.getContext('2d');
  const base = Math.round(P.roughness * 255);
  rctx.fillStyle = `rgb(${base},${base},${base})`;
  rctx.fillRect(0, 0, px, py);
  // 紙紋也寫進粗糙度。bump 在縮小時會被 mipmap 平均掉，
  // 但粗糙度的起伏會變成光澤的深淺，拉遠了還看得見
  if (grain && P.roughVar > 0) tileGrain(rctx, grain, px, py, 'overlay', P.roughVar);

  let gloss = null;
  let gctx = null;
  if (mask && mask.width > 1) {
    gloss = document.createElement('canvas');
    gloss.width = px; gloss.height = py;
    gctx = gloss.getContext('2d');
    gctx.fillStyle = '#000';          // 黑底：沒指定的地方一律不上光
    gctx.fillRect(0, 0, px, py);
  }

  // 墨跡跟上光用「同一個」外框做 contain，兩層才會疊在一起。
  // 外框的長寬比由墨跡決定；只有上光沒有墨跡時才改用遮罩自己的。
  const fit = ink && ink.width > 1 ? ink : mask;
  if (fit && fit.width > 1) {
    const m = margin * px;
    const box = containRect(fit.width, fit.height, px - m * 2, py - m * 2, m, m);

    if (ink && ink.width > 1) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(ink, box[0], box[1], box[2], box[3]);
      ctx.restore();

      const g = Math.round(P.inkRoughness * 255);
      rctx.drawImage(tintAlpha(ink, `rgb(${g},${g},${g})`), box[0], box[1], box[2], box[3]);
    }
    if (gctx) gctx.drawImage(mask, box[0], box[1], box[2], box[3]);
  }

  return { color, rough, gloss };
}
