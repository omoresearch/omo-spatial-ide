// Omo sky multiplayer: link-share join, avatars, Discord-style proximity voice, text chat. Hooked from index.html by ONE
// line marked `// mp:hook`. Talks only to mp/server.cjs (/mp/ws). It never reads, sends or shows terminal contents:
// the multiplayer channel carries names, poses, voice status, WebRTC signalling and chat lines, nothing else.
//
//  Host : open the live page with  ?live=<token>&mp=<mp host:port>#mphost=<host-key>   (node mp/host.cjs prints it)
//         -> 'Share' opens the invite popover and copies  http://<mp host:port>/?room=<id>#invite=<signed>
//  Guest: open the share link -> type a display name -> in the room. Desk screens show a 'Host's desk' placeholder.
//  Keys : M mute (tap toggles, hold = push-to-mute) · Enter chat · Esc close chat / popover.
// Look and feel come from ui/ui.js + ui/ui.css (the shared design system, loaded by the ui:hook line).
import * as THREE from 'three';
import { Voice } from './voice.js';
import { h, icon, kbd, toast as uiToast, tooltip, popover, qrSvg, shell, settings, tokens, esc } from '../ui/ui.js';

const SEND_HZ = 15, INTERP_DELAY_MS = 110, EYE = 1.65;
const HEAD_TOP = 1.72;          // avatar head top (head centre 1.56 + radius 0.15) -> name tags sit just above it
const TAG_H = 26;               // name tag height in CSS px (fixed on screen at any distance)
const C = tokens.color;
const wrapYaw = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const lerpAngle = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };

