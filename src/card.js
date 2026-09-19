// 卡片本體：圓角 + 微倒角的擠出幾何，正面／背面／切口各自吃一份材質。
import * as THREE from 'three';

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * ExtrudeGeometry 預設把正反兩個大面丟進同一個 group，
 * 這樣沒辦法正反面貼不同圖 —— 所以照法線的 z 把它拆成兩群再重排。
 * 拆完 group 變成：0 = 正面、1 = 背面、2 = 切口。
 */
function splitCapGroups(geo) {
  const cap = geo.groups.find((g) => g.materialIndex === 0);
  const side = geo.groups.find((g) => g.materialIndex === 1);
  if (!cap || !side) return;

  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const uv = geo.attributes.uv.array;

  const front = [], back = [];
  for (let t = 0; t < cap.count / 3; t++) {
    const v0 = cap.start + t * 3;
    const nz = nor[v0 * 3 + 2] + nor[(v0 + 1) * 3 + 2] + nor[(v0 + 2) * 3 + 2];
    (nz >= 0 ? front : back).push(v0);
  }

  const order = front.concat(back);
  const np = new Float32Array(cap.count * 3);
  const nn = new Float32Array(cap.count * 3);
  const nu = new Float32Array(cap.count * 2);
  let w = 0;
  for (const v0 of order) {
    for (let k = 0; k < 3; k++) {
      const s = v0 + k;
      np[w * 3] = pos[s * 3]; np[w * 3 + 1] = pos[s * 3 + 1]; np[w * 3 + 2] = pos[s * 3 + 2];
      nn[w * 3] = nor[s * 3]; nn[w * 3 + 1] = nor[s * 3 + 1]; nn[w * 3 + 2] = nor[s * 3 + 2];
      nu[w * 2] = uv[s * 2]; nu[w * 2 + 1] = uv[s * 2 + 1];
      w++;
    }
  }
  pos.set(np, cap.start * 3);
  nor.set(nn, cap.start * 3);
  uv.set(nu, cap.start * 2);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
  geo.attributes.uv.needsUpdate = true;

  geo.clearGroups();
  geo.addGroup(cap.start, front.length * 3, 0);
  geo.addGroup(cap.start + front.length * 3, back.length * 3, 1);
  geo.addGroup(side.start, side.count, 2);
}

export function buildCardGeometry({ width, height, thickness, radius }) {
  const bevel = Math.min(thickness * 0.22, 0.02);
  const depth = Math.max(1e-4, thickness - bevel * 2);

  const uvGenerator = {
    generateTopUV(geometry, vertices, iA, iB, iC) {
      const p = (i) => new THREE.Vector2(
        (vertices[i * 3] + width / 2) / width,
        (vertices[i * 3 + 1] + height / 2) / height,
      );
      return [p(iA), p(iB), p(iC)];
    },
    generateSideWallUV(geometry, vertices, iA, iB, iC, iD) {
      // 切口是純色，UV 只要不退化就好
      const q = (i) => new THREE.Vector2(
        (vertices[i * 3] + vertices[i * 3 + 1] + width) / (width + height),
        vertices[i * 3 + 2] / Math.max(1e-6, thickness) + 0.5,
      );
      return [q(iA), q(iB), q(iC), q(iD)];
    },
  };

  const geo = new THREE.ExtrudeGeometry(roundedRectShape(width, height, radius), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 2,
    curveSegments: 18,
    UVGenerator: uvGenerator,
  });
  geo.translate(0, 0, -depth / 2);
  splitCapGroups(geo);
  geo.computeBoundingSphere();
  return geo;
}
