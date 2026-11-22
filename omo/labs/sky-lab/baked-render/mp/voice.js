// Omo sky proximity voice: a WebRTC audio mesh between the voice members of ONE room (fine up to ~8 people).
// Ported from Kaviru's omo/extension/src/browser/voice-controller.ts + voice-spatial.ts:
//  - the microphone is requested only from enable(), which the UI calls from a click ('Join voice');
//  - perfect negotiation per peer (larger member id = polite), pending-ICE queue, ICE restart on failure;
//  - every remote voice: MediaStreamSource -> gain (distance) -> PannerNode (HRTF, facing cone) -> master -> speakers;
//  - mute detaches the track from every sender (no RTP at all), deafen silences the master and mutes the mic.
// Audio goes peer to peer. STUN only learns IP addresses. The room server relays only bounded offer/answer/ice/bye.
import { proximityVolume, sourcePosition, facing, earPosition, VOICE_CONE, horizontalDistance } from './spatial.js';

export const STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
const SPEAK_THRESHOLD = 0.02, SPEAK_HOLD_MS = 700, MAX_PEERS = 7;
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const glide = (param, v, ctx) => { try { param.setTargetAtTime(v, ctx.currentTime, 0.05); } catch { param.value = v; } };

export class Voice {
  constructor({ send, others, selfId, poseOf, listener, onChange }) {
    Object.assign(this, { send, others, selfId, poseOf, listener, onChange });
    this.phase = 'off'; this.muted = false; this.deaf = false; this.level = 0; this.speaking = false; this.error = '';
    this.session = ''; this.peers = new Map(); this.loudAt = 0;
  }
  get transmitting() { return this.phase === 'on' && !this.muted && !this.deaf; }
  emit() { try { this.onChange && this.onChange(this); } catch (e) { console.error(e); } }

  /** Call ONLY from a click. */
  async enable() {
    if (this.phase === 'on' || this.phase === 'starting') return;
    this.phase = 'starting'; this.error = ''; this.emit();
    if (!window.isSecureContext || !navigator.mediaDevices) {   // e.g. a plain-http Tailscale address: browsers block the mic there
      this.phase = 'error'; this.error = 'This browser blocks the microphone on plain http addresses. Open the link via https (tailscale serve) or localhost.'; this.emit(); return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
    } catch (e) { this.phase = 'error'; this.error = 'Microphone not available: ' + (e && e.message || e); this.emit(); return; }
    this.ctx = this.ctx || new AudioContext({ latencyHint: 'interactive' });
    await this.ctx.resume().catch(() => {});
    this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
    this.master.gain.value = this.deaf ? 0 : 1;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512; src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.session = hex(8); this.phase = 'on';
    this.applyTrack(); this.publish(); this.reconcile(); this.emit();
  }
  disable() {
    for (const p of [...this.peers.values()]) this.closePeer(p, true);
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.analyser = null;
    if (this.master) { try { this.master.disconnect(); } catch {} this.master = null; }
    const was = this.phase === 'on'; this.phase = 'off'; this.session = ''; this.level = 0; this.speaking = false;
    if (was) this.send({ type: 'voice', status: null });
    this.emit();
  }
  setMuted(m) { this.muted = !!m; this.applyTrack(); this.publish(); this.emit(); }
  setDeaf(d) { this.deaf = !!d; if (this.master) glide(this.master.gain, this.deaf ? 0 : 1, this.ctx); this.applyTrack(); this.publish(); this.emit(); }
  publish() { if (this.phase === 'on') this.send({ type: 'voice', status: { session: this.session, muted: this.muted || this.deaf, deaf: this.deaf } }); }
  applyTrack() {
    const track = this.stream && this.stream.getAudioTracks()[0];
    if (track) track.enabled = this.transmitting;
    for (const p of this.peers.values()) this.syncSender(p);
  }
  syncSender(p) {
    if (!p.sender) return;
    const want = this.transmitting ? (this.stream && this.stream.getAudioTracks()[0]) || null : null;
    if (p.sender.track !== want) p.sender.replaceTrack(want).catch(() => {});
  }

