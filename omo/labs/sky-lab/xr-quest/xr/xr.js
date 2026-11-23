// Omo sky XR: the baked penthouse + live desk terminals in a Meta Quest headset (WebXR, Quest Browser).
// Hooked from index.html by ONE line marked `// xr:hook`. Nothing changes until the user presses "Enter VR".
//
// In the headset:
//   Left stick                 walk (same capsule physics as desktop: walls, glass and furniture block you)
//   Left stick clicked in      run
//   Right stick left / right   snap turn 30°  (comfort: no smooth turning)
//   Right trigger              point at any terminal screen and pull: it takes the keyboard, from any distance
//   Trigger on a screen's bar  hold and move the hand: the screen goes with it (it turns to face you); let go near a
//                              wall and it lies flat on the wall
//   Trigger on the corner      hold and move: resize (terminals keep their shape)
//   Trigger on the x           close the screen (a terminal's session is ended)
//   Grip on any screen         grab it and carry it, the same as the bar
//   "+ Terminal" on the wrist  point and pull: a new terminal screen in front of you
//   B                          bring the active terminal up in front of you as a big readable panel / send it back
//   A (or the trigger on empty space)   release the terminal and go back to walking
//   Grip (on the panel)        grab the panel and move it; let go to leave it there
//   Right stick forward        aim a teleport at the floor; let go to jump there
//   Right stick clicked in     teleport-only mode on/off (the left stick stops walking)
//   Y (left)                   comfort vignette on/off (the edges dim while you move)
//   X (left)                   seated mode on/off (lifts your eye height to a standing person's)
//   Hand tracking              point with a hand and pinch: the same as the trigger
//   Typing                     a paired Bluetooth keyboard, or the Quest system keyboard (it opens when a terminal is active)
// Comfort settings are kept in localStorage ('omo-xr-comfort'). A loading card shows inside the headset until the
// scene is compiled and the desks are connected (at most 8 s).
//
// Emulator for tests and desktop review: open with ?xremu=1 -> Meta's IWER (MIT) is installed as navigator.xr with a
// Quest 3 profile; window.__xrDevice drives the headset and controllers.
import * as THREE from 'three';

const SNAP = Math.PI / 6, DEAD = 0.25, XR_WALK = 2.0, XR_RUN = 3.6,   // m/s: slower than desktop, kinder to the stomach
 PANEL_W = 1.7, PANEL_DIST = 1.1,   // 80x24 terminal: one text row is ~2.1 degrees tall at this size (was 1.8)
 STAND_EYE = 1.65, TELEPORT_MAX = 8, LOAD_MAX_MS = 8000,
 RAY_NEAR_R = 0.0015, RAY_FAR_R = 0.003;   // pointer beam radius (m) at the hand / at the far end

function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }
function label(text, w = 1024, h = 128) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const set = (t, accent = '#7CF2D0') => {
    g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(10,12,16,0.82)'; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 28); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 3; g.stroke();
    g.fillStyle = accent; g.beginPath(); g.arc(56, h / 2, 12, 0, 7); g.fill();
    // shrink the font until the whole hint fits the pill (long hints were cut off: "A: releas")
    let px = 44; g.textBaseline = 'middle';
    for (; px > 22; px -= 2) { g.font = `500 ${px}px Inter, system-ui, sans-serif`; if (g.measureText(t).width <= w - 92 - 32) break; }
    g.fillStyle = '#e8ecf1'; g.fillText(t, 92, h / 2 + 2);
    info.text = t; info.px = px; info.fits = g.measureText(t).width <= w - 92 - 32;
    tex.needsUpdate = true;
  };
  const info = {};
  set(text); return { tex, set, info };
}

