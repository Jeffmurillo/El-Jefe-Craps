// camera.js — camera rig: named presets, critically-damped transitions, damped user orbit/zoom,
// gentle dolly toward the dice while they roll, and a barely-there handheld "breathing" drift.
import * as THREE from 'three';

export const PRESETS = {
  // main gameplay view: the player standing at the near rail right of centre, looking down the layout
  // at ~39 deg pitch with ~31 deg of yaw. The whole layout stays readable (both end caps, every box),
  // the dice landing end is the near one (dice read ~2x larger than straight-on), the near rail and the
  // racked chips give a foreground depth cue, and the casino floor (slot glow, bokeh, lamp pools)
  // fills the top-right of the frame beyond the far rail.
  // (r2) target +1.5 in x so the layout sits centred, the eye ~5 deg lower (~34 deg) for a richer 3/4 depth,
  // and the felt framed inside the HUD panels (no felt under the balance card or the ROLL button)
  overview: { pos: [14.5, 16.0, 20.6], target: [1.5, -1.6, -3.3], fov: 47 },
  // attract / hero framing (?shot=overview&view=hero, also in the view cycle): low 3/4 from the
  // right-front corner (~25 deg pitch), the lacquered near rail and racked chips in the foreground, the
  // dice end near, the layout receding, slot banks and bokeh filling the top third of the frame
  hero:     { pos: [19.5, 11.5, 15.5], target: [2.5, 0.6, -1.6], fov: 40 },
  player:   { pos: [-14.5, 9.4, 15.8], target: [-3.5, 0, -1.2], fov: 44 },
  layout:   { pos: [0, 29.2, 12.6], target: [0, 0, 0.7], fov: 40 }, // ~65 deg: whole layout readable (near pass line clears the tub wall), with real perspective depth
  end:      { pos: [-28, 11.5, 0.5], target: [-1, 0, 0], fov: 42 },
  stickman: { pos: [0, 9.5, -19.5], target: [0, 0, 0.8], fov: 46 },
  chips:    { pos: [-11.4, 6.4, 1.6], target: [-9.4, 0, -4.2], fov: 42 },
};
export const PRESET_ORDER = ['overview', 'hero', 'player', 'layout', 'end', 'stickman'];