  /** Room roster changed (join/leave/voice update): open or close links. */
  reconcile() {
    if (this.phase !== 'on') return;
    const want = new Map(this.others().filter(m => m.voice && m.voice.session).slice(0, MAX_PEERS).map(m => [m.id, m]));
    for (const p of [...this.peers.values()]) { const m = want.get(p.id); if (!m || m.voice.session !== p.session || p.pc.connectionState === 'closed') this.closePeer(p, false); }
    for (const m of want.values()) if (!this.peers.has(m.id)) this.makePeer(m);
  }
  makePeer(m) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN }], bundlePolicy: 'max-bundle' });
    const p = { id: m.id, session: m.voice.session, pc, polite: this.selfId() > m.id, makingOffer: false, ignoreOffer: false, settingRemoteAnswer: false, pendingIce: [], everConnected: false, gainValue: 0 };
    this.peers.set(m.id, p);
    p.log = []; const note = (t) => { p.log.push(Math.round(performance.now()) + ' ' + t); if (p.log.length > 40) p.log.shift(); }; p.note = note; note('make polite=' + p.polite);
    const live = () => this.peers.get(m.id) === p;
    const sig = (kind, data) => (note('send ' + kind), this.send)({ type: 'signal', to: p.id, toSession: p.session, session: this.session, kind, data });
    p.sig = sig;
    pc.onnegotiationneeded = async () => {
      if (!live() || pc.signalingState !== 'stable') return;
      // Only the impolite side (smaller member id) ever offers; the polite side only answers. Both sides open the link at the
      // same moment when they see each other's voice status, and the glare rollback that perfect negotiation would then do
      // leaves Chrome 156 with no ICE candidates on the polite side (link stuck at 'new'; seen in test-mp run 2) — and Kaviru
      // found the same rollback kills a live remote track. No glare, no rollback.
      if (p.polite) return;
      try { p.makingOffer = true; await pc.setLocalDescription(); if (live() && pc.localDescription.type === 'offer') sig('offer', pc.localDescription.sdp); }
      catch (e) { this.error = 'Voice link error: ' + e; this.emit(); } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = (e) => { if (e.candidate && live()) sig('ice', JSON.stringify(e.candidate.toJSON())); };
    pc.oniceconnectionstatechange = () => { if (live() && pc.iceConnectionState === 'failed' && !p.polite) { try { pc.restartIce(); } catch {} } };
    pc.onconnectionstatechange = () => { if (!live()) return; if (pc.connectionState === 'connected') p.everConnected = true; this.emit(); };
    pc.ontrack = (e) => {
      if (!live() || e.track.kind !== 'audio') return;
      if (p.audio && p.trackId === e.track.id) return;   // renegotiation re-fires ontrack for the same track: keep the live graph
      this.removeAudio(p); p.trackId = e.track.id;
      p.audio = this.addAudio(e.streams[0] || new MediaStream([e.track]));
    };
    const track = this.stream && this.stream.getAudioTracks()[0];
    if (track) { p.sender = pc.addTrack(track, this.stream); this.syncSender(p); } else pc.addTransceiver('audio', { direction: 'recvonly' });
    return p;
  }
  addAudio(stream) {
    // Chrome only feeds a remote WebRTC stream into Web Audio while a media element plays it.
    const holder = document.createElement('audio'); holder.muted = true; holder.srcObject = stream; holder.style.display = 'none';
    document.body.appendChild(holder); holder.play().catch(() => {});
    const source = this.ctx.createMediaStreamSource(stream), gain = this.ctx.createGain(), panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.rolloffFactor = 0;   // gain does distance
    panner.coneInnerAngle = VOICE_CONE.inner; panner.coneOuterAngle = VOICE_CONE.outer; panner.coneOuterGain = VOICE_CONE.outerGain;
    gain.gain.value = 0; source.connect(gain); gain.connect(panner); panner.connect(this.master);
    const meter = this.ctx.createAnalyser(); meter.fftSize = 256; gain.connect(meter);
    return { holder, source, gain, panner, meter };
  }
  removeAudio(p) {
    if (!p.audio) return; const a = p.audio; p.audio = null;
    try { a.source.disconnect(); a.gain.disconnect(); a.panner.disconnect(); } catch {}
    a.holder.srcObject = null; a.holder.remove();
  }
  closePeer(p, bye) {
    if (this.peers.get(p.id) === p) this.peers.delete(p.id);
    if (bye && this.session) try { p.sig('bye', ''); } catch {}
    this.removeAudio(p);
    p.pc.onnegotiationneeded = p.pc.onicecandidate = p.pc.ontrack = p.pc.onconnectionstatechange = p.pc.oniceconnectionstatechange = null;
    try { p.pc.close(); } catch {}
    this.emit();
  }

  async onSignal(s) {
    if (this.phase !== 'on') return;
    let p = this.peers.get(s.from);
    (this.sigLog = this.sigLog || []).push(Math.round(performance.now()) + ' recv ' + s.kind + ' from ' + s.from + ' peer=' + (p ? p.session === s.fromSession : 'none'));
    if (s.kind === 'bye') {
      if (p && p.session === s.fromSession) { this.closePeer(p, false); this.reconcile(); }
      return;
    }
    const m = this.others().find(x => x.id === s.from);
    if (!m || !m.voice || m.voice.session !== s.fromSession) { this.sigLog.push('  dropped: roster has ' + JSON.stringify(m && m.voice)); return; }
    if (p && p.session !== s.fromSession) { this.closePeer(p, false); p = null; }
    if (!p) p = this.makePeer(m);
    const pc = p.pc;
    try {
      if (s.kind === 'offer' || s.kind === 'answer') {
        const ready = !p.makingOffer && (pc.signalingState === 'stable' || p.settingRemoteAnswer);
        const collision = s.kind === 'offer' && !ready;
        p.ignoreOffer = !p.polite && collision; if (p.ignoreOffer) return;
        if (s.kind === 'answer' && pc.signalingState !== 'have-local-offer') return;
        p.settingRemoteAnswer = s.kind === 'answer';
        try { await pc.setRemoteDescription({ type: s.kind, sdp: s.data }); } finally { p.settingRemoteAnswer = false; }
        for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (s.kind === 'offer') { await pc.setLocalDescription(); if (this.peers.get(p.id) === p) p.sig('answer', pc.localDescription.sdp); }
        return;
      }
      let c; try { c = JSON.parse(s.data); } catch { return; }
      if (!c || typeof c.candidate !== 'string') return;
      if (!pc.remoteDescription) { if (p.pendingIce.length < 64) p.pendingIce.push(c); return; }
      await pc.addIceCandidate(c).catch(() => {});
    } catch (e) { this.error = 'Voice link error: ' + e; this.emit(); }
  }

  /** Per frame: mic level + speaking, listener pose, every peer's distance gain and 3D position. */
  tick() {
    if (this.phase !== 'on') return;
    let lv = 0;
    if (this.analyser) { this.analyser.getFloatTimeDomainData(this.buf); let s = 0; for (const v of this.buf) s += v * v; lv = Math.sqrt(s / this.buf.length); }
    this.level = this.transmitting ? lv : 0;
    if (this.level > SPEAK_THRESHOLD) this.loudAt = performance.now();
    this.speaking = this.transmitting && performance.now() - this.loudAt < SPEAK_HOLD_MS;
    const me = this.listener(), L = this.ctx.listener, e = earPosition(me), f = facing(me.yaw);
    if (L.positionX) { glide(L.positionX, e.x, this.ctx); glide(L.positionY, e.y, this.ctx); glide(L.positionZ, e.z, this.ctx); glide(L.forwardX, f.x, this.ctx); glide(L.forwardY, 0, this.ctx); glide(L.forwardZ, f.z, this.ctx); L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
    else { L.setPosition(e.x, e.y, e.z); L.setOrientation(f.x, 0, f.z, 0, 1, 0); }
    for (const p of this.peers.values()) {
      const pose = this.poseOf(p.id); if (!pose) continue;
      p.gainValue = proximityVolume(horizontalDistance(me, pose));
      if (!p.audio) continue;
      glide(p.audio.gain.gain, p.gainValue, this.ctx);
      const sp = sourcePosition(me, pose), sf = facing(pose.yaw), P = p.audio.panner;
      if (P.positionX) { glide(P.positionX, sp.x, this.ctx); glide(P.positionY, sp.y, this.ctx); glide(P.positionZ, sp.z, this.ctx); glide(P.orientationX, sf.x, this.ctx); glide(P.orientationY, 0, this.ctx); glide(P.orientationZ, sf.z, this.ctx); }
      else { P.setPosition(sp.x, sp.y, sp.z); P.setOrientation(sf.x, 0, sf.z); }
    }
  }
  gainFor(id) {
    const p = this.peers.get(id), me = this.listener(), pose = this.poseOf(id);
    return { computed: pose ? proximityVolume(horizontalDistance(me, pose)) : null, node: p && p.audio ? Math.round(p.audio.gain.gain.value * 1000) / 1000 : null, distance: pose ? Math.round(horizontalDistance(me, pose) * 100) / 100 : null };
  }
  debug() {
    return [...this.peers.values()].map(p => ({ id: p.id, polite: p.polite, signaling: p.pc.signalingState, ice: p.pc.iceConnectionState, gathering: p.pc.iceGatheringState, connection: p.pc.connectionState, pendingIce: p.pendingIce.length, hasRemote: !!p.pc.remoteDescription, everConnected: p.everConnected, log: (p.log || []).slice(-12) }));
  }
  async stats() {
    const out = [];
    for (const p of this.peers.values()) {
      let bytes = 0, packets = 0, energy = 0, sent = 0;
      try { (await p.pc.getStats()).forEach(s => { if (s.type === 'inbound-rtp' && s.kind === 'audio') { bytes += s.bytesReceived || 0; packets += s.packetsReceived || 0; energy += s.totalAudioEnergy || 0; } if (s.type === 'outbound-rtp' && s.kind === 'audio') sent += s.bytesSent || 0; }); } catch {}
      out.push({ id: p.id, connection: p.pc.connectionState, ice: p.pc.iceConnectionState, bytesReceived: bytes, packetsReceived: packets, audioEnergy: Math.round(energy * 1e6) / 1e6, bytesSent: sent, hasAudio: !!p.audio });
    }
    return out;
  }
}
