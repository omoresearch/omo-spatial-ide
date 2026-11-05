import * as THREE from 'three';
import { advancePlayer, PLAYER_HOME, PlayerPose } from '../common/player-state';
import type { RoomLayoutId } from '../common/player-state';
import type { SelectionUnit } from '../common/monitor-selection';
import { PointerLockLook, WalkVelocity } from './movement-smoothing';

export interface SelectionGestures {
    start(x: number, y: number, unit?: SelectionUnit): boolean;
    move(x: number, y: number): void;
    end(): void;
    clear(): void;
    copy(): void;
}
export type MonitorShortcut = 'new-shell' | 'select-tab-2' | 'workspace-picker';

/** Attach-to-screen focus. 'attaching'/'returning' are the eased camera flights. */
export type FocusPhase = 'walk' | 'attaching' | 'attached' | 'returning';
/** A flat, upright screen. normal is the horizontal direction the screen faces. */
export interface FocusScreen { id: string; center: { x: number; y: number; z: number }; normal: { x: number; z: number }; width: number; height: number }
export interface FocusState { phase: FocusPhase; full: boolean; screen?: FocusScreen }
export interface ScreenRect { left: number; top: number; width: number; height: number }
interface View { x: number; y: number; z: number; yaw: number; pitch: number }
const EYE_Y = 1.75, EASE_MS = 260, FILL = 0.9;
const ease = (t: number): number => t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2;
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const LOOK_SPEED = 0.004, LOCKED_LOOK_SPEED = 0.0024;
const POINTER_LOOK_KEY = 'omo.pointerLook';
const WALK_HINT = 'Walking · WASD to move. Drag to look. Click a monitor to use it.';
const readPointerLook = (): boolean => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(POINTER_LOOK_KEY) === '1'; } catch { return false; } };