const tmpV = new THREE.Vector3();
const tmpOff = new THREE.Vector3();
const tmpS = new THREE.Spherical();
const tmpNdc = new THREE.Vector3();
const tmpHold = new THREE.Vector3();
const tmpHS = new THREE.Spherical();

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.isShot = new URLSearchParams(location.search).has('shot');
    this.target = new THREE.Vector3();
    this.goalTarget = new THREE.Vector3();
    this.sph = new THREE.Spherical();
    this.goalSph = new THREE.Spherical();
    this.fov = camera.fov; this.goalFov = camera.fov;
    // user orbit (goal + smoothed)
    this.userYaw = 0; this.userPitch = 0; this.userZoom = 1;
    this.yaw = 0; this.pitch = 0; this.zoom = 1;
    this.focus = null; this.focusWeight = 0; this.goalFocusWeight = 0;
    this.holdT = 0; this.holdW = 0; this.holdPoint = null; this.holdSrc = null;
    this.restLevel = 0; this.restW = 0; this.restPoint = null;
    this.presetName = 'overview';
    this.stiffness = 3.2;
    this.time = 0;
    this.breathe = !this.isShot;
    // live play opens on the top-down layout view; ?shot captures keep the 3/4 overview they were framed for
    this.setPreset(this.isShot ? 'overview' : 'layout', { instant: true });
    this._bindInput();
  }

  setPreset(name, { instant = false } = {}) {
    let p = typeof name === 'string' ? PRESETS[name] : name;
    // debug: ?cam=x,y,z,tx,ty,tz[,fov] overrides every framing (for screenshot review)
    const dc = new URLSearchParams(location.search).get('cam');
    if (dc) { const v = dc.split(',').map(Number); p = { pos: v.slice(0, 3), target: v.slice(3, 6), fov: v[6] || 40 }; }
    if (!p) return;
    if (typeof name === 'string') this.presetName = name;
    this.goalTarget.set(...p.target);
    tmpV.set(...p.pos).sub(this.goalTarget);
    this.goalSph.setFromVector3(tmpV);
    this.goalFov = p.fov || 40;
    this.restLevel = 0;
    this.userYaw = 0; this.userPitch = 0; this.userZoom = 1;
    if (instant) {
      this.target.copy(this.goalTarget); this.sph.copy(this.goalSph); this.fov = this.goalFov;
      this.yaw = 0; this.pitch = 0; this.zoom = 1;
      this._apply();
    }
  }

  /** Look at an arbitrary pos/target (used by shot modes for custom framing). */
  lookFrom(pos, target, fov = 40, instant = true) { this.setPreset({ pos, target, fov }, { instant }); this.presetName = 'custom'; }

  /** Gently bias the camera toward a world point (e.g. rolling dice). weight 0..1 */
  setFocus(point, weight) {
    if (point) { this.focus = (this.focus || new THREE.Vector3()).copy(point); }
    this.goalFocusWeight = weight;
    if (weight > 0) this.restLevel = 0; // a new throw: release the resting-dice push
  }

  /**
   * Keep a residual push toward resting dice (after a hold, or set directly for a shot): the aim drifts
   * ~20% onto the pair and the eye comes ~20% closer, keeping both end caps in frame (the floating result tag\n   * from stage.showResult carries the number), so the result reads in the gameplay view.
   * Released by the next throw (setFocus with weight > 0), the player's next click, a preset change or a view reset.
   */
  restOn(point, { instant = false, level = 1 } = {}) {
    if (!point) { this.restLevel = 0; return; }
    this.restPoint = (this.restPoint || new THREE.Vector3()).copy(point);
    this.restLevel = level;
    if (instant) { this.restW = level; this._apply(); }
  }

  /**
   * After a roll: dolly in on the resting dice (aim onto them, push ~60% closer, drop the eye a little)
   * for `seconds`, then ease back to the preset. `point` is read live, so a die still settling is tracked.
   */
  hold(point, seconds = 1.9) {
    if (!point) { this.holdT = 0; return; }
    this.holdSrc = point;
    this.holdPoint = (this.holdPoint || new THREE.Vector3()).copy(point);
    this.holdT = seconds;
    this.goalFocusWeight = 0; // the roll-follow fades out underneath the hold, no double push
    this.restOn(point);       // after the hold, settle into a gentle resting push rather than all the way back
  }

  /** Reset any user orbit/zoom back to the current preset. */
  resetView() { this.userYaw = 0; this.userPitch = 0; this.userZoom = 1; this.restLevel = 0; }

  _bindInput() {
    const el = this.dom;
    let down = null;
    this.dragging = false;
    // touch screens keep the fixed top-down view: no finger orbit or pinch zoom (mouse drag / wheel still work).
    // A multi-finger touch only counts as "dragging" so it never books chips; it clears once every finger lifts.
    const touches = new Set();
    el.style.touchAction = 'none'; // no browser scroll / page zoom over the table
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') { touches.add(e.pointerId); if (touches.size > 1) this.dragging = true; return; }
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, yaw: this.userYaw, pitch: this.userPitch };
    });
    const lift = (e) => { if (touches.delete(e.pointerId) && touches.size === 0) setTimeout(() => { this.dragging = false; }, 0); };
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', (e) => { lift(e); down = null; setTimeout(() => { this.dragging = false; }, 0); });
    window.addEventListener('pointermove', (e) => {
      if (!down || e.pointerType === 'touch') return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!this.dragging && Math.hypot(dx, dy) > 6) this.dragging = true;
      if (this.dragging) {
        this.userYaw = THREE.MathUtils.clamp(down.yaw - dx * 0.0042, -1.15, 1.15);
        this.userPitch = THREE.MathUtils.clamp(down.pitch - dy * 0.0032, -0.5, 0.42);
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return; // handled by lift(): a multi-finger touch stays "dragging" until all fingers are up
      // the resting-dice push holds until the player acts: a click (not a drag) eases back to the full layout
      if (down && !this.dragging && this.restLevel > 0) this.restLevel = 0;
      down = null; setTimeout(() => { this.dragging = false; }, 0);
    });
    el.addEventListener('dblclick', (e) => { if (e.pointerType !== 'touch' && !touches.size) this.resetView(); });
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.userZoom = THREE.MathUtils.clamp(this.userZoom * (e.deltaY > 0 ? 1.08 : 0.93), 0.45, 1.5); }, { passive: false });
  }

  _apply() {
    // keep the camera above the rail: limit polar angle so we never dip below the table edge
    tmpS.set(this.sph.radius * this.zoom, THREE.MathUtils.clamp(this.sph.phi - this.pitch, 0.08, 1.38), this.sph.theta + this.yaw);
    const fw = this.focusWeight;
    if (Math.abs(this.camera.fov - this.fov) > 1e-3) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }
    // subtle follow: the aim drifts toward the dice and the camera pushes in ~10-14% — a dolly,
    // never a cut. The aim lerp starts at half the focus weight and is raised (up to a full re-aim)
    // whenever the dice would leave the centre 70% of the frame, so a throw never exits the shot.
    let aim = this.focus && fw > 0.001 ? fw * 0.5 : 0;
    for (let it = 0; it < 4; it++) {
      this._pose(aim, fw);
      if (!(this.focus && fw > 0.001) || aim >= 1) break;
      this.camera.updateMatrixWorld(true);
      const p = tmpNdc.copy(this.focus).project(this.camera);
      const ex = p.z < 1 ? Math.max(Math.abs(p.x), Math.abs(p.y)) : 99;
      if (ex <= 0.56) break;
      // the dice's offset from the aim point scales with (1 - aim), and its NDC nearly so: solve for
      // the aim that lands it at 0.56 (inside the 0.7 limit even for the outer die). Continuous in the dice position,
      // so the follow stays smooth frame to frame.
      aim = Math.min(1, 1 - (1 - aim) * 0.56 / Math.min(ex, 6));
    }
  }

  _pose(aim, fw) {
    const t = tmpV.copy(this.target);
    if (aim > 0) t.lerp(this.focus, aim);
    const off = tmpOff.setFromSpherical(tmpS);
    if (fw > 0.001) off.multiplyScalar(1 - fw * 0.33);
    const rw = this.restW;
    if (rw > 0.001 && this.restPoint) {
      // resting-dice push: aim ~20% onto the pair and come ~15% closer on the same bearing and pitch,
      // so the result reads at a glance while the whole layout stays in frame and clickable
      t.lerp(this.restPoint, rw * 0.2);
      off.multiplyScalar(1 - rw * 0.2);
    }
    const hw = this.holdW;
    if (hw > 0.001 && this.holdPoint) {
      // eased so the dolly starts and lands softly (smoothstep of the already-damped weight). The hold
      // pose keeps the player's bearing but drops to a ~36 deg eye, 4.8 units off the pair: the 0.28
      // dice read ~75px tall with every pip legible, the felt around them and the back wall beyond.
      const e = hw * hw * (3 - 2 * hw);
      tmpHold.setFromSpherical(tmpHS.set(4.8, 0.94, tmpS.theta));
      t.lerp(this.holdPoint, e);
      off.lerp(tmpHold, e);
    }
    this.camera.position.copy(t).add(off);
    if (this.breathe) {
      // slow, tiny handheld drift (a few cm) so the frame never feels frozen
      const k = this.time;
      this.camera.position.x += Math.sin(k * 0.31) * 0.06 + Math.sin(k * 0.73) * 0.025;
      this.camera.position.y += Math.sin(k * 0.43 + 1.3) * 0.04;
    }
    this.camera.lookAt(t);
  }

  update(dt) {
    this.time += dt;
    const k = 1 - Math.exp(-dt * this.stiffness);
    this.target.lerp(this.goalTarget, k);
    this.sph.radius += (this.goalSph.radius - this.sph.radius) * k;
    this.sph.phi += (this.goalSph.phi - this.sph.phi) * k;
    let dth = this.goalSph.theta - this.sph.theta;
    while (dth > Math.PI) dth -= Math.PI * 2; while (dth < -Math.PI) dth += Math.PI * 2;
    this.sph.theta += dth * k;
    this.fov += (this.goalFov - this.fov) * k;
    // user input is smoothed separately (snappier) for a weighty, premium orbit feel
    const ku = 1 - Math.exp(-dt * 9);
    this.yaw += (this.userYaw - this.yaw) * ku;
    this.pitch += (this.userPitch - this.pitch) * ku;
    this.zoom += (this.userZoom - this.zoom) * ku;
    this.focusWeight += (this.goalFocusWeight - this.focusWeight) * (1 - Math.exp(-dt * 2.2));
    if (this.holdT > 0) { this.holdT -= dt; if (this.holdSrc && this.holdPoint) this.holdPoint.lerp(this.holdSrc, 1 - Math.exp(-dt * 6)); }
    this.restW += ((this.restLevel || 0) - this.restW) * (1 - Math.exp(-dt * 1.4));
    const hGoal = this.holdT > 0 ? 1 : 0;
    this.holdW += (hGoal - this.holdW) * (1 - Math.exp(-dt * (hGoal ? 3.0 : 1.7)));
    this._apply();
  }
}