export async function attachXR({ scene, camera, renderer, walker, live }) {
  const q = new URLSearchParams(location.search);
  if (q.get('xremu') === '1' && !window.IWER) {
    await loadScript('xr/iwer.min.js');
    const dev = new window.IWER.XRDevice(window.IWER.metaQuest3);
    dev.installRuntime({ forceInstall: true }); dev.stereoEnabled = q.get('stereo') === '1';
    window.__xrDevice = dev;
  }
  const api = window.__xr = { supported: false, presenting: false, focus: null, panel: false, frames: 0, turns: 0, sent: [], frameMs: [] };
  if (!navigator.xr) return api;
  api.supported = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (!api.supported) return api;

  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setFoveation(1);

  // ------------------------------------------------------------------ rig: the dolly carries the head and both hands
  const dolly = new THREE.Group(); dolly.name = 'xr-dolly'; scene.add(dolly);
  const hands = [0, 1].map(i => {
    const ctl = renderer.xr.getController(i);
    // pointer beam: a thin tapered tube, not a GL line (lines are always 1 px wide, too faint in a 2064 px eye).
    // Unit length along -Z from the hand; scale.z = distance to the hit. 3 mm at the hand, 6 mm at the far end.
    const beamGeo = new THREE.CylinderGeometry(RAY_FAR_R, RAY_NEAR_R, 1, 10, 1, true); beamGeo.rotateX(-Math.PI / 2); beamGeo.translate(0, 0, -0.5);
    const line = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: 0x7CF2D0, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }));
    line.name = 'xr-ray'; line.raycast = () => {}; line.scale.z = 5; line.visible = false; ctl.add(line);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.018, 16, 10), new THREE.MeshBasicMaterial({ color: 0x7CF2D0, toneMapped: false }));
    dot.raycast = () => {};
    dot.visible = false; scene.add(dot);
    const grip = renderer.xr.getControllerGrip(i);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.09, 4, 12), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.35, metalness: 0.2 }));
    body.rotation.x = Math.PI / 2 - 0.5; grip.add(body);
    const h = { i, ctl, grip, line, dot, src: null, prev: {} };
    ctl.addEventListener('connected', (e) => { h.src = e.data; line.visible = true; body.visible = !e.data.hand; });
    ctl.addEventListener('disconnected', () => { h.src = null; line.visible = false; dot.visible = false; });
    dolly.add(ctl); dolly.add(grip);
    return h;
  });
  const hand = (side) => hands.find(h => h.src && h.src.handedness === side);

  // wrist label (left hand): what the trigger will do / which terminal is typing
  const wrist = label('Point at a screen and pull the trigger');
  const wristMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.025), new THREE.MeshBasicMaterial({ map: wrist.tex, transparent: true, toneMapped: false, depthTest: false }));
  wristMesh.renderOrder = 10; wristMesh.position.set(0, 0.045, 0.02); wristMesh.rotation.x = -0.9;
  // wrist button: a new terminal screen (the right pointer hits it before anything in the room)
  const addLabel = label('+ Terminal', 512, 128);
  const addBtn = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.0225), new THREE.MeshBasicMaterial({ map: addLabel.tex, transparent: true, toneMapped: false, depthTest: false }));
  addBtn.renderOrder = 10; addBtn.name = 'xr-add-term'; addBtn.position.set(0, 0.03, 0);   // just above the wrist hint, same tilt
  wristMesh.add(addBtn);

  // comfort settings (persisted)
  const comfort = Object.assign({ vignette: true, seated: false, teleportOnly: false }, (() => { try { return JSON.parse(localStorage.getItem('omo-xr-comfort') || '{}'); } catch { return {}; } })());
  const saveComfort = () => { try { localStorage.setItem('omo-xr-comfort', JSON.stringify(comfort)); } catch {} };
  api.comfort = comfort; api.vignette = 0; api.seatedLift = 0; api.teleports = 0; api.teleportAim = null; api.grabs = 0;

  // vignette: a dark ring in front of the eyes, faded in while the body moves (stick walking or a snap turn)
  const vigMat = new THREE.ShaderMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { strength: { value: 0 } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform float strength; varying vec2 vP; void main(){ float r = length(vP) / 0.2; float a = smoothstep(0.62, 1.25, r) * strength; gl_FragColor = vec4(0.0,0.0,0.0,a); }' });
  const vignette = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), vigMat);   // 0.2 m in front: clear inside ~32 deg, dark past ~51 deg
  vignette.position.set(0, 0, -0.2); vignette.renderOrder = 999; vignette.frustumCulled = false; vignette.visible = false; vignette.name = 'xr-vignette';
  let turnFlash = 0;

  // teleport marker
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40), new THREE.MeshBasicMaterial({ color: 0xF2CC60, toneMapped: false, transparent: true, opacity: 0.9, depthTest: false }));
  marker.rotation.x = -Math.PI / 2; marker.renderOrder = 11; marker.visible = false; marker.name = 'xr-teleport-marker'; scene.add(marker);
  const tpRay = new THREE.Raycaster(), nrm = new THREE.Vector3(), nm3 = new THREE.Matrix3();

  // in-headset loading card: a separate tiny scene drawn until the real one is compiled and the desks are live
  const loadScene = new THREE.Scene(); loadScene.background = new THREE.Color(0x0a0c10);
  const loadLabel = label('Omo Space · loading your desk…', 1024, 128);
  const loadCard = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.1125), new THREE.MeshBasicMaterial({ map: loadLabel.tex, transparent: true, toneMapped: false }));
  loadScene.add(loadCard);

  // summoned panel: the active terminal, big and close (same texture as the desk monitor, so it is always in sync)
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_W * 0.5769), new THREE.MeshBasicMaterial({ toneMapped: false }));
  panel.visible = false; panel.name = 'xr-panel'; scene.add(panel);
  const panelFrame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(PANEL_W + 0.02, PANEL_W * 0.5769 + 0.02)), new THREE.LineBasicMaterial({ color: 0x7CF2D0, toneMapped: false }));
  panel.add(panelFrame);

  // system keyboard / Bluetooth keyboard text -> the active terminal (live.js handles real key events itself)
  const ta = document.createElement('textarea');
  Object.assign(ta.style, { position: 'fixed', left: '0', bottom: '0', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocomplete', 'off'); ta.spellcheck = false; ta.id = 'omo-xr-ta';
  document.body.appendChild(ta);
  const send = (s) => { const L = live(); if (L && L.send(s)) { api.sent.push(s); if (api.sent.length > 50) api.sent.shift(); return true; } return false; };
  ta.addEventListener('input', (e) => {
    if (e.inputType === 'deleteContentBackward') send('\x7f');
    else if (e.inputType === 'insertLineBreak' || e.data === '\n') send('\r');
    else if (e.data) send(e.data);
    ta.value = '';
  });

  // ------------------------------------------------------------------ focus
  const L0 = () => live() || null;
  function deskName(f) { const L = L0(); return (L && L.title && L.title(f)) || f.replace('term:', ''); }
  function setFocus(f) {
    const L = L0(); if (!L) return;
    L.setFocus(f, 'far'); api.focus = f;
    if (f) {
      wrist.set(`Typing into ${deskName(f)} · B: bring closer · A: release`);
      try { ta.focus({ preventScroll: true }); } catch {}
      showPanel(true);
    } else {
      wrist.set('Point at a screen and pull the trigger', '#8b96a5');
      ta.blur(); showPanel(false);
    }
  }
  const head = new THREE.Vector3(), fwd = new THREE.Vector3();
  // Head pose in WORLD space. The XR ArrayCamera has no parent, so its getWorldPosition() rebuilds matrixWorld from the
  // local pose and silently drops the rig (dolly). The scene camera is a child of the dolly and is synced from the
  // headset on every render, so read it instead (one frame old, which is fine for placing things).
  const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _hs = new THREE.Vector3();
  function headPose(pos, dir, quat) {
    dolly.updateMatrixWorld(true); camera.updateMatrixWorld(true); camera.matrixWorld.decompose(_hp, _hq, _hs);
    if (pos) pos.copy(_hp); if (quat) quat.copy(_hq); if (dir) dir.set(0, 0, -1).applyQuaternion(_hq);
  }
  function showPanel(on) {
    api.panel = !!(on && api.focus);
    if (!api.panel) { panel.visible = false; return; }
    const L = L0(); panel.material.map = L.deskTexture(api.focus.slice(5)); panel.material.needsUpdate = true;
    const xc = renderer.xr.getCamera(); headPose(head, fwd); fwd.y = 0; fwd.normalize();
    panel.position.copy(head).addScaledVector(fwd, PANEL_DIST); panel.position.y = head.y - 0.12;
    panel.lookAt(head.x, panel.position.y, head.z); panel.visible = true;
  }

  // ------------------------------------------------------------------ session
  let yaw = 0;   // the rig's yaw (snap turns); head yaw on top comes from the headset
  renderer.xr.addEventListener('sessionstart', () => {
    const w = walker(); api.presenting = true; api.frames = 0;
    if (w) { yaw = w.yaw; w.camera = null; w.enabled = true; for (const k in w.input) w.input[k] = false; api.deskSpeeds = [w.opts.walkSpeed, w.opts.sprintSpeed]; w.opts.walkSpeed = XR_WALK; w.opts.sprintSpeed = XR_RUN; }
    dolly.add(camera); camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
    const L = L0(); if (L && L.cssRoot) L.cssRoot.style.display = 'none';   // DOM web walls cannot render inside a headset
    camera.add(vignette);
    setFocus(null);
    api.loading = true; api.loadingFrames = 0; api.loadStart = performance.now(); api.compiled = false;
    Promise.resolve().then(() => renderer.compileAsync ? renderer.compileAsync(scene, camera) : renderer.compile(scene, camera)).catch(() => {}).then(() => { api.compiled = true; });
    renderer.setAnimationLoop(frame);
  });
  renderer.xr.addEventListener('sessionend', () => {
    renderer.setAnimationLoop(null); api.presenting = false;
    const w = walker(); dolly.remove(camera); scene.updateMatrixWorld();
    if (w && api.deskSpeeds) { [w.opts.walkSpeed, w.opts.sprintSpeed] = api.deskSpeeds; }
    if (w) { w.camera = camera; w.setPose({ x: w.position.x, y: w.position.y, z: w.position.z, yaw, pitch: 0 }); w.enabled = false; }
    const L = L0(); if (L) { if (L.cssRoot) L.cssRoot.style.display = ''; L.setFocus(null); }
    panel.visible = false; api.focus = null; camera.remove(vignette); marker.visible = false; grab = null; sgrab = null;
  });

  // ------------------------------------------------------------------ per frame (XR loop)
  const ray = { o: new THREE.Vector3(), d: new THREE.Vector3(), q: new THREE.Quaternion() };
  const hq = new THREE.Quaternion(), he = new THREE.Euler(0, 0, 0, 'YXZ');
  let last = performance.now(), turnArmed = true, grab = null, sgrab = null;
  api.screenGrabs = 0; api.screenResizes = 0; api.closed = 0; api.created = 0; api.lastSnap = null;
  const sp = new THREE.Plane(), spt = new THREE.Vector3(), sn = new THREE.Vector3();
  const gm = new THREE.Matrix4(), gs = new THREE.Vector3();
  const pressed = (h, idx) => !!(h && h.src && h.src.gamepad && h.src.gamepad.buttons[idx] && h.src.gamepad.buttons[idx].pressed);
  const onPanel = (r) => { if (!panel.visible) return false; tpRay.set(r.o, r.d); tpRay.far = 10; return tpRay.intersectObject(panel, false).length > 0; };
  function startScreenGrab(h, hit, mode, btn) {
    const L = L0(), g = L && L.screenGroup(hit.screen); if (!g) return;
    g.updateMatrixWorld(true);
    const sc = L.screens().find(x => x.id === hit.screen);
    sgrab = { h, id: hit.screen, mode, btn, aspect: sc ? sc.w / sc.h : 1, off: h.ctl.matrixWorld.clone().invert().multiply(g.matrixWorld) };
    if (mode === 'move') api.screenGrabs++; else api.screenResizes++;
  }
  const edge = (h, idx) => { if (!h || (idx >= 2 && h.src && h.src.hand)) return false; const p = pressed(h, idx), was = !!h.prev[idx]; h.prev[idx] = p; return p && !was; };
  function frame(now) {
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const w = walker(), L = L0(), xc = renderer.xr.getCamera();
    const left = hand('left'), right = hand('right');

    // loading card until the scene is compiled and every desk is live (never longer than LOAD_MAX_MS)
    if (api.loading) {
      const desks = L ? L.desks() : [], liveN = desks.filter(d => d.status === 'live').length;
      const waited = performance.now() - api.loadStart;
      if (api.loadingFrames > 0 && ((api.compiled && liveN === desks.length) || waited > LOAD_MAX_MS)) { api.loading = false; api.loadMs = Math.round(waited); }
      else {
        const txt = `Omo Space · loading your desk… ${liveN}/${desks.length} terminals`;
        if (txt !== api.loadText) { api.loadText = txt; loadLabel.set(txt, api.compiled ? '#7CF2D0' : '#f2cc60'); }
        if (w) { dolly.position.set(w.position.x, w.position.y, w.position.z); dolly.rotation.set(0, yaw, 0); dolly.updateMatrixWorld(true); }
        headPose(head, fwd); fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
        loadCard.position.copy(head).addScaledVector(fwd, 1.2); loadCard.lookAt(head);
        renderer.render(loadScene, camera); api.loadingFrames++; api.frames++;
        return;
      }
    }

    // comfort toggles: Y vignette, X seated, right stick click teleport-only
    const toast = (t) => wrist.set(t, '#f2cc60');
    if (left && edge(left, 5)) { comfort.vignette = !comfort.vignette; saveComfort(); toast(`Comfort vignette ${comfort.vignette ? 'on' : 'off'}`); }
    if (left && edge(left, 4)) {
      comfort.seated = !comfort.seated; saveComfort();
      if (comfort.seated) { headPose(head); api.seatedLift = Math.min(0.9, Math.max(0, STAND_EYE - (head.y - api.seatedLift - (w ? w.position.y : 0)))); }
      else api.seatedLift = 0;
      toast(`Seated mode ${comfort.seated ? 'on' : 'off'}`);
    }
    if (right && edge(right, 3)) { comfort.teleportOnly = !comfort.teleportOnly; saveComfort(); toast(comfort.teleportOnly ? 'Teleport only: stick walking off' : 'Stick walking on'); }

    // walk: left stick, relative to where the head looks
    if (w) {
      headPose(null, null, hq); he.setFromQuaternion(hq, 'YXZ');
      w.yaw = w.targetYaw = he.y;
      const ax = left && left.src.gamepad ? left.src.gamepad.axes : [];
      const sx = ax[2] || 0, sy = ax[3] || 0;
      const walkOK = !comfort.teleportOnly;
      w.input.forward = walkOK && sy < -DEAD; w.input.back = walkOK && sy > DEAD; w.input.left = walkOK && sx < -DEAD; w.input.right = walkOK && sx > DEAD;
      w.input.sprint = pressed(left, 3) && sy < -DEAD;   // run only while the left stick is clicked in
      w.update(dt);
    }
    // snap turn: right stick, around the head so the world does not swing
    const rx = right && right.src.gamepad ? (right.src.gamepad.axes[2] || 0) : 0;
    const ry = right && right.src.gamepad ? (right.src.gamepad.axes[3] || 0) : 0;
    if (Math.abs(rx) < 0.3) turnArmed = true;
    else if (turnArmed && w && Math.abs(rx) > Math.abs(ry)) {
      turnArmed = false; const a = rx > 0 ? -SNAP : SNAP;
      headPose(head);
      const dx = w.position.x - head.x, dz = w.position.z - head.z, c = Math.cos(a), s = Math.sin(a);
      w.position.x = head.x + dx * c + dz * s; w.position.z = head.z - dx * s + dz * c;
      yaw += a; api.turns++; turnFlash = 0.25;
    }
    if (w) { dolly.position.set(w.position.x, w.position.y + api.seatedLift, w.position.z); }
    dolly.rotation.set(0, yaw, 0); dolly.updateMatrixWorld(true);

    // teleport: right stick forward aims a straight ray at the floor (up to 8 m); letting go jumps there
    marker.visible = false;
    if (right && w && ry < -0.6) {
      right.ctl.getWorldPosition(ray.o); right.ctl.getWorldQuaternion(ray.q); ray.d.set(0, 0, -1).applyQuaternion(ray.q);
      tpRay.set(ray.o, ray.d); tpRay.far = TELEPORT_MAX;
      const hit = tpRay.intersectObjects(w.colliders, true)[0];
      let ok = false;
      if (hit && hit.face) {
        nrm.copy(hit.face.normal).applyMatrix3(nm3.getNormalMatrix(hit.object.matrixWorld)).normalize();
        ok = nrm.y > 0.7 && Math.abs(hit.point.y - w.position.y) < 0.35;   // floor only: no tables, walls or glass
      }
      api.teleportAim = { valid: ok, point: hit ? hit.point.toArray() : null };
      if (hit) { marker.position.copy(hit.point).y += 0.01; marker.material.color.set(ok ? 0xF2CC60 : 0xE5534B); marker.visible = true; }
    } else if (api.teleportAim && Math.abs(ry) < 0.3) {
      const aim = api.teleportAim; api.teleportAim = null;
      if (aim.valid && w) {
        headPose(head);
        const old = w.pose, nx = aim.point[0] - (head.x - dolly.position.x), nz = aim.point[2] - (head.z - dolly.position.z);
        w.setPose({ x: nx, y: aim.point[1], z: nz });
        if (w._overlaps(w.opts.height)) w.setPose(old); else api.teleports++;
        dolly.position.set(w.position.x, w.position.y + api.seatedLift, w.position.z); dolly.updateMatrixWorld(true);
      }
    }

    // vignette strength follows body speed (and a short flash on snap turns)
    turnFlash = Math.max(0, turnFlash - dt);
    const moving = w && (w.speed > 0.15 || turnFlash > 0) ? 1 : 0, target = comfort.vignette ? moving : 0;
    api.vignette += (target - api.vignette) * Math.min(1, dt * 10); if (api.vignette < 0.01 && target === 0) api.vignette = 0;
    vigMat.uniforms.strength.value = api.vignette * 0.92; vignette.visible = api.vignette > 0;

    // pointing: the right controller (or the left if only one is connected)
    const pointer = right || left;
    for (const h of hands) h.dot.visible = false;
    if (pointer && L) {
      pointer.ctl.getWorldPosition(ray.o); pointer.ctl.getWorldQuaternion(ray.q); ray.d.set(0, 0, -1).applyQuaternion(ray.q);
      // the wrist button first: it sits on the other hand, in front of everything
      tpRay.set(ray.o, ray.d); tpRay.far = 1.5;
      const onAdd = left && pointer !== left && addBtn.parent && tpRay.intersectObject(addBtn, false)[0];
      const hit = onAdd ? null : L.pickRay(ray.o, ray.d, 60);
      api.lastHit = hit ? { focus: hit.focus, part: hit.part || null, screen: hit.screen || null, dist: +hit.dist.toFixed(2), point: hit.point.toArray().map(v => +v.toFixed(2)) } : onAdd ? { part: 'add', dist: +onAdd.distance.toFixed(2) } : null;
      pointer.line.scale.z = onAdd ? onAdd.distance : hit ? hit.dist : 5;
      pointer.line.material.color.set((hit && hit.focus) || onAdd ? 0x7CF2D0 : 0x8b96a5);
      if (hit && hit.focus) { pointer.dot.position.copy(hit.point); pointer.dot.visible = true; }
      if (edge(pointer, 0)) {   // trigger / pinch
        if (onAdd) { const id = L.createScreen('term', { dist: 1.3 }); api.created++; setFocus('term:' + id); showPanel(false); }
        else if (hit && hit.part === 'close') { L.closeScreen(hit.screen); api.closed++; if (api.focus && api.focus.slice(5) === hit.screen) setFocus(null); }
        else if (hit && (hit.part === 'bar' || hit.part === 'corner')) startScreenGrab(pointer, hit, hit.part === 'bar' ? 'move' : 'size', 0);
        else if (hit && hit.focus && hit.focus.startsWith('term:')) setFocus(hit.focus === api.focus ? null : hit.focus);
        else if (api.focus && !(panel.visible)) setFocus(null);
      }
      // grip on any screen (not the summoned panel): carry it
      // (the summoned panel in front wins: its own grip code below handles it)
      if (!grab && !sgrab && hit && hit.screen && !onPanel(ray) && edge(pointer, 1)) startScreenGrab(pointer, hit, 'move', 1);
    }
    if (sgrab) {
      const s = L && L.screenGroup(sgrab.id), held = pressed(sgrab.h, sgrab.btn);   // trigger, grip, or a held pinch (hand tracking reports pinch as button 0)
      if (!s || !held) {
        sgrab.h.prev[sgrab.btn] = held;
        if (s && sgrab.mode === 'move') api.lastSnap = L.snapScreen(sgrab.id);
        if (s) L.save(); sgrab = null;
      } else if (sgrab.mode === 'move') {   // the hand carries it at the same distance; it stays upright and faces you
        gm.multiplyMatrices(sgrab.h.ctl.matrixWorld, sgrab.off); gm.decompose(spt, hq, gs);
        headPose(head); L.moveScreen(sgrab.id, spt.toArray(), Math.atan2(head.x - spt.x, head.z - spt.z));
      } else {   // resize: where the beam meets the screen's plane sets the corner (centre stays put)
        sgrab.h.ctl.getWorldPosition(ray.o); sgrab.h.ctl.getWorldQuaternion(ray.q); ray.d.set(0, 0, -1).applyQuaternion(ray.q);
        sn.set(0, 0, 1).applyQuaternion(s.quaternion); sp.setFromNormalAndCoplanarPoint(sn, s.position);
        tpRay.set(ray.o, ray.d);
        if (tpRay.ray.intersectPlane(sp, spt)) { const l = s.worldToLocal(spt.clone()); L.resizeScreen(sgrab.id, Math.max(2 * Math.abs(l.x), 2 * Math.abs(l.y) * sgrab.aspect), 2 * Math.abs(l.y)); }
      }
    }
    api.screenGrabbing = sgrab ? sgrab.mode : null;
    // grip on the panel: grab it and carry it; let go to leave it there
    if (pointer && panel.visible && !grab && edge(pointer, 1)) {
      pointer.ctl.getWorldPosition(ray.o); pointer.ctl.getWorldQuaternion(ray.q); ray.d.set(0, 0, -1).applyQuaternion(ray.q);
      tpRay.set(ray.o, ray.d); tpRay.far = 10;
      if (tpRay.intersectObject(panel, false).length) { grab = { h: pointer, off: pointer.ctl.matrixWorld.clone().invert().multiply(panel.matrixWorld) }; api.grabs++; }
    }
    if (grab) {
      if (!pressed(grab.h, 1) || !panel.visible) { grab.h.prev[1] = pressed(grab.h, 1); grab = null; }
      else {   // the hand carries the panel; it stays upright and turns to face you (no tilted or rolled screens)
        gm.multiplyMatrices(grab.h.ctl.matrixWorld, grab.off); gm.decompose(panel.position, panel.quaternion, gs);
        headPose(head); panel.lookAt(head.x, panel.position.y, head.z); panel.updateMatrixWorld(true);
      }
    }
    api.grabbing = !!grab;
    if (right && edge(right, 4)) setFocus(null);                 // A
    if (right && edge(right, 5) && api.focus) showPanel(!api.panel);   // B
    if (left && wristMesh.parent !== left.grip) left.grip.add(wristMesh);

    renderer.render(scene, camera);
    api.frames++; api.frameMs.push(performance.now() - t0); if (api.frameMs.length > 240) api.frameMs.shift();
  }

  // ------------------------------------------------------------------ Enter VR button (the only 2D UI)
  const btn = document.createElement('button');
  btn.id = 'omo-enter-vr'; btn.textContent = 'Enter VR';
  Object.assign(btn.style, { position: 'fixed', right: '24px', bottom: '24px', zIndex: '30', padding: '12px 20px', borderRadius: '999px', border: '0',
    background: '#7CF2D0', color: '#04110d', font: '600 15px Inter, system-ui, sans-serif', cursor: 'pointer', boxShadow: '0 8px 30px rgba(124,242,208,0.25)' });
  async function enterVR() {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'hand-tracking'] });
    await renderer.xr.setSession(session);
    btn.textContent = 'Exit VR';
    session.addEventListener('end', () => { btn.textContent = 'Enter VR'; });
  }
  btn.addEventListener('click', async () => {
    if (renderer.xr.isPresenting) { renderer.xr.getSession().end(); return; }
    await enterVR();
  });
  document.body.appendChild(btn);
  // Installed Quest app (immersive PWA): go straight into VR with no 2D landing page, as Meta's PWA guide asks. Tapping the
  // app icon counts as the user gesture. getDigitalGoodsService exists only inside the packaged app, so a normal browser
  // tab still waits for the Enter VR button.
  api.pwa = window.getDigitalGoodsService !== undefined;
  api.autoEnter = null;
  if (api.pwa) { api.autoEnter = 'requested'; enterVR().then(() => { api.autoEnter = 'ok'; }, (e) => { api.autoEnter = 'failed: ' + (e && e.message || e); }); }
  api.enter = () => btn.click();
  api.exit = () => renderer.xr.getSession()?.end();   // what the Quest system menu does
  api.toRig = (a) => dolly.worldToLocal(new THREE.Vector3(...a)).toArray();   // tests: world point -> headset reference space
  api.panelView = () => {   // where the panel sits in the viewer's eye: NDC x/y, distance, and whether it faces the viewer
    const cam = camera, c = panel.getWorldPosition(new THREE.Vector3()), e = new THREE.Vector3(); headPose(e);
    const ndc = c.clone().project(cam), n = new THREE.Vector3(0, 0, 1).applyQuaternion(panel.getWorldQuaternion(new THREE.Quaternion()));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(panel.getWorldQuaternion(new THREE.Quaternion()));
    return { upright: up.y, visible: panel.visible, ndc: [ndc.x, ndc.y, ndc.z], dist: c.distanceTo(e), facing: n.dot(e.clone().sub(c).normalize()), map: !!panel.material.map, eye: e.toArray(), at: c.toArray() };
  };
  api.vel = () => { const w = walker(); return w ? w.speed : 0; };
  api.speeds = () => { const w = walker(); return w ? [w.opts.walkSpeed, w.opts.sprintSpeed] : null; };
  api.feet = () => { const w = walker(); return w ? [w.position.x, w.position.y, w.position.z] : null; };
  api.eye = () => { const e = new THREE.Vector3(); headPose(e); return e.toArray(); };
  api.inputs = () => hands.map(h => ({ side: h.src && h.src.handedness, hand: !!(h.src && h.src.hand), ctlParent: h.ctl.parent && h.ctl.parent.name, ctlWorld: h.ctl.getWorldPosition(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)), ctlVisible: h.ctl.visible }));
  api.dollyPos = () => dolly.position.toArray();
  api.setFeet = (x, z, y) => { const w = walker(); if (w) w.setPose({ x, y: y ?? 0, z }); };   // tests: put the player at a known spot
  api.setRigYaw = (a) => { yaw = a; };
  api.panelSize = () => [PANEL_W, PANEL_W * 0.5769];
  api.rays = () => hands.map(h => { h.line.geometry.computeBoundingBox(); const b = h.line.geometry.boundingBox; return { mesh: !!h.line.isMesh, visible: h.line.visible, widthMm: +((b.max.x - b.min.x) * 1000).toFixed(1), len: +h.line.scale.z.toFixed(2) }; });
  api.addButtonWorld = () => { if (!addBtn.parent || !addBtn.parent.parent) return null; addBtn.updateWorldMatrix(true, false); return addBtn.getWorldPosition(new THREE.Vector3()).toArray(); };
  api.wristText = () => ({ ...wrist.info });   // tests: the hint on the left wrist and whether it fits its pill
  api.vignetteShown = () => vignette.visible && vignette.parent === camera && vigMat.uniforms.strength.value;
  return api;
}
