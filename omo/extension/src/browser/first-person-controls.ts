import * as THREE from 'three';
import { advancePlayer, PLAYER_HOME, PlayerPose } from '../common/player-state';
import type { RoomLayoutId } from '../common/player-state';
import type { SelectionUnit } from '../common/monitor-selection';

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
        on('pointerdown', event => {
            if (!this.enabled || event.button !== 0) return; event.stopImmediatePropagation(); canvas.focus();
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
            if (!this.pointer || this.typing || this.focusState.phase !== 'walk') return;
            if (Math.hypot(event.clientX-this.pointer.startX,event.clientY-this.pointer.startY)>4) this.pointer.dragged=true;
            if (this.pointer.dragged) {
                this.pose.yaw -= (event.clientX-this.pointer.x)*0.004;
                this.pose.pitch = Math.max(-1.2,Math.min(1.2,this.pose.pitch-(event.clientY-this.pointer.y)*0.004));
            }
            this.pointer.x=event.clientX;this.pointer.y=event.clientY;
        });
        on('pointerup', event => {
            if (!this.enabled) return; event.stopImmediatePropagation();
            if (this.selecting) { this.selecting = false; this.selection?.end(); return; }
            if (!this.pointer) return; const dragged=this.pointer.dragged;this.pointer=undefined;
            if (!dragged) {
                const hit=this.interact(event.clientX,event.clientY,{ctrlKey:event.ctrlKey,metaKey:event.metaKey});
                // A plain click frames the desk screen; Ctrl/Cmd-click stays a link click.
                if(hit==='terminal'&&!event.ctrlKey&&!event.metaKey&&this.attachRequest?.())return;
                if(hit==='terminal')this.focusTerminal();
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
                if(attached&&this.focusState.full){this.setFull(false);return;}
                this.selection?.clear();this.typing=false;this.keys.clear();
                if(attached){this.detach();return;}
                this.message('Walking · WASD to move. Drag to look. Click a monitor to use it.');return;
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
        const release=()=>{this.keys.clear();this.pointer=undefined;this.selecting=false;this.selection?.clear();};
        on('pointercancel', release);
        window.addEventListener('blur',release);canvas.addEventListener('blur',release);
        this.listeners.push(()=>{window.removeEventListener('blur',release);canvas.removeEventListener('blur',release);});
    }
    releaseTyping():void{this.selecting=false;this.selection?.clear();if(!this.typing)return;this.typing=false;this.keys.clear();this.apply();}
    focusTerminal():void {this.typing=true;this.keys.clear();this.canvas.focus({preventScroll:true});this.apply();this.message(this.attached?'Attached · Typing on this screen · Ctrl+Shift+F full screen · Esc to walk.':'Typing on the in-world monitor · Esc to walk away.');}
    setEnabled(enabled:boolean):void{this.enabled=enabled;this.keys.clear();this.typing=false;this.selecting=false;this.selection?.clear();this.dropFocus();if(enabled)this.apply();}
    get focus(): FocusState { return this.focusState; }
    get element(): HTMLCanvasElement { return this.canvas; }
    get attached(): boolean { return this.focusState.phase === 'attaching' || this.focusState.phase === 'attached'; }
    onFocusChange(listener: (state: FocusState) => void): () => void { this.focusListeners.add(listener); return () => this.focusListeners.delete(listener); }
    /** Fly the camera to frame a screen and lock the body. The walking pose is kept untouched for the way back. */
    attach(screen: FocusScreen, full = false): boolean {
        if (!this.enabled) return false;
        if (this.attached && this.focusState.screen?.id === screen.id) { if (full) this.setFull(true); this.focusTerminal(); return true; }
        this.keys.clear(); this.pointer = undefined;
        this.flight = { from: this.currentView(), start: performance.now() };
        this.setFocus({ phase: 'attaching', full, screen });
        this.focusTerminal();
        return true;
    }
    /** Ease back to the exact walking pose. */
    detach(): void {
        if (!this.attached) return;
        this.typing = false; this.keys.clear(); this.selection?.clear();
        this.flight = { from: this.currentView(), start: performance.now() };
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
        const xs: number[] = [], ys: number[] = [];
        // Right vector of a screen facing n is (n.z, 0, -n.x).
        for (const [dx, dy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
            const p = new THREE.Vector3(screen.center.x + dx*screen.width/2*screen.normal.z, screen.center.y + dy*screen.height/2, screen.center.z - dx*screen.width/2*screen.normal.x).project(this.camera);
            xs.push((p.x*.5 + .5)*w); ys.push((-p.y*.5 + .5)*h);
        }
        const left = Math.min(...xs), top = Math.min(...ys);
        return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
    }
    private setFocus(state: FocusState): void {
        this.focusState = state;
        this.canvas.dataset.focus = state.phase; this.canvas.dataset.focusFull = String(state.full); this.canvas.dataset.focusScreen = state.screen?.id ?? '';
        this.focusListeners.forEach(listener => listener(state));
    }
    private dropFocus(): void { this.flight = undefined; if (this.focusState.phase !== 'walk') this.setFocus({ phase: 'walk', full: false }); }
    private walkView(): View { return { x: this.pose.x, y: EYE_Y, z: this.pose.z, yaw: this.pose.yaw, pitch: this.pose.pitch }; }
    private currentView(): View { const p = this.camera.position, r = this.camera.rotation; return { x: p.x, y: p.y, z: p.z, yaw: r.y, pitch: r.x }; }
    /** Square-on, distance fitted to the live aspect so the screen fills ~90% of the view. */
    private screenView(screen: FocusScreen): View {
        const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov)/2);
        const distance = Math.max(screen.height/2/tan, screen.width/2/(tan*(this.camera.aspect || 1)))/FILL;
        // Looking along -normal; keep the turn short from the walking yaw.
        const facing = Math.atan2(screen.normal.x, screen.normal.z);
        return { x: screen.center.x + screen.normal.x*distance, y: screen.center.y, z: screen.center.z + screen.normal.z*distance, yaw: this.pose.yaw + wrapAngle(facing - this.pose.yaw), pitch: 0 };
    }
    step(seconds:number):void{
        if(!this.enabled)return;
        if(!this.typing&&this.focusState.phase==='walk')this.pose=advancePlayer(this.pose,{forward:Number(this.keys.has('w'))-Number(this.keys.has('s')),right:Number(this.keys.has('d'))-Number(this.keys.has('a'))},seconds,this.layout);
        this.apply();
    }
    private apply():void{
        const { phase, screen } = this.focusState;
        let view = (phase === 'attaching' || phase === 'attached') && screen ? this.screenView(screen) : this.walkView();
        if (this.flight) {
            const t = Math.min(1, (performance.now() - this.flight.start)/EASE_MS), e = ease(t), a = this.flight.from;
            view = { x: a.x + (view.x - a.x)*e, y: a.y + (view.y - a.y)*e, z: a.z + (view.z - a.z)*e, yaw: a.yaw + (view.yaw - a.yaw)*e, pitch: a.pitch + (view.pitch - a.pitch)*e };
            if (t >= 1) { this.flight = undefined; if (phase === 'attaching') this.setFocus({ ...this.focusState, phase: 'attached' }); else if (phase === 'returning') this.setFocus({ phase: 'walk', full: false }); }
        }
        this.camera.position.set(view.x,view.y,view.z);this.camera.rotation.order='YXZ';
        this.camera.rotation.set(view.pitch,view.yaw,0,'YXZ');
        this.canvas.dataset.playerX=this.pose.x.toFixed(3);this.canvas.dataset.playerZ=this.pose.z.toFixed(3);
        this.canvas.dataset.eyeY=String(+view.y.toFixed(3));this.canvas.dataset.typing=String(this.typing);
    }
    reset():void{this.selection?.clear();this.selecting=false;this.dropFocus();this.pose={...PLAYER_HOME};this.typing=false;this.keys.clear();this.apply();}
    dispose():void{this.listeners.forEach(dispose=>dispose());this.keys.clear();this.focusListeners.clear();}
}