export class FirstPersonControls {
    enabled = false;
    typing = false;
    pose: PlayerPose = { ...PLAYER_HOME };
    private keys = new Set<string>();
    private selecting = false;
    private selectionOrigin?: { x: number; y: number };
    private selectionDragged = false;
    private pointer?: { x: number; y: number; startX: number; startY: number; dragged: boolean };
    private listeners: Array<() => void> = [];
    private focusState: FocusState = { phase: 'walk', full: false };
    private flight?: { from: View; start: number };
    private focusListeners = new Set<(state: FocusState) => void>();
    /** Eased WASD velocity (fraction of walking speed, local frame). */
    private readonly velocity = new WalkVelocity();
    /** Reused per frame: the camera target view (no allocation in the hot path). */
    private readonly view: View = { x: 0, y: EYE_Y, z: 0, yaw: 0, pitch: 0 };
    /** Last values written to the canvas dataset (test/inspection data). Written only on change. */
    private written = { x: NaN, z: NaN, eye: NaN, typing: '' };
    /** Pointer-lock mouse look: opt-in (L while walking), remembered per browser. */
    private look?: PointerLockLook;
    private lookEnabled = readPointerLook();
    private crosshair?: HTMLDivElement;
    private readonly corner = new THREE.Vector3();
    /** Full-screen view copies its own (DOM) selection. Returns true when it handled the copy. */
    copyOverride?: () => boolean;
    /** Plain F while walking: ask focus mode to attach to the nearest monitor in full screen. */
    fullRequest?: () => void;
    /** A plain click chose a desk monitor: focus mode frames it. Returns true when it attached. */
    attachRequest?: () => boolean;
    constructor(private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera,
        private interact: (x: number, y: number, modifiers?: { ctrlKey: boolean; metaKey: boolean }) => 'terminal' | 'code' | undefined,
        private input: (text: string) => void, private message: (text: string) => void, private pasteText?: (text: string) => void,
        private selection?: SelectionGestures, private layout: RoomLayoutId = 'classic', private shortcut?: (shortcut: MonitorShortcut) => void) {
        const on = <K extends keyof HTMLElementEventMap>(name: K, fn: (event: HTMLElementEventMap[K]) => void): void => {
            const globalInput = name === 'keydown' || name === 'keyup' || name === 'paste';
            const target: EventTarget = globalInput ? window : canvas;
            const listener = (event: Event): void => {
                if (globalInput && event.target !== canvas && !(typeof document !== 'undefined' && document.activeElement === canvas)) return;
                fn(event as HTMLElementEventMap[K]);
            };
            // Theia handles document-capture shortcuts. Own only this canvas, but intercept
            // its input at window capture so Ctrl+C reaches the terminal before IDE Copy.
            target.addEventListener(name, listener, true); this.listeners.push(() => target.removeEventListener(name, listener, true));
        };
        this.look = new PointerLockLook(canvas, (dx, dy) => {
            // A locked click that turns the view noticeably is a look, not a monitor click.
            if (this.pointer && !this.pointer.dragged) { this.pointer.x += Math.abs(dx); this.pointer.y += Math.abs(dy); if (this.pointer.x - this.pointer.startX + this.pointer.y - this.pointer.startY > 6) this.pointer.dragged = true; }
            this.lookBy(dx, dy, LOCKED_LOOK_SPEED);
        }, locked => this.lockChanged(locked));
        canvas.dataset.pointerLook = String(this.lookEnabled);
        this.listeners.push(() => { this.look?.dispose(); this.look = undefined; this.crosshair?.remove(); this.crosshair = undefined; });
        on('pointerdown', event => {
            if (!this.enabled || event.button !== 0) return; event.stopImmediatePropagation(); canvas.focus();
            if (this.locked) {
                // Locked: the cursor is hidden; a click acts at the crosshair (canvas centre).
                const c = this.centre(); this.pointer = { x: c.x, y: c.y, startX: c.x, startY: c.y, dragged: false }; return;
            }
            if (event.shiftKey) {
                event.preventDefault();
                this.selectionOrigin = { x:event.clientX,y:event.clientY }; this.selectionDragged = false;
                this.pointer = undefined; this.keys.clear(); this.selecting = this.selection?.start(event.clientX, event.clientY) ?? false;
                if (this.selecting) { this.typing = true; this.apply(); canvas.setPointerCapture(event.pointerId); }
                return;
            }
            this.selection?.clear();
            this.pointer = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, dragged: false };
            canvas.setPointerCapture(event.pointerId);
        });
        on('pointermove', event => {
            if (!this.enabled) return; event.stopImmediatePropagation();
            if (this.selecting) {
                if (this.selectionOrigin && Math.hypot(event.clientX-this.selectionOrigin.x,event.clientY-this.selectionOrigin.y)>4) this.selectionDragged = true;
                this.selection?.move(event.clientX, event.clientY); return;
            }
            if (!this.pointer || this.locked || this.typing || this.focusState.phase !== 'walk') return;
            if (Math.hypot(event.clientX-this.pointer.startX,event.clientY-this.pointer.startY)>4) this.pointer.dragged=true;
            if (this.pointer.dragged) this.lookBy(event.clientX-this.pointer.x, event.clientY-this.pointer.y, LOOK_SPEED);
            this.pointer.x=event.clientX;this.pointer.y=event.clientY;
        });
        on('pointerup', event => {
            if (!this.enabled) return; event.stopImmediatePropagation();
            if (this.selecting) { this.selecting = false; this.selection?.end(); return; }
            if (!this.pointer) return; const {dragged,startX,startY}=this.pointer;this.pointer=undefined;
            if (!dragged) {
                const locked=this.locked, x=locked?startX:event.clientX, y=locked?startY:event.clientY;
                const hit=this.interact(x,y,{ctrlKey:event.ctrlKey,metaKey:event.metaKey});
                // A plain click frames the desk screen; Ctrl/Cmd-click stays a link click.
                if(hit==='terminal'&&!event.ctrlKey&&!event.metaKey&&this.attachRequest?.())return;
                if(hit==='terminal'){this.focusTerminal();return;}
                // Pointer look on: a click on open space captures the mouse (Esc releases it).
                if(!hit&&!locked&&this.lookEnabled&&!this.typing&&this.focusState.phase==='walk')this.look?.request();
            }
        });
        // Native click detail distinguishes the two explicit selection gestures.
        on('click', event => {
            if (!this.enabled || event.button !== 0 || !event.shiftKey || event.detail < 2 || this.selectionDragged) return;
            event.preventDefault(); event.stopImmediatePropagation(); this.keys.clear();
            if (this.selection?.start(event.clientX,event.clientY,event.detail === 2 ? 'word' : 'line')) {
                this.typing = true; this.canvas.focus(); this.apply(); this.selection.end();
            }
        });
        on('keydown', event => {
            if (!this.enabled) return;
            event.stopImmediatePropagation();
            if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'c') {
                event.preventDefault(); if (!this.copyOverride?.()) this.selection?.copy(); return;
            }
            const attached = this.attached;
            if (attached && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault(); this.setFull(!this.focusState.full); return;
            }
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
                event.preventDefault(); this.releaseTyping(); this.shortcut?.('new-shell'); return;
            }
            if (event.altKey && event.key === '2') {
                event.preventDefault(); this.releaseTyping(); this.shortcut?.('select-tab-2'); return;
            }
            if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
                event.preventDefault(); this.releaseTyping(); this.shortcut?.('workspace-picker'); return;
            }
            if(event.key==='Escape'){
                event.preventDefault();
                // Order: focus mode first (full screen, then attached), then pointer-lock release.
                if(attached&&this.focusState.full){this.setFull(false);return;}
                this.selection?.clear();this.typing=false;this.keys.clear();
                if(attached){this.detach();return;}
                if(this.locked){this.look?.exit();return;}
                this.message(this.walkHint());return;
            }
            if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
            if(this.typing){
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
                event.preventDefault();
                this.selection?.clear();
                const special:Record<string,string>={Enter:'\r',Backspace:'\x7f',Tab:'\t',ArrowUp:'\x1b[A',ArrowDown:'\x1b[B',ArrowRight:'\x1b[C',ArrowLeft:'\x1b[D',Home:'\x1b[H',End:'\x1b[F',Delete:'\x1b[3~'};
                if(event.ctrlKey&&event.key.length===1){const c=event.key.toLowerCase().charCodeAt(0);if(c>=97&&c<=122)this.input(String.fromCharCode(c-96));}
                else if(special[event.key])this.input(special[event.key]);
                else if(event.key.length===1&&!event.metaKey&&!event.altKey)this.input(event.key);
                return;
            }
            const key=event.key.toLowerCase();
            // Attached: the body is locked. F is the only free key (full screen).
            if(attached){if(key==='f'&&!event.ctrlKey&&!event.metaKey&&!event.altKey){event.preventDefault();this.setFull(!this.focusState.full);}return;}
            if(key==='f'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&this.fullRequest){event.preventDefault();this.keys.clear();this.fullRequest();return;}
            if(key==='l'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.repeat){event.preventDefault();this.setPointerLook(!this.lookEnabled);return;}
            if(['w','a','s','d'].includes(key)){event.preventDefault();this.keys.add(key);}
            if(event.key==='ArrowLeft'){event.preventDefault();this.pose.yaw+=0.07;}
            if(event.key==='ArrowRight'){event.preventDefault();this.pose.yaw-=0.07;}
            if(event.key==='ArrowUp'){event.preventDefault();this.pose.pitch=Math.min(1.2,this.pose.pitch+0.05);}
            if(event.key==='ArrowDown'){event.preventDefault();this.pose.pitch=Math.max(-1.2,this.pose.pitch-0.05);}
        });
        on('keyup',event=>{if(this.enabled)event.stopImmediatePropagation();this.keys.delete(event.key.toLowerCase());});
        on('paste',event=>{if(this.enabled&&this.typing){
            event.preventDefault();event.stopImmediatePropagation();const text=event.clipboardData?.getData('text/plain');
            if (!text) return;
            if (this.pasteText) { this.pasteText(text); return; }
            if (new TextEncoder().encode(text).length > 262144 || /[\u0000-\u001f\u007f]/.test(text)) { this.message('Paste one line at a time, without control characters (maximum 256 KiB). Press Enter yourself to run it.'); return; }
            this.input(text);
        }});
        const release=()=>{this.keys.clear();this.pointer=undefined;this.selecting=false;this.selection?.clear();this.look?.exit();};
        on('pointercancel', release);
        window.addEventListener('blur',release);canvas.addEventListener('blur',release);
        this.listeners.push(()=>{window.removeEventListener('blur',release);canvas.removeEventListener('blur',release);});
    }
    releaseTyping():void{this.selecting=false;this.selection?.clear();if(!this.typing)return;this.typing=false;this.keys.clear();this.apply();}
    focusTerminal():void {this.look?.exit();this.typing=true;this.keys.clear();this.velocity.stop();this.canvas.focus({preventScroll:true});this.apply();this.message(this.attached?'Attached · Typing on this screen · Ctrl+Shift+F full screen · Esc to walk.':'Typing on the in-world monitor · Esc to walk away.');}
    setEnabled(enabled:boolean):void{this.enabled=enabled;this.keys.clear();this.velocity.stop();this.typing=false;this.selecting=false;this.selection?.clear();this.look?.exit();this.dropFocus();if(enabled)this.apply();}
    /** Pointer-lock mouse look option. On: click open space to capture the mouse; Esc releases it. */
    get pointerLook(): boolean { return this.lookEnabled; }
    setPointerLook(on: boolean): void {
        this.lookEnabled = on;
        try { localStorage.setItem(POINTER_LOOK_KEY, on ? '1' : '0'); } catch { /* storage blocked: session only */ }
        this.canvas.dataset.pointerLook = String(on);
        if (!on) this.look?.exit();
        this.message(on ? 'Mouse look on · Click open space to look with the mouse · Esc releases it · L to turn off.' : 'Mouse look off · Drag to look · L to turn on.');
    }
    /** True while the mouse is captured for look. */
    get locked(): boolean { return !!this.look?.locked; }
    private walkHint(): string { return this.lookEnabled ? 'Walking · WASD to move. Click open space for mouse look. Click a monitor to use it.' : WALK_HINT; }
    private centre(): { x: number; y: number } { const r = this.canvas.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; }
    private lookBy(dx: number, dy: number, speed: number): void {
        if (!this.enabled || this.typing || this.focusState.phase !== 'walk') return;
        this.pose.yaw -= dx*speed;
        this.pose.pitch = Math.max(-1.2, Math.min(1.2, this.pose.pitch - dy*speed));
    }
    private lockChanged(locked: boolean): void {
        this.pointer = undefined;
        this.canvas.dataset.pointerLocked = String(locked);
        if (locked && !this.crosshair && this.canvas.parentElement) {
            const dot = document.createElement('div');
            dot.className = 'omo-crosshair'; dot.setAttribute('aria-hidden', 'true');
            Object.assign(dot.style, { position: 'absolute', left: '50%', top: '50%', width: '6px', height: '6px', margin: '-3px 0 0 -3px', borderRadius: '50%',
                background: '#f4efe3', boxShadow: '0 0 0 1px #0d141e99', pointerEvents: 'none', zIndex: '3' });
            this.canvas.parentElement.appendChild(dot); this.crosshair = dot;
        }
        if (this.crosshair) this.crosshair.style.display = locked ? 'block' : 'none';
        if (this.enabled) this.message(locked ? 'Mouse look · Move the mouse to look · Click a monitor to use it · Esc releases the mouse.' : this.walkHint());
    }
    get focus(): FocusState { return this.focusState; }
    get element(): HTMLCanvasElement { return this.canvas; }
    /** True while focus mode owns the camera (flying to, attached to, or returning from a screen). */
    get cameraOwned(): boolean { return !!this.flight || this.focusState.phase !== 'walk'; }
    /** True while WASD velocity is non-zero (keys held, or easing to a stop), so the loop keeps ticking. */
    get coasting(): boolean { return this.velocity.moving; }
    /** True while an eased camera flight is still running, so the render loop keeps drawing. */
    get flying(): boolean { return !!this.flight; }
    get attached(): boolean { return this.focusState.phase === 'attaching' || this.focusState.phase === 'attached'; }
    onFocusChange(listener: (state: FocusState) => void): () => void { this.focusListeners.add(listener); return () => this.focusListeners.delete(listener); }
    /** Fly the camera to frame a screen and lock the body. The walking pose is kept untouched for the way back. */
    attach(screen: FocusScreen, full = false): boolean {
        if (!this.enabled) return false;
        if (this.attached && this.focusState.screen?.id === screen.id) { if (full) this.setFull(true); this.focusTerminal(); return true; }
        this.keys.clear(); this.pointer = undefined;
        this.flight = { from: this.currentView(), start: performance.now() - (reducedMotion() ? EASE_MS : 0) };
        this.setFocus({ phase: 'attaching', full, screen });
        this.focusTerminal();
        return true;
    }
    /** Ease back to the exact walking pose. */
    detach(): void {
        if (!this.attached) return;
        this.typing = false; this.keys.clear(); this.selection?.clear();
        this.flight = { from: this.currentView(), start: performance.now() - (reducedMotion() ? EASE_MS : 0) };
        this.setFocus({ ...this.focusState, phase: 'returning', full: false });
        this.apply();
        this.message('Walking · WASD to move. Drag to look. Click a monitor to use it.');
    }
    setFull(full: boolean): void { if (this.attached && this.focusState.full !== full) this.setFocus({ ...this.focusState, full }); }
    /** The attached screen's on-canvas rectangle, in canvas CSS pixels. */
    screenRect(): ScreenRect | undefined {
        const screen = this.focusState.screen; if (!screen) return undefined;
        const { clientWidth: w, clientHeight: h } = this.canvas; if (!w || !h) return undefined;
        this.camera.updateMatrixWorld();
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        const p = this.corner;
        // Right vector of a screen facing n is (n.z, 0, -n.x). Corners: (-1,1) (1,1) (1,-1) (-1,-1).
        for (let i = 0; i < 4; i++) {
            const dx = i === 0 || i === 3 ? -1 : 1, dy = i < 2 ? 1 : -1;
            p.set(screen.center.x + dx*screen.width/2*screen.normal.z, screen.center.y + dy*screen.height/2, screen.center.z - dx*screen.width/2*screen.normal.x).project(this.camera);
            const x = (p.x*.5 + .5)*w, y = (-p.y*.5 + .5)*h;
            if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
        }
        return { left, top, width: right - left, height: bottom - top };
    }
    private setFocus(state: FocusState): void {
        if (state.phase !== 'walk') this.look?.exit();
        this.focusState = state;
        this.canvas.dataset.focus = state.phase; this.canvas.dataset.focusFull = String(state.full); this.canvas.dataset.focusScreen = state.screen?.id ?? '';
        this.focusListeners.forEach(listener => listener(state));
    }
    private dropFocus(): void { this.flight = undefined; if (this.focusState.phase !== 'walk') this.setFocus({ phase: 'walk', full: false }); }
    private walkView(out: View = this.view): View { out.x = this.pose.x; out.y = EYE_Y; out.z = this.pose.z; out.yaw = this.pose.yaw; out.pitch = this.pose.pitch; return out; }
    private currentView(): View { const p = this.camera.position, r = this.camera.rotation; return { x: p.x, y: p.y, z: p.z, yaw: r.y, pitch: r.x }; }
    /** Square-on, distance fitted to the live aspect so the screen fills ~90% of the view. */
    private screenView(screen: FocusScreen, out: View = this.view): View {
        const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov)/2);
        const distance = Math.max(screen.height/2/tan, screen.width/2/(tan*(this.camera.aspect || 1)))/FILL;
        // Looking along -normal; keep the turn short from the walking yaw.
        const facing = Math.atan2(screen.normal.x, screen.normal.z);
        out.x = screen.center.x + screen.normal.x*distance; out.y = screen.center.y; out.z = screen.center.z + screen.normal.z*distance;
        out.yaw = this.pose.yaw + wrapAngle(facing - this.pose.yaw); out.pitch = 0;
        return out;
    }
    step(seconds:number):void{
        if(!this.enabled)return;
        if(!this.typing&&this.focusState.phase==='walk'){
            const k=this.keys;
            const speed=this.velocity.step(Number(k.has('w'))-Number(k.has('s')),Number(k.has('d'))-Number(k.has('a')),seconds);
            // advancePlayer moves at full speed along the input direction; eased speed scales the time step.
            if(speed>0)this.pose=advancePlayer(this.pose,{forward:this.velocity.forward,right:this.velocity.right},seconds*Math.min(1,speed),this.layout);
        }else this.velocity.stop();
        this.apply();
    }
    private apply():void{
        const { phase, screen } = this.focusState;
        const view = (phase === 'attaching' || phase === 'attached') && screen ? this.screenView(screen) : this.walkView();
        if (this.flight) {
            const t = Math.min(1, (performance.now() - this.flight.start)/EASE_MS), e = ease(t), a = this.flight.from;
            view.x = a.x + (view.x - a.x)*e; view.y = a.y + (view.y - a.y)*e; view.z = a.z + (view.z - a.z)*e;
            view.yaw = a.yaw + (view.yaw - a.yaw)*e; view.pitch = a.pitch + (view.pitch - a.pitch)*e;
            if (t >= 1) { this.flight = undefined; if (phase === 'attaching') this.setFocus({ ...this.focusState, phase: 'attached' }); else if (phase === 'returning') this.setFocus({ phase: 'walk', full: false }); }
        }
        this.camera.position.set(view.x,view.y,view.z);
        this.camera.rotation.set(view.pitch,view.yaw,0,'YXZ');
        this.publish(view.y);
    }
    /** Test/inspection data on the canvas. Each attribute is written only when its shown value changes. */
    private publish(eyeY: number): void {
        const w = this.written, d = this.canvas.dataset;
        const x = Math.round(this.pose.x*1000), z = Math.round(this.pose.z*1000), eye = Math.round(eyeY*1000);
        if (x !== w.x) { w.x = x; d.playerX = (x/1000).toFixed(3); }
        if (z !== w.z) { w.z = z; d.playerZ = (z/1000).toFixed(3); }
        if (eye !== w.eye) { w.eye = eye; d.eyeY = String(eye/1000); }
        const typing = this.typing ? 'true' : 'false';
        if (typing !== w.typing) { w.typing = typing; d.typing = typing; }
    }
    reset():void{this.selection?.clear();this.selecting=false;this.dropFocus();this.pose={...PLAYER_HOME};this.typing=false;this.keys.clear();this.velocity.stop();this.apply();}
    dispose():void{this.listeners.forEach(dispose=>dispose());this.keys.clear();this.focusListeners.clear();}
}
