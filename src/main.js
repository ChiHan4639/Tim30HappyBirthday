import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { CONFIG } from './config.js';
import { prepareInk, prepareMask } from './ink.js';
import { makeGrainCanvas, composeFace } from './paper.js';
import { buildCardGeometry } from './card.js';
import { createCardControls } from './controls.js';

const canvas = document.getElementById('stage');
const hintEl = document.getElementById('hint');

/* ---------------------------------------------------------------- 渲染器 */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.light.exposure;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 300);
camera.position.set(0, 0.4, 28);

/* ---------------------------------------------------------------- 環境反射 */

// 局部上光的招牌效果是「反射周遭」—— 只有點光源的話它根本沒東西可以照，
// clearcoat 會完全看不出來（RectAreaLight 在 three 裡也不參與 clearcoat）。
// 所以這裡生一張很簡單的環境貼圖：黑底，主燈和側光的方向各放一團亮的。
function makeEnvCanvas() {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#04040a';
  g.fillRect(0, 0, W, H);

  // 方向 → equirect 像素。配合 three 的 equirectUv 與預設的 flipY。
  const toPixel = (v) => {
    const d = v.clone().normalize();
    const u = Math.atan2(d.z, d.x) / (Math.PI * 2) + 0.5;
    const t = Math.asin(Math.max(-1, Math.min(1, d.y))) / Math.PI + 0.5;
    return [u * W, (1 - t) * H];
  };

  const blob = (dir, radius, rgb, alpha) => {
    const [x, y] = toPixel(dir);
    g.save();
    g.globalAlpha = alpha;
    g.globalCompositeOperation = 'lighter';
    // 左右各補一份，橫向接縫才不會有斷痕
    for (const cx of [x - W, x, x + W]) {
      const grad = g.createRadialGradient(cx, y, 0, cx, y, radius);
      grad.addColorStop(0, `rgba(${rgb},1)`);
      grad.addColorStop(0.4, `rgba(${rgb},0.55)`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.fillRect(cx - radius, y - radius, radius * 2, radius * 2);
    }
    g.restore();
  };

  blob(new THREE.Vector3(...CONFIG.light.position), W * 0.135, '255,238,214', 1.0);   // 主燈
  blob(new THREE.Vector3(14.5, 2.5, 9), W * 0.20, '186,200,226', 0.6);                // 右側柔光

  // 上半部留一點點微光，上光區不會反射出死黑
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, 'rgba(90,96,112,0.5)');
  sky.addColorStop(0.55, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  return c;
}

const envTexture = (() => {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const src = new THREE.Texture(makeEnvCanvas());
  src.mapping = THREE.EquirectangularReflectionMapping;
  src.colorSpace = THREE.SRGBColorSpace;
  src.needsUpdate = true;
  const t = pmrem.fromEquirectangular(src).texture;
  src.dispose();
  pmrem.dispose();
  return t;
})();

/* ---------------------------------------------------------------- 紙張與材質 */

const { width: CW, height: CH } = CONFIG.card;

// 燈位、光暈、紙紋顆粒全都綁在卡片的對角線上。
// 不這樣做的話，換一次卡片尺寸就要重調一次燈 —— 燈離卡片的相對距離變了，
// 平方反比的明暗分布跟著整個跑掉。
const REF_DIAGONAL = Math.hypot(10.5, 14.8);        // 當初調燈時用的 A6
const S = Math.hypot(CW, CH) / REF_DIAGONAL;

const grainCanvas = makeGrainCanvas();

function grainTexture(repeatX, repeatY) {
  const t = new THREE.CanvasTexture(grainCanvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = maxAniso;
  return t;
}

const faceGrain = grainTexture(CONFIG.paper.grainScale * S, CONFIG.paper.grainScale * S * (CH / CW));

// 局部上光 = clearcoat：紙面本身維持霧面，只有遮罩指定的地方多一層透明塗層。
// 沒有遮罩時 clearcoat 保持 0，著色器就不會多跑那一層。
const faceMaterial = () => new THREE.MeshPhysicalMaterial({
  roughness: 1, metalness: 0,
  bumpMap: faceGrain, bumpScale: CONFIG.paper.bumpScale,
  clearcoat: 0,
  clearcoatRoughness: CONFIG.paper.gloss.roughness,
  envMap: envTexture,
  envMapIntensity: CONFIG.light.env,
});
const matFront = faceMaterial();
const matBack = faceMaterial();
const matEdge = new THREE.MeshStandardMaterial({
  // 注意：ColorManagement 開著的時候 new Color('#...') 已經幫你從 sRGB 轉成線性了，
  // 再呼叫一次 convertSRGBToLinear 會轉第二次，顏色會偏暗
  color: new THREE.Color(CONFIG.paper.edgeColor),
  roughness: 0.96, metalness: 0,
  bumpMap: grainTexture(60 * S, 1), bumpScale: CONFIG.paper.bumpScale * 0.6,
  envMap: envTexture, envMapIntensity: CONFIG.light.env,
});

const card = new THREE.Mesh(buildCardGeometry(CONFIG.card), [matFront, matBack, matEdge]);
card.rotation.set(CONFIG.motion.restX, CONFIG.motion.restY, 0);
scene.add(card);

/* ---------------------------------------------------------------- 燈光 */

const spot = new THREE.SpotLight(
  CONFIG.light.color, CONFIG.light.intensity * S * S, 0, CONFIG.light.angle, CONFIG.light.penumbra, 2,
);
spot.position.set(...CONFIG.light.position.map((v) => v * S));
spot.target.position.set(0, 1.2 * S, 0);   // 對準偏上，上緣亮、下緣沉進暗裡
scene.add(spot);
scene.add(spot.target);

// 極微弱的環境補光，讓背光面不是一片死黑
scene.add(new THREE.HemisphereLight(0x2b3442, 0x08080a, CONFIG.light.fill));

// 背側冷色輪廓光，把卡片邊緣從黑底裡拉出來
const rim = new THREE.DirectionalLight(0x86a0ff, CONFIG.light.rim);
rim.position.set(11, 5, -14);
scene.add(rim);

// 右側柔光。用面光源而不是第二盞聚光燈 —— 面光源的明暗交界是真的軟的，
// 那才是「柔光」；聚光燈再怎麼調 penumbra 都還是一圈光斑。
RectAreaLightUniformsLib.init();
const sideLight = new THREE.RectAreaLight(CONFIG.light.sideColor, CONFIG.light.side, 16 * S, 22 * S);
sideLight.position.set(14.5 * S, 2.5 * S, 9 * S);
sideLight.lookAt(0, 0, 0);
scene.add(sideLight);

// 卡片後方的光暈：不是一面牆，是「空氣裡被燈照亮的那一團」。
// 有它，卡片轉到側面時輪廓才不會直接消失在黑底裡。
function glowTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,236,208,1)');
  grad.addColorStop(0.30, 'rgba(255,226,192,0.38)');
  grad.addColorStop(0.66, 'rgba(176,146,116,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

const glowTex = new THREE.CanvasTexture(glowTexture());
glowTex.colorSpace = THREE.SRGBColorSpace;
const glow = new THREE.Mesh(
  new THREE.PlaneGeometry(46 * S, 46 * S),
  new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: CONFIG.light.glow,
  }),
);
glow.position.set(-2.2 * S, 1.4 * S, -9 * S);
glow.renderOrder = -1;
scene.add(glow);

