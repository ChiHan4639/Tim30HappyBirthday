// 拖曳旋轉「卡片本身」（不是繞著卡片轉鏡頭）——
// 燈固定不動，卡片轉的時候才看得到暖光掃過紙面。
//
// 手感模型抄 GSAP ScrollSmoother：
//   輸入只改「目標角度」，而真正渲染的角度用一個固定的時間常數去追目標。
//   每一幀的追趕量是 1 - e^(-dt/tau)，所以 30fps 和 120fps 的手感一模一樣，
//   也不會像彈簧那樣過衝、回彈。放手之後的慣性同樣是餵給目標，不是直接餵給角度。
import { CONFIG } from './config.js';

export function createCardControls(el) {
  const M = CONFIG.motion;
  const s = {
    rx: M.restX, ry: M.restY,     // 實際渲染用的角度
    tx: M.restX, ty: M.restY,     // 目標角度
    vx: 0, vy: 0,                 // 放手後的慣性，單位是 rad/秒
    zoom: 1, tzoom: 1,
    dragging: false,
    auto: false,                  // 自動旋轉模式
    idle: 0, idleX: 0, idleY: 0,
  };

  let lastX = 0, lastY = 0, lastT = 0, lastTapTime = 0, moved = 0;
  const clampTilt = (v) => Math.max(-M.maxTiltX, Math.min(M.maxTiltX, v));
  // 甩出去的速度上限。事件擠在一起（掉幀、觸控板慣性、合成事件）時
  // dt 會小到不合理，不夾住的話卡片會突然狂轉一百圈
  const MAX_V = 12;
  const clampV = (v) => Math.max(-MAX_V, Math.min(MAX_V, v));

  const down = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    s.dragging = true; s.idle = 0; moved = 0;
    s.vx = s.vy = 0;
    lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('dragging');
  };

  const move = (e) => {
    if (!s.dragging) return;
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.006, (now - lastT) / 1000));
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY; lastT = now;
    moved += Math.abs(dx) + Math.abs(dy);
    s.idle = 0;

    s.ty += dx * M.dragSpeed;
    s.tx = clampTilt(s.tx + dy * M.dragSpeed);

    // 慣性速度做平滑，免得「放手前最後一格」的抖動決定甩出去的力道
    s.vy = clampV(s.vy * 0.72 + (dx * M.dragSpeed / dt) * 0.28);
    s.vx = clampV(s.vx * 0.72 + (dy * M.dragSpeed / dt) * 0.28);
  };

  const up = (e) => {
    if (!s.dragging) return;
    s.dragging = false;
    el.releasePointerCapture?.(e.pointerId);
    el.classList.remove('dragging');

    // 觸控的雙擊翻面
    if (e.pointerType !== 'mouse' && moved < 12) {
      s.vx = s.vy = 0;
      const now = performance.now();
      if (now - lastTapTime < 320) flip();
      lastTapTime = now;
    }
  };

  const flip = () => { s.ty += Math.PI; s.vy = 0; s.idle = 0; };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('dblclick', flip);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    s.tzoom = Math.max(0.55, Math.min(1.9, s.tzoom * (1 + Math.sign(e.deltaY) * 0.09)));
    s.idle = 0;
  }, { passive: false });

  s.update = (dt, t) => {
    // 自動旋轉也是推「目標」，所以進出都會被同一套平滑接住：
    // 開啟時順順加速，關閉時順順滑停再吸附到最近的一面。
    const omega = s.auto ? (Math.PI * 2) / Math.max(1, M.autoPeriod) : 0;

    if (!s.dragging) {
      // 慣性餵給目標。衰減率換算成「每 1/60 秒」，換 fps 不會變手感。
      const decay = Math.pow(M.friction, dt * 60);
      s.ty += (s.vy + omega) * dt;
      s.tx = clampTilt(s.tx + s.vx * dt);
      s.vy *= decay; s.vx *= decay;
      if (Math.abs(s.vy) < 0.02) s.vy = 0;
      if (Math.abs(s.vx) < 0.02) s.vx = 0;

      // 轉得夠慢了才開始回正，不然會跟甩出去的慣性打架。
      // 自動旋轉時完全不回正，否則會一路被往正面拉、轉速忽快忽慢。
      if (!s.auto && Math.abs(s.vy) < M.settleBelow) {
        const snap = M.restY + Math.round((s.ty - M.restY) / Math.PI) * Math.PI;
        s.ty += (snap - s.ty) * (1 - Math.exp(-dt / M.settle));
      }
      // 自動旋轉時稍微俯視一點，比較像展示台
      const restTiltX = s.auto ? M.restX + M.autoTilt : M.restX;
      s.tx += (restTiltX - s.tx) * (1 - Math.exp(-dt / M.settle));
      s.idle += dt;
    }

    // 追目標：GSAP 那個「smooth」的本體
    const k = 1 - Math.exp(-dt / M.smooth);
    s.ry += (s.ty - s.ry) * k;
    s.rx += (s.tx - s.rx) * k;
    s.zoom += (s.tzoom - s.zoom) * k;

    // 閒置一陣子之後很輕地自己漂一下，才不會像張死圖。
    // 自動旋轉時只留俯仰的呼吸，而且週期刻意跟旋轉不同步，
    // 不然每一圈都長得一模一樣，會很像在跑迴圈動畫。
    const w = s.auto ? 1 : Math.min(1, Math.max(0, (s.idle - M.idleDelay) / 2.5));
    s.idleY = s.auto ? 0 : Math.sin(t * 0.42) * M.idleAmount * w;
    s.idleX = Math.sin(t * (s.auto ? 0.19 : 0.31) + 1.2) * M.idleAmount * (s.auto ? 0.9 : 0.55) * w;
  };

  s.setAuto = (on) => { s.auto = on; s.idle = 0; };

  s.flip = flip;
  return s;
}
