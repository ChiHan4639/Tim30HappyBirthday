/**
 * 把來源圖轉成可以貼上卡片的圖層。
 *
 * 預期輸入是「已經去好背的透明 PNG」—— alpha 就是筆跡的覆蓋率，
 * 或是上光要塗佈的範圍。程式不會去猜、也不會動你的顏色。
 */

/** 把來源畫到 canvas，同時限制工作解析度 */
function toWorkingCanvas(source, maxSize) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const scale = Math.min(1, maxSize / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  return { ctx, w, h };
}

/**
 * 裁掉四周全透明的空白，同時回傳正規化（0~1）的裁切框。
 * 上光遮罩要套用同一個框，兩層才會對齊。
 */
function trimAlpha(canvas, padRatio = 0.012) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { canvas, rect: { x: 0, y: 0, w: 1, h: 1 } };

  const pad = Math.round(Math.max(w, h) * padRatio);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);

  const cw = maxX - minX + 1, chh = maxY - minY + 1;
  const rect = { x: minX / w, y: minY / h, w: cw / w, h: chh / h };
  if (cw === w && chh === h) return { canvas, rect };

  const out = document.createElement('canvas');
  out.width = cw; out.height = chh;
  out.getContext('2d').drawImage(canvas, minX, minY, cw, chh, 0, 0, cw, chh);
  return { canvas: out, rect };
}

/** 這張圖去過背了嗎？抽樣看有多少像素不是全不透明就夠了 */
function isTransparent(img) {
  const n = 192;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) clear++;
  return clear > n * n * 0.02;
}

/**
 * 筆跡圖層。原封不動使用，只做兩件事：
 *   1. 依濃度調整 alpha（density = 1 就是完全照原檔）
 *   2. 裁掉四周全透明的空白
 *
 * crop = false 用在滿版稿：圖已經照卡片排好版，不能再裁也不能重新置中。
 */
export function prepareInk(img, { density = 1, maxSize = 2400, crop = true } = {}) {
  const { ctx, w, h } = toWorkingCanvas(img, maxSize);

  if (Math.abs(density - 1) > 0.01) {
    const g = 1 / Math.max(0.15, density);
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    for (let i = 3; i < d.length; i += 4) d[i] = Math.pow(d[i] / 255, g) * 255;
    ctx.putImageData(image, 0, 0);
  }

  if (!crop) return { canvas: ctx.canvas, rect: { x: 0, y: 0, w: 1, h: 1 } };
  return trimAlpha(ctx.canvas);
}

/** 這張圖是亮底（畫在白紙上）還是暗底（白色畫在黑底上）？ */
function backgroundIsLight(source) {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const hist = new Uint32Array(64);
  for (let i = 0; i < d.length; i += 4) {
    const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    hist[Math.min(63, (L * 64) | 0)]++;
  }
  let acc = 0;
  for (let i = 0; i < 64; i++) { acc += hist[i]; if (acc >= (n * n) / 2) return (i + 0.5) / 64 > 0.55; }
  return true;
}

/**
 * 局部上光的遮罩。回傳灰階畫布，白 = 上光。
 *
 * 透明 PNG 直接用 alpha；不透明的圖用亮度，並自動判斷極性
 * （白紙上的圖案 → 取反，黑底白圖 → 照用）。
 *
 * rect 是筆跡那一張算出來的裁切框 —— 套用同一個框，兩層才對得準。
 */
export function prepareMask(source, rect = { x: 0, y: 0, w: 1, h: 1 }, { maxSize = 2048 } = {}) {
  const { ctx, w, h } = toWorkingCanvas(source, maxSize);
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  if (isTransparent(source)) {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3];
      d[i + 3] = 255;
    }
  } else {
    const invert = backgroundIsLight(source);
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = invert ? 255 - L : L;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const cw = Math.max(1, Math.round(rect.w * w));
  const chh = Math.max(1, Math.round(rect.h * h));
  if (cw === w && chh === h) return ctx.canvas;

  const out = document.createElement('canvas');
  out.width = cw; out.height = chh;
  const octx = out.getContext('2d');
  octx.fillStyle = '#000';            // 框外一律當成不上光
  octx.fillRect(0, 0, cw, chh);
  octx.drawImage(ctx.canvas, Math.round(rect.x * w), Math.round(rect.y * h), cw, chh, 0, 0, cw, chh);
  return out;
}