/* ---------------------------------------------------------------- 後處理：顆粒 */

// 顆粒跟著光走。底片的粒子是光子打出來的，亮的地方才明顯 ——
// 整片均勻灑同樣的雜訊會看起來像壞掉的電視，不像打光。
const GrainShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAmount: { value: CONFIG.light.noise },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAmount;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));

      // 兩層不同相位、不同尺度的雜訊疊起來，顆粒才有底片的不規則感
      vec2 sp = gl_FragCoord.xy;
      float n = hash(sp + uTime * 91.7) + hash(sp * 1.73 - uTime * 53.3) - 1.0;

      // sqrt(亮度) 是光子雜訊的樣子。
      // 純黑的地方一定要讓顆粒歸零 —— 負的那一半會被 clamp 掉，
      // 只剩正的那一半，整片黑底就會被抬成一層灰霧。
      float gate = smoothstep(0.0, 0.03, l);
      float w = uAmount * (sqrt(clamp(l, 0.0, 6.0)) + 0.22 * gate) * gate;
      gl_FragColor = vec4(max(c.rgb + n * w, 0.0), c.a);
    }`,
};

// 注意：畫進 render target 時 three 不會做 tone mapping，
// 所以顆粒是加在線性 HDR 上的（物理上也該如此），最後交給 OutputPass 收尾。
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  samples: Math.min(4, renderer.capabilities.maxSamples || 4),   // 走後處理就吃不到 canvas 的 AA 了
}));
composer.addPass(new RenderPass(scene, camera));
const grainPass = new ShaderPass(GrainShader);
composer.addPass(grainPass);
composer.addPass(new OutputPass());

/* ---------------------------------------------------------------- 貼圖合成 */

const longSide = CONFIG.faceResolution;
const px = Math.round(CW >= CH ? longSide : longSide * (CW / CH));
const py = Math.round(CH >= CW ? longSide : longSide * (CH / CW));
const CARD_ASPECT = CW / CH;
const RECT_FULL = { x: 0, y: 0, w: 1, h: 1 };

const faces = {
  front: { material: matFront, mirror: false },
  back: { material: matBack, mirror: true },
};

/**
 * 這張圖是不是「已經照卡片排好版」的滿版稿？
 *
 * 是的話就原樣鋪滿，不裁切、不重新置中 —— 因為上光的元素常常刻意放在
 * 筆跡的空白處（例如版面上方只有上光、沒有筆跡），
 * 一旦照筆跡的外框裁切，那些元素會直接被切掉。
 */
function isFullBleed(img) {
  if (!img) return false;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return false;
  return Math.abs((w / h) / CARD_ASPECT - 1) <= CONFIG.paper.fullBleedTolerance;
}

function buildFace(which, inkImg, glossImg) {
  const f = faces[which];
  const fullBleed = isFullBleed(inkImg) || (!inkImg && isFullBleed(glossImg));

  let ink = null;
  let rect = RECT_FULL;
  if (inkImg) {
    const r = prepareInk(inkImg, { density: CONFIG.ink.density, crop: !fullBleed });
    ink = r.canvas;
    rect = r.rect;
  }
  // 上光遮罩套用「筆跡那一張」算出來的裁切框，兩層才會對齊
  const mask = glossImg ? prepareMask(glossImg, rect) : null;

  const { color, rough, gloss } = composeFace({
    ink, mask, grain: grainCanvas, px, py,
    paperColor: CONFIG.paper.color,
    margin: fullBleed ? 0 : CONFIG.paper.margin,   // 滿版稿自己帶留白
  });

  const colorTex = new THREE.CanvasTexture(color);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = maxAniso;
  const roughTex = new THREE.CanvasTexture(rough);
  roughTex.anisotropy = maxAniso;
  const glossTex = gloss ? new THREE.CanvasTexture(gloss) : null;
  if (glossTex) glossTex.anisotropy = maxAniso;

  if (f.mirror) {
    // 背面是從後方看的，UV 左右翻回來，字才不會變鏡像
    for (const t of [colorTex, roughTex, glossTex]) {
      if (!t) continue;
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.offset.x = 1;
    }
  }

  f.material.map = colorTex;
  f.material.roughnessMap = roughTex;
  f.material.clearcoatMap = glossTex;
  f.material.clearcoat = glossTex ? CONFIG.paper.gloss.strength : 0;
  f.material.needsUpdate = true;
}

/* ---------------------------------------------------------------- 載入 */

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function tryLoad(base) {
  for (const ext of ['webp', 'png', 'jpg']) {
    try { return await loadImage(`textures/${base}.${ext}`); } catch { /* 換下一個副檔名 */ }
  }
  return null;
}

async function init() {
  const [front, back, frontGloss, backGloss] = await Promise.all([
    tryLoad('front'), tryLoad('back'), tryLoad('front-gloss'), tryLoad('back-gloss'),
  ]);
  buildFace('front', front, frontGloss);
  buildFace('back', back, backGloss);

  hintEl.textContent = '拖曳旋轉　·　雙擊翻面';
  setTimeout(() => hintEl.classList.add('gone'), 4600);
}

/* ---------------------------------------------------------------- 互動 */

const ctl = createCardControls(canvas);

const autoBtn = document.getElementById('auto-toggle');
const autoIcon = autoBtn.querySelector('svg');
autoIcon.style.animationDuration = `${CONFIG.motion.autoPeriod}s`;   // 圖示跟卡片同速
autoBtn.addEventListener('click', () => {
  const on = !ctl.auto;
  ctl.setAuto(on);
  autoBtn.classList.toggle('on', on);
  autoBtn.setAttribute('aria-pressed', String(on));
});

function fitCamera() {
  const vFov = (camera.fov * Math.PI) / 180;
  const pad = 1.62 * ctl.zoom;
  const dH = (CH * pad * 0.5) / Math.tan(vFov / 2);
  const dW = (CW * pad * 0.5) / Math.tan(vFov / 2) / camera.aspect;
  camera.position.z = Math.max(dH, dW);
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  fitCamera();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

/* ---------------------------------------------------------------- 主迴圈 */

let prev = performance.now();

renderer.setAnimationLoop((now) => {
  // 夾住 dt：分頁切回來時不要一次跳一大段，但也別夾太緊 ——
  // 夾在 0.05 等於把 20fps 以下的機器整個放慢播放
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;

  ctl.update(dt, now / 1000);
  card.rotation.x = ctl.rx + ctl.idleX;
  card.rotation.y = ctl.ry + ctl.idleY;
  fitCamera();

  grainPass.uniforms.uTime.value = now / 1000;
  composer.render(dt);
});

init();