function config() {
  const q = new URLSearchParams(location.search), hs = new URLSearchParams(location.hash.slice(1));
  let changed = false;
  if (q.get('mp') && hs.get('mphost')) { sessionStorage.setItem('omo-mp-host', JSON.stringify({ server: q.get('mp'), key: hs.get('mphost') })); q.delete('mp'); hs.delete('mphost'); changed = true; }
  if (q.get('room') && hs.get('invite')) { sessionStorage.setItem('omo-mp-invite:' + q.get('room'), hs.get('invite')); hs.delete('invite'); changed = true; }
  if (changed) history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + (hs.toString() ? '#' + hs : ''));
  const host = JSON.parse(sessionStorage.getItem('omo-mp-host') || 'null');
  if (host) return { role: 'host', server: host.server, cred: { host: host.key } };
  const room = q.get('room');
  if (!room || !/^[0-9a-f]{8}$/.test(room)) return null;
  const member = sessionStorage.getItem('omo-mp-member:' + room), invite = sessionStorage.getItem('omo-mp-invite:' + room);
  return { role: 'guest', server: location.host, room, cred: member ? { member } : invite ? { invite } : null };
}
// The invite token is `v1.<base64url json>.<mac>`; its payload carries the real expiry (exp, ms) and the one-use flag.
function inviteInfo(link) {
  try {
    const tok = new URL(link).hash.replace(/^#invite=/, ''), body = tok.split('.')[1];
    const p = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    return { exp: Number(p.exp) || 0, one: !!p.one };
  } catch { return { exp: 0, one: false }; }
}
function expiryText(exp) {
  if (!exp) return 'Expires after a while';
  const ms = exp - Date.now(); if (ms <= 0) return 'Expired';
  const hrs = ms / 3600e3, d = new Date(exp);
  const when = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (d.toDateString() === new Date().toDateString() ? ' today' : d.toDateString() === new Date(Date.now() + 864e5).toDateString() ? ' tomorrow' : ' ' + d.toLocaleDateString([], { weekday: 'short' }));
  return `Expires in ${hrs >= 1.5 ? Math.round(hrs) + ' hours' : Math.max(1, Math.round(ms / 60e3)) + ' min'} · ${when}`;
}

export async function attachMp({ scene, camera, renderer, root, walker, draw }) {
  const cfg = config();
  if (!cfg) return;   // not a multiplayer page (capture harness, plain live page)
  const S = { ws: null, self: null, members: new Map(), avatars: new Map(), chat: [], link: '', status: 'joining', error: '', frames: { sent: 0, recv: 0 }, poseRecv: 0, rtt: 0 };
  // a screen-reader live region that always holds the latest notice (tests read it as #omo-mp-toast)
  const toastEl = h('div', { id: 'omo-mp-toast', class: 'omo-sr', role: 'status', 'aria-live': 'polite' }); document.body.append(toastEl);
  const toast = (t, opts) => { toastEl.textContent = t; uiToast(t, opts); };
  const freezeWalker = () => shell.freezeWalker();
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2();
  const rayAt = (x, y) => { const r = renderer.domElement.getBoundingClientRect(); v2.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); ray.setFromCamera(v2, camera); ray.far = 200; };

  // ------------------------------------------------------------------------------------------ guest: desks are the host's
  if (cfg.role === 'guest') {
    const c = document.createElement('canvas'); c.width = 1600; c.height = 928; const g = c.getContext('2d');
    g.fillStyle = '#0d0e12'; g.fillRect(0, 0, c.width, c.height);
    const vg = g.createRadialGradient(800, 420, 40, 800, 420, 900); vg.addColorStop(0, 'rgba(61,220,151,0.07)'); vg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = vg; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.beginPath(); g.roundRect(720, 250, 160, 160, 40); g.fill();
    g.strokeStyle = C.text2; g.lineWidth = 12; g.lineCap = 'round'; g.lineJoin = 'round';   // lock glyph (same shape as the UI lock icon)
    g.beginPath(); g.roundRect(752, 326, 96, 62, 12); g.stroke(); g.beginPath(); g.moveTo(772, 326); g.lineTo(772, 304); g.arc(800, 304, 28, Math.PI, 0); g.lineTo(828, 326); g.stroke();
    g.textAlign = 'center'; g.fillStyle = C.text; g.font = `650 84px ${tokens.font}`; g.fillText("Host's desk", 800, 560);
    g.fillStyle = C.text3; g.font = `500 42px ${tokens.font}`; g.fillText('Only the host can use this screen', 800, 636);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    S.screens = [];
    root.traverse(o => { if (o.isMesh && o.material && o.material.isMeshBasicMaterial && o.material.map && o.material.map.isCanvasTexture) S.screens.push(o); });
    for (const s of S.screens) s.material = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(0.9, 0.9, 0.9) });
    const deskAt = (x, y) => { rayAt(x, y); const hit = ray.intersectObjects([root], true)[0]; return hit && S.screens.includes(hit.object) ? hit : null; };
    renderer.domElement.addEventListener('mousedown', (e) => {
      if (deskAt(e.clientX, e.clientY)) { S.deskClicks = (S.deskClicks || 0) + 1; toast("This is the host's desk. Only the host can use it.", { iconName: 'lock' }); }
    }, true);
    shell.addAim((x, y) => { const hit = deskAt(x, y); return hit ? { kind: 'desk', label: "Host's desk", sub: 'View only', locked: true, dist: hit.distance } : null; });
  }

  // ------------------------------------------------------------------------------------------ avatars, name tags, speaking ring
  const bodyGeo = new THREE.CapsuleGeometry(0.2, 0.74, 6, 20), headGeo = new THREE.SphereGeometry(0.15, 28, 18);
  const visorGeo = new THREE.CapsuleGeometry(0.045, 0.13, 4, 12); visorGeo.rotateZ(Math.PI / 2);
  const ringGeo = new THREE.RingGeometry(0.36, 0.43, 72); ringGeo.rotateX(-Math.PI / 2);
  const glowGeo = new THREE.PlaneGeometry(1.5, 1.5); glowGeo.rotateX(-Math.PI / 2);
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); const gr = g.createRadialGradient(128, 128, 40, 128, 128, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.42, 'rgba(255,255,255,0.0)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const ACCENT_HDR = new THREE.Color(C.accent).multiplyScalar(2.4);   // HDR so it survives tone mapping and blooms
  const overlay = shell.overlay || scene;                               // name tags: crisp pass without tone mapping / bloom
  const tagDpr = () => Math.max(2, Math.ceil(devicePixelRatio || 1));
  const micOffPath = new Path2D('M2 2l20 20M18.89 13.23A7.12 7.12 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.34V5a3 3 0 0 0-5.68-1.33M9 9v3a3 3 0 0 0 5.12 2.12M12 19v3');
  function nameTag(m, speaking) {
    const dpr = tagDpr(), muted = !!(m.voice && m.voice.muted), host = m.role === 'host';
    const c = document.createElement('canvas'), g = c.getContext('2d');
    const font = `600 ${13 * dpr}px ${tokens.font}`, small = `650 ${10 * dpr}px ${tokens.font}`;
    g.font = font; const nameW = Math.min(180 * dpr, g.measureText(m.name).width);
    g.font = small; const hostW = host ? g.measureText('HOST').width + 10 * dpr : 0;
    const padL = 10 * dpr, dot = 8 * dpr, gap = 7 * dpr, micW = muted ? 16 * dpr + gap : 0, padR = 11 * dpr;
    const W = Math.ceil(padL + dot + gap + nameW + (host ? gap + hostW : 0) + micW + padR), H = TAG_H * dpr, PAD = 3 * dpr;
    c.width = W + PAD * 2; c.height = H + PAD * 2; g.translate(PAD, PAD);
    g.fillStyle = 'rgba(17,18,23,0.86)'; g.beginPath(); g.roundRect(0, 0, W, H, H / 2); g.fill();
    g.lineWidth = speaking ? 2 * dpr : 1 * dpr; g.strokeStyle = speaking ? C.accent : 'rgba(255,255,255,0.12)';
    g.beginPath(); g.roundRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth, (H - g.lineWidth) / 2); g.stroke();
    let x = padL;
    g.fillStyle = m.colour; g.beginPath(); g.arc(x + dot / 2, H / 2, dot / 2, 0, 7); g.fill(); x += dot + gap;
    g.font = font; g.fillStyle = C.text; g.textBaseline = 'middle'; g.fillText(m.name, x, H / 2 + 0.5 * dpr, nameW); x += nameW;
    if (host) { x += gap; g.fillStyle = C.accentSoft; g.beginPath(); g.roundRect(x, H / 2 - 8 * dpr, hostW, 16 * dpr, 8 * dpr); g.fill(); g.font = small; g.fillStyle = C.accent; g.fillText('HOST', x + 5 * dpr, H / 2 + 0.5 * dpr); x += hostW; }
    if (muted) { x += gap; g.save(); g.translate(x, H / 2 - 8 * dpr); g.scale(16 * dpr / 24, 16 * dpr / 24); g.strokeStyle = C.danger; g.lineWidth = 2.4; g.lineCap = 'round'; g.lineJoin = 'round'; g.stroke(micOffPath); g.restore(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.generateMipmaps = false;
    t.userData = { cssW: c.width / dpr, cssH: c.height / dpr };
    return t;
  }
  function makeAvatar(m) {
    const col = new THREE.Color(m.colour);
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.42, metalness: 0.05, emissive: col.clone().multiplyScalar(0.22), envMapIntensity: 0.9 });
    const g = new THREE.Group(); g.name = 'omo-mp-avatar';
    const body = new THREE.Mesh(bodyGeo, mat); body.position.y = 0.2 + 0.37 + 0.01; g.add(body);
    const head = new THREE.Group(); head.position.y = 1.56; g.add(head);
    head.add(new THREE.Mesh(headGeo, mat));
    const visor = new THREE.Mesh(visorGeo, new THREE.MeshStandardMaterial({ color: 0x0d1016, roughness: 0.15, metalness: 0.3, envMapIntensity: 1.2 })); visor.position.set(0, 0.02, -0.125); head.add(visor);
    // speaking ring: a bright, pulsing ring on the floor at the avatar's feet (+ a soft halo); opacity follows the mic level
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: ACCENT_HDR, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    ring.position.y = 0.018; ring.renderOrder = 30; g.add(ring);
    const halo = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ map: glowTex, color: ACCENT_HDR, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.position.y = 0.012; halo.renderOrder = 29; g.add(halo);
    // name tag: 2x-DPR canvas sprite, constant pixel size (sizeAttenuation false), bottom-anchored just above the head
    const tex = nameTag(m, false);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, sizeAttenuation: false }));
    tag.center.set(0.5, 0); tag.renderOrder = 31; tag.visible = false; overlay.add(tag);
    g.visible = false; scene.add(g);
    return { g, head, ring, halo, tag, mat, buf: [], shown: null, ringLevel: 0, occluded: false, occT: 0, tagKey: tagKeyOf(m, false) };
  }
  let occList = null;
  const occluders = () => {
    if (occList) return occList;
    occList = []; const bb = new THREE.Box3(), c = new THREE.Vector3();
    root.updateMatrixWorld(true);
    root.traverse(o => { if (!o.isMesh || o.visible === false || o.isInstancedMesh) return; bb.setFromObject(o); if (bb.isEmpty()) return; bb.getCenter(c); const size = bb.getSize(new THREE.Vector3()); if (c.length() < 40 && Math.max(size.x, size.y, size.z) < 60) occList.push(o); });
    return occList;
  };
  const tagKeyOf = (m, sp) => [m.name, m.role, m.voice && m.voice.muted ? 1 : 0, sp ? 1 : 0, m.colour].join('|');
  function dropAvatar(id) { const a = S.avatars.get(id); if (!a) return; scene.remove(a.g); overlay.remove(a.tag); a.tag.material.map.dispose(); a.tag.material.dispose(); a.ring.material.dispose(); a.halo.material.dispose(); a.mat.dispose(); S.avatars.delete(id); }
  function pushPose(id, p) {
    const a = S.avatars.get(id); if (!a || !p) return;
    a.buf.push({ t: performance.now(), p }); if (a.buf.length > 30) a.buf.shift();
    if (!a.shown) a.shown = { ...p };
  }
  function sampled(a, now) {   // render INTERP_DELAY_MS in the past, between the two samples around that time
    const t = now - INTERP_DELAY_MS, b = a.buf; if (!b.length) return null;
    if (t <= b[0].t) return b[0].p;
    for (let i = b.length - 1; i >= 0; i--) if (b[i].t <= t) {
      const A = b[i], B = b[i + 1]; if (!B) return A.p;   // no newer sample yet: hold (no extrapolation jitter)
      const u = (t - A.t) / Math.max(1, B.t - A.t);
      return { x: A.p.x + (B.p.x - A.p.x) * u, y: A.p.y + (B.p.y - A.p.y) * u, z: A.p.z + (B.p.z - A.p.z) * u, yaw: lerpAngle(A.p.yaw, B.p.yaw, u), pitch: A.p.pitch + (B.p.pitch - A.p.pitch) * u, lv: A.p.lv + (B.p.lv - A.p.lv) * u };
    }
    return b[b.length - 1].p;
  }

  // ------------------------------------------------------------------------------------------ voice
  const myPose = () => ({ x: camera.position.x, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x });
  const voice = new Voice({
    send: (o) => send(o),
    others: () => [...S.members.values()],
    selfId: () => (S.self ? S.self.id : ''),
    poseOf: (id) => { const a = S.avatars.get(id); return a && a.shown ? a.shown : null; },
    listener: myPose,
    onChange: () => render(),
  });

  // ------------------------------------------------------------------------------------------ people + voice dock (top right)
  const ui = h('div', { id: 'omo-mp', class: 'omo-root omo-dock is-hidden' });
  const card = h('div', { class: 'omo-dock__card omo-panel' }); ui.append(card); document.body.append(ui);
  const title = h('span', {}, 'In this room'), count = h('span', { class: 'omo-num' });
  const shareBtn = h('button', { class: 'omo-btn omo-btn--primary omo-btn--sm', id: 'omo-mp-share', html: icon('userPlus', 14) + '<span>Share</span>', 'aria-haspopup': 'dialog' });
  tooltip(shareBtn, 'Invite someone with a link');
  const hd = h('div', { class: 'omo-dock__hd' }, h('div', { class: 'omo-dock__title' }, title, count));
  if (cfg.role === 'host') hd.append(shareBtn);
  card.append(hd);
  const ppl = h('div', { class: 'omo-people', id: 'omo-mp-people', role: 'list' }); card.append(ppl);
  const voiceBox = h('div', { class: 'omo-dock__voice' });
  const st = h('div', { class: 'omo-vstat__txt', id: 'omo-mp-status' });
  const meter = h('span', { class: 'omo-meter', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i'));
  const joinBtn = h('button', { class: 'omo-btn omo-btn--primary', id: 'omo-mp-voice' });
  const muteBtn = h('button', { class: 'omo-btn', id: 'omo-mp-mute', 'aria-pressed': 'false' });
  const deafBtn = h('button', { class: 'omo-btn', id: 'omo-mp-deafen', 'aria-pressed': 'false' });
  const leaveBtn = h('button', { class: 'omo-btn omo-btn--danger', id: 'omo-mp-leave', html: icon('hangup', 18), 'aria-label': 'Leave voice' });
  tooltip(muteBtn, 'Mute', 'M'); tooltip(deafBtn, 'Deafen'); tooltip(leaveBtn, 'Leave voice');
  voiceBox.append(h('div', { class: 'omo-vstat' }, st), h('div', { class: 'omo-vbtns' }, joinBtn, muteBtn, deafBtn, leaveBtn));
  card.append(voiceBox);
  joinBtn.onclick = () => voice.enable();
  muteBtn.onclick = () => voice.setMuted(!voice.muted);
  deafBtn.onclick = () => voice.setDeaf(!voice.deaf);
  leaveBtn.onclick = () => voice.disable();

  // ------------------------------------------------------------------------------------------ share popover (host)
  const linkIn = h('input', { id: 'omo-mp-link', class: 'omo-input omo-input--mono', readOnly: true, spellcheck: false, 'aria-label': 'Invite link', placeholder: 'Making a link…' });
  const copyBtn = h('button', { class: 'omo-btn omo-share__copy', id: 'omo-mp-copy' });
  const oneUse = h('input', { type: 'checkbox', class: 'omo-switch', id: 'omo-mp-oneuse', 'aria-label': 'One-use link' });
  const qrBox = h('div', { class: 'omo-qr is-busy', id: 'omo-mp-qr', role: 'img', 'aria-label': 'QR code of the invite link' });
  const expEl = h('span', { id: 'omo-mp-expiry' }), subEl = h('p', { class: 'omo-share__sub' });
  const closeShare = tooltip(h('button', { class: 'omo-btn omo-btn--ghost omo-btn--icon omo-btn--sm', html: icon('x', 16) }), 'Close', 'Esc');
  const shareBody = h('div', {},
    h('div', { class: 'omo-pop__hd' }, h('div', { class: 'omo-pop__title' }, 'Invite to this room'), closeShare),
    subEl,
    h('div', { class: 'omo-pop__bd' },
      h('div', { class: 'omo-share__link' }, linkIn, copyBtn),
      h('div', { class: 'omo-share__body' }, qrBox,
        h('div', { class: 'omo-share__opts' },
          h('label', { class: 'omo-share__toggle', for: 'omo-mp-oneuse' }, h('span', {}, 'One-use link'), oneUse),
          h('div', { class: 'omo-share__hint' }, 'Stops working after one person joins.'),
          h('div', { class: 'omo-share__meta' },
            h('span', { html: icon('clock', 14) }, expEl),
            h('span', { html: icon('shield', 14) }, 'Room and voice only. No terminals.'))))));
  const sharePop = popover(shareBtn, shareBody, { width: 368, className: 'omo-share', position: (el) => { const r = card.getBoundingClientRect(); return { x: r.left - 368 - 8, y: r.top }; },
    onOpen: () => { if (!S.link || inviteInfo(S.link).one !== oneUse.checked) mint(); else paintShare(); } });
  sharePop.el.id = 'omo-mp-sharepop';
  closeShare.onclick = () => sharePop.close();
  let linkWaiter = null, copyT = 0, minting = false;
  const setCopy = (done) => {
    clearTimeout(copyT); copyBtn.classList.toggle('is-done', done);
    copyBtn.innerHTML = done ? icon('check', 14) + '<span>Copied</span>' : icon('copy', 14) + '<span>Copy</span>';
    if (done) copyT = setTimeout(() => setCopy(false), 1800);
  };
  setCopy(false);
  function paintShare() {
    const info = inviteInfo(S.link);
    linkIn.value = S.link;
    subEl.textContent = info.one ? 'Works for one person. Anyone you send it to can join with a name.' : 'Anyone with the link can join with a name.';
    expEl.textContent = S.link ? expiryText(info.exp) : 'Making a link…';
    if (S.link) { qrBox.innerHTML = qrSvg(S.link, { ecc: 'L', margin: 0, dark: '#0b0c10' }); qrBox.classList.remove('is-busy'); }
  }
  function mint() { if (minting) return; minting = true; qrBox.classList.add('is-busy'); send({ type: 'invite', id: 'inv' + Date.now().toString(36), oneUse: oneUse.checked }); }
  async function copyLink(link) {
    try { await navigator.clipboard.writeText(link); S.copied = link; setCopy(true); return true; }
    catch { linkIn.focus(); linkIn.select(); return false; }
  }
  shareBtn.onclick = () => sharePop.toggle();
  copyBtn.onclick = () => { if (S.link) copyLink(S.link); };
  oneUse.addEventListener('change', () => mint());
  linkIn.addEventListener('focus', () => linkIn.select());

  // ------------------------------------------------------------------------------------------ dock render
  const speakingIds = new Set();
  function person(m) {
    const speaking = m.self ? voice.speaking : speakingIds.has(m.id);
    const av = h('div', { class: 'omo-av' + (speaking ? ' sp' : ''), style: { background: m.colour } }, (m.name[0] || '?').toUpperCase());
    if (m.voice && (m.voice.muted || m.voice.deaf)) av.append(h('span', { class: 'omo-av__badge', html: icon(m.voice.deaf ? 'headphonesOff' : 'micOff', 10, 2.6), 'aria-label': m.voice.deaf ? 'Deafened' : 'Muted' }));
    const nm = h('div', { class: 'nm' }, h('span', { class: 'nm__t' }, m.name));
    if (m.role === 'host') nm.append(h('span', { class: 'omo-pill omo-pill--accent' }, 'Host'));
    if (m.self) nm.append(h('span', { class: 'omo-pill' }, 'You'));
    const meta = h('div', { class: 'meta' });
    if (m.voice) {
      if (m.voice.deaf) meta.append(h('span', { class: 'is-red' }, 'Deafened'));
      else if (m.voice.muted) meta.append(h('span', { class: 'is-red' }, 'Muted'));
      else if (speaking) meta.append(h('span', { style: { color: C.accent } }, 'Speaking'));
      if (!m.self && voice.phase === 'on' && !m.voice.deaf) { const gi = voice.gainFor(m.id); if (gi.distance !== null) meta.append(h('span', { 'data-tip': gi.computed > 0 ? `Volume ${Math.round(gi.computed * 100)}%` : 'Too far to hear' }, `${gi.distance.toFixed(1)} m`)); }
    } else meta.append(h('span', {}, m.self ? 'Not in voice' : 'No voice'));
    return h('div', { class: 'omo-person row', role: 'listitem', 'data-id': m.id, 'data-speaking': speaking ? '1' : '0' }, h('div', { class: 'omo-person__main' }, av, nm, meta));
  }
  function render() {
    const all = S.self ? [{ ...S.self, voice: voice.phase === 'on' ? { muted: voice.muted || voice.deaf, deaf: voice.deaf } : null, self: true }, ...S.members.values()] : [];
    count.textContent = S.status === 'joined' ? String(all.length) : S.status === 'joining' ? 'Joining…' : 'Offline';
    ppl.replaceChildren(...all.map(person));
    const on = voice.phase === 'on';
    st.replaceChildren();
    if (on) {
      st.append(h('span', { class: 'g' }, voice.deaf ? 'Deafened' : voice.muted ? 'Muted' : 'Voice connected', meter));
      const sm = h('small', {}); if (voice.deaf) sm.append('You hear no one and send nothing'); else if (voice.muted) sm.append('Press ', kbd('M'), ' to unmute'); else sm.append('People near you hear you · ', kbd('M'), ' mute'); st.append(sm);
      st.querySelector('.g').style.color = voice.deaf || voice.muted ? C.danger : C.accent;
    } else {
      const err = voice.phase === 'error' || S.error;
      st.append(h('span', { class: 'o', style: err ? { color: C.danger } : {} }, voice.phase === 'starting' ? 'Asking for your microphone…' : voice.phase === 'error' ? 'Voice is off' : S.error ? 'Not connected' : 'Not in voice'),
        h('small', { title: voice.error || S.error || '' }, voice.error || S.error || 'Talk to people near you, like in real life'));
    }
    joinBtn.style.display = on ? 'none' : ''; joinBtn.disabled = voice.phase === 'starting' || S.status !== 'joined';
    joinBtn.innerHTML = icon('mic', 16) + `<span>${voice.phase === 'starting' ? 'Connecting…' : 'Join voice'}</span>`;
    for (const b of [muteBtn, deafBtn, leaveBtn]) b.style.display = on ? '' : 'none';
    const micOff = voice.muted || voice.deaf;
    muteBtn.innerHTML = icon(micOff ? 'micOff' : 'mic', 16) + `<span>${micOff ? 'Muted' : 'Mic on'}</span>`; muteBtn.classList.toggle('is-off', micOff); muteBtn.setAttribute('aria-pressed', String(voice.muted));
    muteBtn.dataset.tip = voice.muted ? 'Unmute' : 'Mute';
    deafBtn.innerHTML = icon(voice.deaf ? 'headphonesOff' : 'headphones', 16) + `<span>${voice.deaf ? 'Deafened' : 'Sound on'}</span>`; deafBtn.classList.toggle('is-off', voice.deaf); deafBtn.setAttribute('aria-pressed', String(voice.deaf));
    deafBtn.dataset.tip = voice.deaf ? 'Undeafen' : 'Deafen';
    shell.setRoom({ name: 'Penthouse', count: Math.max(1, all.length), live: S.status === 'joined', quality: S.status !== 'joined' ? 0 : !S.rtt ? 3 : S.rtt < 150 ? 3 : S.rtt < 400 ? 2 : 1, rtt: S.rtt });
  }

  // ------------------------------------------------------------------------------------------ chat (Enter)
  const chatBox = h('div', { id: 'omo-mp-chat', class: 'omo-root omo-chat is-idle' });
  const chatLog = h('div', { class: 'omo-chat__log', role: 'log', 'aria-live': 'polite' });
  const chatIn = h('input', { id: 'omo-mp-chat-input', maxLength: 300, placeholder: 'Message the room', autocomplete: 'off', spellcheck: false, 'aria-label': 'Chat message' });
  const chatBar = h('div', { class: 'omo-chat__bar omo-panel is-closed' }, h('span', { class: 'omo-chat__ic', html: icon('chat', 16) }), chatIn, h('span', { class: 'omo-chat__keys' }, kbd('Enter'), ' send'));
  const chip = h('div', { class: 'omo-chat__chip' }, kbd('Enter'), 'Chat');
  chatBox.append(chatLog, chatBar, chip); document.body.append(chatBox);
  const hhmm = (t) => new Date(t || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function addChat(msg) {
    S.chat.push(msg); if (S.chat.length > 50) S.chat.shift();
    const line = h('div', { class: 'msg' }, h('time', {}, hhmm(msg.at)), h('b', { style: { color: msg.colour } }, msg.name), msg.text);
    chatLog.append(line); while (chatLog.children.length > 6) chatLog.firstChild.remove();
    chatBox.classList.remove('is-idle');
    setTimeout(() => { if (chatBar.classList.contains('is-closed')) line.style.opacity = '0'; }, 12000);
  }
  const openChat = () => { freezeWalker(); chatBar.classList.remove('is-closed'); chatBox.classList.add('is-open'); chatBox.classList.remove('is-idle'); for (const m of chatLog.children) m.style.opacity = '1'; setTimeout(() => chatIn.focus(), 0); };
  const closeChat = () => { chatIn.value = ''; chatBar.classList.add('is-closed'); chatBox.classList.remove('is-open'); chatIn.blur(); };
  const typingElsewhere = (e) => (window.__live && window.__live.focus && window.__live.focus()) || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
  let mDownAt = 0, mWasMuted = false;
  addEventListener('keydown', (e) => {
    const mine = e.target && e.target.closest && e.target.closest('#omo-mp-chat,#omo-mp-join,#omo-mp,#omo-mp-sharepop');
    if (mine && e.target.tagName === 'INPUT') {   // our own text fields: keys never reach the walker
      e.stopPropagation();
      if (e.target === chatIn) {
        if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
        else if (e.key === 'Enter') { e.preventDefault(); const t = chatIn.value.trim(); if (t) send({ type: 'chat', text: t }); closeChat(); }
      }
      return;
    }
    if (typingElsewhere(e) || S.status !== 'joined') return;
    if (e.key === 'Enter' && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); e.stopPropagation(); openChat(); return; }
    if (e.code === 'KeyM' && !e.repeat && voice.phase === 'on') { mDownAt = performance.now(); mWasMuted = voice.muted; voice.setMuted(!voice.muted); }
  }, true);
  addEventListener('keyup', (e) => {
    if (e.code === 'KeyM' && mDownAt && voice.phase === 'on') { if (performance.now() - mDownAt > 450) voice.setMuted(mWasMuted); mDownAt = 0; }   // held = push-to-mute
  }, true);

  // ------------------------------------------------------------------------------------------ lobby + socket
  function askName(why) {
    return new Promise((res) => {
      const lb = shell.lobby({ role: cfg.role, hostName: null, name: localStorage.getItem('omo-mp-name') || '', joinVoice: settings.get('joinVoice'),
        onSubmit: (n, o) => { localStorage.setItem('omo-mp-name', n); lb.wrap.remove(); res({ name: n, joinVoice: o.joinVoice }); } });
      if (why) lb.setError(why);
    });
  }
  function send(o) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); S.frames.sent++; } }
  let name = null, retry = 0, pingAt = 0;
  function connect() {
    const secure = location.protocol === 'https:' || /^https:\/\//.test(cfg.server) || /\.ts\.net(:\d+)?$/.test(cfg.server);
    const ws = new WebSocket(`${secure ? 'wss' : 'ws'}://${cfg.server.replace(/^https?:\/\//, '')}/mp/ws`); S.ws = ws; S.status = 'joining'; render();
    ws.onopen = () => send({ type: 'hello', name, ...cfg.cred });
    ws.onmessage = (e) => { S.frames.recv++; let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = (e) => {
      if (S.ws !== ws) return;
      const wasJoined = S.status === 'joined'; S.status = 'offline';
      for (const id of [...S.avatars.keys()]) dropAvatar(id); S.members.clear(); voice.reconcile(); render();
      if (e.code === 4001 || e.code === 4030 || e.code === 4009) { if (cfg.role === 'guest' && cfg.cred && cfg.cred.member) sessionStorage.removeItem('omo-mp-member:' + cfg.room); return; }
      setTimeout(connect, Math.min(8000, 800 * 2 ** retry++)); if (wasJoined) toast('Connection lost. Reconnecting…', { kind: 'error' });
    };
  }
  const av = (m) => ({ colour: m.colour, letter: (m.name || '?')[0] });
  function onMessage(m) {
    switch (m.type) {
      case 'welcome': {
        retry = 0; S.status = 'joined'; S.error = ''; S.self = m.self;
        if (m.memberToken && cfg.role === 'guest') { sessionStorage.setItem('omo-mp-member:' + m.room, m.memberToken); sessionStorage.removeItem('omo-mp-invite:' + m.room); cfg.cred = { member: m.memberToken }; }
        for (const x of m.members) { S.members.set(x.id, x); if (!S.avatars.has(x.id)) S.avatars.set(x.id, makeAvatar(x)); pushPose(x.id, x.p); }
        for (const c of m.chat || []) addChat(c);
        if (voice.phase === 'on') voice.publish();
        ui.classList.remove('is-hidden');
        voice.reconcile(); render(); return;
      }
      case 'join': S.members.set(m.member.id, m.member); if (!S.avatars.has(m.member.id)) S.avatars.set(m.member.id, makeAvatar(m.member)); pushPose(m.member.id, m.member.p); voice.reconcile(); render(); toast(`${m.member.name} joined`, { avatar: av(m.member) }); return;
      case 'leave': { const x = S.members.get(m.id); S.members.delete(m.id); dropAvatar(m.id); speakingIds.delete(m.id); voice.reconcile(); render(); if (x) toast(`${x.name} left`, { avatar: av(x) }); return; }
      case 'update': { if (S.self && m.member.id === S.self.id) return; const x = S.members.get(m.member.id); if (!x) return; Object.assign(x, { name: m.member.name, colour: m.member.colour, voice: m.member.voice }); voice.reconcile(); render(); return; }
      case 'pose': { const x = S.members.get(m.id); if (!x) return; x.p = m.p; S.poseRecv++; pushPose(m.id, m.p); return; }
      case 'signal': voice.onSignal(m); return;
      case 'chat': addChat(m.message); return;
      case 'pong': if (pingAt) { S.rtt = Math.round(performance.now() - pingAt); pingAt = 0; render(); } return;
      case 'invite': {
        minting = false; S.link = m.link; paintShare();
        copyLink(m.link).then(() => { if (linkWaiter) { linkWaiter(m.link); linkWaiter = null; } });
        return;
      }
      case 'error':
        minting = false;
        if (m.code === 'auth') { S.error = m.error; render(); }
        if (m.code !== 'rate') toast(m.error, { kind: 'error' });
        return;
    }
  }
  setInterval(() => { if (S.status === 'joined' && !pingAt) { pingAt = performance.now(); send({ type: 'ping', id: 'p' + Date.now().toString(36) }); } else if (pingAt && performance.now() - pingAt > 8000) pingAt = 0; }, 5000);

  // ------------------------------------------------------------------------------------------ per frame + 15 Hz pose
  const prev = scene.onBeforeRender;
  const anchor = new THREE.Vector3(), toCam = new THREE.Vector3();
  scene.onBeforeRender = (...a) => {
    if (prev) prev(...a);
    const now = performance.now();
    const k = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(1, renderer.domElement.clientHeight || innerHeight);   // view units per CSS px at depth 1
    const pulse = 0.5 + 0.5 * Math.sin(now / 1000 * Math.PI * 2 * 1.6);
    for (const [id, av] of S.avatars) {
      const m = S.members.get(id), p = sampled(av, now);
      av.g.visible = !!p; av.tag.visible = !!p;
      if (!p) continue;
      av.shown = p;
      av.g.position.set(p.x, Math.max(0, p.y), p.z); av.g.rotation.y = p.yaw; av.head.rotation.x = Math.max(-0.5, Math.min(0.5, p.pitch));
      const lv = Math.min(1, (p.lv || 0) * 6);
      av.ringLevel += ((lv > 0.08 ? lv : 0) - av.ringLevel) * 0.35;
      const on = Math.min(1, av.ringLevel * 1.6);
      av.ring.material.opacity = Math.min(0.98, on * (0.75 + 0.25 * pulse)); av.ring.scale.setScalar(1 + av.ringLevel * 0.22 + on * pulse * 0.06);
      av.halo.material.opacity = Math.min(0.9, on * (0.55 + 0.45 * pulse)); av.halo.scale.setScalar(1 + av.ringLevel * 0.3);
      const sp = av.ringLevel > 0.06; if (sp !== speakingIds.has(id)) { if (sp) speakingIds.add(id); else speakingIds.delete(id); render(); }
      // name tag: fixed pixel size, bottom edge just above the head; hidden when a wall is between it and the camera
      anchor.set(p.x, Math.max(0, p.y) + HEAD_TOP + 0.04, p.z); av.tag.position.copy(anchor);
      const t = av.tag.material.map.userData; av.tag.scale.set(t.cssW * k, t.cssH * k, 1);
      if (now - av.occT > 250) {
        av.occT = now; toCam.copy(anchor).sub(camera.position); const d = toCam.length();
        ray.set(camera.position, toCam.normalize()); ray.far = Math.max(0, d - 0.35);
        av.occluded = d > 0.6 && ray.intersectObjects(occluders(), false).some(hh => hh.object.visible !== false && !(hh.object.material && hh.object.material.transparent && hh.object.material.opacity < 0.5));
        av.dist = d;
      }
      av.tag.material.opacity += ((av.occluded ? 0 : av.dist > 14 ? 0.6 : 1) - av.tag.material.opacity) * 0.25;
      const key = m ? tagKeyOf(m, sp) : ''; if (m && key !== av.tagKey) { av.tagKey = key; av.tag.material.map.dispose(); av.tag.material.map = nameTag(m, sp); av.tag.material.needsUpdate = true; }
    }
    voice.tick();
    if (voice.phase === 'on') { const lvl = voice.transmitting ? Math.min(1, voice.level * 9) : 0; [...meter.children].forEach((b, i) => { const on = lvl > (i + 0.5) / 5; b.style.height = (4 + (on ? 2 + i * 2 : 0)) + 'px'; b.style.opacity = on ? '1' : '0.35'; }); }
  };
  let lastSent = '', lastAt = 0, lastSpeak = false;
  setInterval(() => {
    if (S.status !== 'joined') return;
    const p = { x: camera.position.x, y: camera.position.y - EYE, z: camera.position.z, yaw: wrapYaw(camera.rotation.y), pitch: Math.max(-1.55, Math.min(1.55, camera.rotation.x)), lv: voice.transmitting ? Math.min(1, voice.level) : 0 };
    const key = [p.x, p.y, p.z, p.yaw, p.pitch].map(v => v.toFixed(3)).join() + (p.lv > 0.004 ? '|' + p.lv.toFixed(2) : '');
    if (key === lastSent && performance.now() - lastAt < 1000) return;
    lastSent = key; lastAt = performance.now(); send({ type: 'pose', p });
    if (voice.speaking !== lastSpeak) { lastSpeak = voice.speaking; render(); }
  }, 1000 / SEND_HZ);
  setInterval(() => { if (voice.phase === 'on') render(); }, 500);

  // ------------------------------------------------------------------------------------------ test/debug surface (no secrets)
  const project = (v) => { const c = v.clone().project(camera), r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height, inFront: c.z < 1 }; };
  window.__mp = {
    role: cfg.role,
    status: () => S.status,
    self: () => S.self,
    members: () => [...S.members.values()].map(m => ({ id: m.id, name: m.name, colour: m.colour, role: m.role, voice: m.voice })),
    avatar: (id) => { const a = S.avatars.get(id); if (!a) return null; const head = new THREE.Vector3(); a.head.getWorldPosition(head); return { visible: a.g.visible, x: a.g.position.x, y: a.g.position.y, z: a.g.position.z, yaw: a.g.rotation.y, ring: a.ring.material.opacity, tagFacesCamera: a.tag.isSprite, tag: { px: [Math.round(a.tag.material.map.userData.cssW), Math.round(a.tag.material.map.userData.cssH)], canvas: [a.tag.material.map.image.width, a.tag.material.map.image.height], sizeAttenuation: a.tag.material.sizeAttenuation, opacity: Math.round(a.tag.material.opacity * 100) / 100, screen: project(a.tag.position) }, screen: project(head) }; },
    avatarByName: (n) => { const m = [...S.members.values()].find(x => x.name === n); return m ? window.__mp.avatar(m.id) : null; },
    link: () => S.link, copied: () => S.copied || '',
    requestLink: (one = false) => new Promise(res => { linkWaiter = res; oneUse.checked = one; if (!sharePop.isOpen) sharePop.open(); if (!minting && (!S.link || inviteInfo(S.link).one !== one)) mint(); else if (!minting) { linkWaiter(S.link); linkWaiter = null; } }),
    voice: () => ({ phase: voice.phase, muted: voice.muted, deaf: voice.deaf, speaking: voice.speaking, level: Math.round(voice.level * 1000) / 1000, transmitting: voice.transmitting, error: voice.error }),
    voiceStats: () => voice.stats(),
    voiceDebug: () => ({ peers: voice.debug(), sig: (voice.sigLog || []).slice(-20) }),
    gainFor: (id) => voice.gainFor(id),
    speaking: () => [...speakingIds],
    chat: () => S.chat.map(c => ({ name: c.name, text: c.text })),
    desks: () => ({ placeholder: cfg.role === 'guest' ? (S.screens || []).length : 0, clicks: S.deskClicks || 0 }),
    deskPoint: (i) => { const s = (S.screens || [])[i]; if (!s) return null; s.geometry.computeBoundingBox(); return project(s.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(s.matrixWorld)); },
    frames: () => ({ ...S.frames, poseRecv: S.poseRecv }),
  };
  render();
  (async () => {
    if (cfg.role === 'guest' && !cfg.cred) { S.error = 'This link has no invite in it. Ask the host for a new share link.'; S.status = 'offline'; ui.classList.remove('is-hidden'); render(); toast(S.error, { kind: 'error' }); return; }
    const r = await askName(''); name = r.name; connect();
    if (r.joinVoice) voice.enable();
  })();
  if (draw) draw();
}
export { esc };
