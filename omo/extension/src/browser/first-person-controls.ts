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
    constructor(private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera,
        private interact: (x: number, y: number) => 'terminal' | 'code' | undefined,
        private input: (text: string) => void, private message: (text: string) => void, private pasteText?: (text: string) => void,
        private selection?: SelectionGestures, private layout: RoomLayoutId = 'classic') {
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
            if (!this.pointer || this.typing) return;
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
                const hit=this.interact(event.clientX,event.clientY);
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
                event.preventDefault(); this.selection?.copy(); return;
            }
            if(event.key==='Escape'){event.preventDefault();this.selection?.clear();this.typing=false;this.keys.clear();this.message('Walking · WASD to move. Drag to look. Click a monitor to use it.');return;}
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
    focusTerminal():void {this.typing=true;this.keys.clear();this.canvas.focus();this.apply();this.message('Typing on the in-world monitor · Esc to walk away.');}
    setEnabled(enabled:boolean):void{this.enabled=enabled;this.keys.clear();this.typing=false;this.selecting=false;this.selection?.clear();if(enabled)this.apply();}
    step(seconds:number):void{
        if(!this.enabled)return;
        if(!this.typing)this.pose=advancePlayer(this.pose,{forward:Number(this.keys.has('w'))-Number(this.keys.has('s')),right:Number(this.keys.has('d'))-Number(this.keys.has('a'))},seconds,this.layout);
        this.apply();
    }
    private apply():void{
        this.camera.position.set(this.pose.x,1.75,this.pose.z);this.camera.rotation.order='YXZ';
        this.camera.rotation.set(this.pose.pitch,this.pose.yaw,0,'YXZ');
        this.canvas.dataset.playerX=this.pose.x.toFixed(3);this.canvas.dataset.playerZ=this.pose.z.toFixed(3);
        this.canvas.dataset.eyeY='1.75';this.canvas.dataset.typing=String(this.typing);
    }
    reset():void{this.selection?.clear();this.selecting=false;this.pose={...PLAYER_HOME};this.typing=false;this.keys.clear();this.apply();}
    dispose():void{this.listeners.forEach(dispose=>dispose());this.keys.clear();}
}
