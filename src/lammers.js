// lammers.js - white "OFF" dealer buttons (lammers) that sit on top of any chip stack whose bet
// is not working (place/buy on the come-out, come odds on the come-out, hardways on the come-out,
// or any bet the player switched OFF). Reads the live game every frame, so it follows rolls,
// toggles, point changes and chip animations without extra wiring.
import * as THREE from 'three';
import { CHIP_T } from './chips.js';

const R = 0.17, H = 0.03;

function offTexture(size = 256) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const c = cv.getContext('2d'), m = size / 2;
  const g = c.createRadialGradient(m, m * 0.8, size * 0.05, m, m, m);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e6e3da');
  c.fillStyle = g; c.beginPath(); c.arc(m, m, m, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#1b1b1d'; c.lineWidth = size * 0.035; c.beginPath(); c.arc(m, m, m * 0.84, 0, Math.PI * 2); c.stroke();
  c.fillStyle = '#121214'; c.font = `900 ${size * 0.36}px "Arial Black", Arial, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('OFF', m, m + size * 0.02);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

export class Lammers {
  constructor(scene, chips, game) {
    this.chips = chips; this.game = game;
    this.group = new THREE.Group(); this.group.name = 'lammers'; scene.add(this.group);
    const geo = new THREE.CylinderGeometry(R, R, H, 40);
    const side = new THREE.MeshStandardMaterial({ color: 0xeeebe2, roughness: 0.35 });
    const top = new THREE.MeshStandardMaterial({ map: offTexture(), roughness: 0.3, metalness: 0 });
    this.geo = geo; this.mats = [side, top, top];
    this.pool = new Map(); // betId -> mesh
  }
  _mesh(id) {
    let m = this.pool.get(id);
    if (!m) {
      m = new THREE.Mesh(this.geo, this.mats); m.castShadow = true;
      m.rotation.y = -0.35; // text reads toward the player
      this.group.add(m); this.pool.set(id, m);
    }
    return m;
  }
  update() {
    const g = this.game, off = new Set();
    for (const id of Object.keys(g.bets)) if (!g.isWorking(id)) off.add(id);
    for (const [id, m] of this.pool) if (!off.has(id)) { this.group.remove(m); this.pool.delete(id); }
    for (const id of off) {
      const st = this.chips.stacks.get(id);
      if (!st || !st.chips.length) { const m = this.pool.get(id); if (m) m.visible = false; continue; }
      const s = this.chips._spotFor(id);
      const m = this._mesh(id); m.visible = true;
      // rest the button on the top chip, nudged off-centre like a dealer drops it
      m.position.set(s.x + 0.07, s.y + st.chips.length * CHIP_T + H / 2 + 0.001, s.z - 0.05);
    }
  }
}
