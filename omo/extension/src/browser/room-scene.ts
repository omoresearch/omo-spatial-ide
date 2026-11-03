import * as THREE from 'three';
import type { RoomState, RoomTheme } from '../common/room-state';
import { FirstPersonControls } from './first-person-controls';

export type Workstation = 'terminal' | 'code';
export interface RoomSceneOptions {
    theme: RoomTheme;
    camera: RoomState['camera'];
    onSelect: (station: Workstation) => void;
    onCameraChange: (camera: RoomState['camera']) => void;
    onReady: () => void;
    walk?: boolean;
    onInput: (text: string) => void;
    onMessage: (text: string) => void;
    onError: (message: string) => void;
}

/** Original, asset-free scene. The IDE remains the authority for all real work. */
export class RoomScene {
    private renderer!: THREE.WebGLRenderer;
    private scene = new THREE.Scene();
    private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 150);
    private state: RoomState['camera'];
    private frame = 0;
    private observer?: ResizeObserver;
    private disposed = false;
    private roots: THREE.Object3D[] = [];
    private labels: HTMLButtonElement[] = [];
    private walker?: FirstPersonControls;
    private navigation: 'walk' | 'overview' = 'overview';
    private lastFrame = performance.now();
    private terminalSurface?: HTMLCanvasElement;
    private terminalTexture?: THREE.CanvasTexture;
    private terminalLines: string[] = [];
    private pointer?: { x: number; y: number; startX: number; startY: number; dragged: boolean };
    private cleanup: Array<() => void> = [];
    constructor(private host: HTMLElement, private options: RoomSceneOptions) {
        this.state = { ...options.camera };
        try { this.init(); } catch (error) {
            options.onError(error instanceof Error ? error.message : String(error));
            this.dispose();
        }
    }
    private init(): void {
        const jungle = this.options.theme === 'jungle';
        this.scene.background = new THREE.Color(jungle ? '#101c1a' : '#101622');
        this.scene.fog = new THREE.Fog(jungle ? '#101c1a' : '#101622', 33, 65);
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.25;
        const canvas = this.renderer.domElement;
        canvas.dataset.testid = 'omo-world-canvas';
        canvas.setAttribute('aria-label', 'Interactive 3D room. Drag or use arrow keys to orbit. Scroll to zoom. Select a workstation to work.');
        canvas.tabIndex = 0;
        this.host.appendChild(canvas);
        this.scene.add(new THREE.HemisphereLight(jungle ? 0xd9f3d5 : 0xc7e6ff, 0x283136, 2.3));
        const sun = new THREE.DirectionalLight(jungle ? 0xffe8b8 : 0xffecd1, 4);
        sun.position.set(-5, 12, 8); sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 40 });
        sun.shadow.bias = -0.001; sun.shadow.normalBias = 0.025;
        this.scene.add(sun);
        const accent = new THREE.PointLight(jungle ? 0xc3ff9b : 0x70c9ff, 25, 18);
        accent.position.set(0, 4, -2); this.scene.add(accent);
        this.buildRoom(jungle);
        this.bindControls(canvas);
        this.walker = new FirstPersonControls(canvas, this.camera, (x,y)=>this.interactAt(x,y), text=>this.options.onInput(text), text=>this.options.onMessage(text));
        this.setNavigation(this.options.walk ? 'walk' : 'overview');
        this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.host);
        this.resize(); this.positionCamera(); this.draw(); this.options.onReady();
    }
    private material(color: THREE.ColorRepresentation, metalness = 0.1): THREE.MeshStandardMaterial {
        return new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness });
    }
    private box(parent: THREE.Object3D, dimensions: number[], at: number[], color: THREE.ColorRepresentation, metalness = 0.1): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions as [number, number, number]), this.material(color, metalness));
        mesh.position.set(...at as [number, number, number]); mesh.castShadow = true; mesh.receiveShadow = true;
        parent.add(mesh); return mesh;
    }
    private cylinder(parent: THREE.Object3D, radius: number, height: number, at: number[], color: THREE.ColorRepresentation, radiusBottom = radius, segments = 24): THREE.Mesh {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radiusBottom, height, segments), this.material(color));
        mesh.position.set(...at as [number, number, number]); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
    }
    private glow(parent: THREE.Object3D, dimensions: number[], at: number[], color: number): THREE.Mesh {
        const mesh = this.box(parent, dimensions, at, color);
        (mesh.material as THREE.MeshStandardMaterial).emissive.set(color);
        (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.5;
        return mesh;
    }
    private buildRoom(jungle: boolean): void {
        const root = new THREE.Group(); this.scene.add(root);
        this.box(root, [13, 0.55, 10], [0, -0.42, 0], jungle ? 0x34453a : 0x303c50);
        this.box(root, [12.6, 0.12, 9.6], [0, -0.08, 0], jungle ? 0x76907b : 0x647889);
        const grid = new THREE.GridHelper(12, 12, jungle ? 0x91a98b : 0x8b9fac, jungle ? 0x718b76 : 0x718391);
        grid.position.set(0, 0.005, 0); (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.24; root.add(grid);
        // Cutaway architecture preserves legibility and keeps the workstations visible.
        this.box(root, [12.7, 3.4, 0.22], [0, 1.65, -4.65], jungle ? 0x526b59 : 0x28374b);
        this.box(root, [0.22, 2, 8.8], [-6.25, 0.95, -0.3], jungle ? 0x526b59 : 0x34475b);
        this.glow(root, [11.8, 0.055, 0.06], [0, 3.16, -4.49], jungle ? 0xc6e5a7 : 0x77deef);
        this.box(root, [7.4, 2.1, 0.08], [0.1, 1.8, -4.49], jungle ? 0x284c41 : 0x101c32);
        if (jungle) {
            for (let i = 0; i < 7; i++) this.tree(root, -5.1 + i * 1.67, -4.1, 1 + (i % 3) * 0.3);
            this.box(root, [3, 0.04, 2.8], [3.7, 0.02, 2.8], 0x2f7775);
            for (let i = 0; i < 5; i++) {
                this.cylinder(root, 0.28, 0.1, [2.4 + i * 0.55, 0.1, 2.4 + Math.sin(i) * 0.35], 0xbac1a4, 0.35, 7);
            }
            this.tree(root, -5, 2.6, 1.2); this.tree(root, 5.25, -0.7, 1.35);
            this.fern(root, -4.5, 3.6); this.fern(root, 5.1, 3.9); this.fern(root, 0.1, -3.6);
        } else {
            const globe = new THREE.Mesh(new THREE.SphereGeometry(0.9, 48, 32), this.material(0x568eb1, 0.5));
            globe.position.set(0.8, 2, -4.2); globe.scale.z = 0.22; root.add(globe);
            const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.025, 12, 64), this.material(0x8ce3ec));
            ring.position.set(0.8, 2, -4.1); ring.rotation.z = -0.4; root.add(ring);
            for (let i = 0; i < 24; i++) {
                const star = new THREE.Mesh(new THREE.SphereGeometry(0.018 + (i % 3) * 0.007, 6, 6), new THREE.MeshBasicMaterial({ color: 0xb1d9f7 }));
                star.position.set(-3.2 + ((i * 37) % 67) / 10, 0.9 + ((i * 13) % 19) / 10, -4.38); root.add(star);
            }
            for (const x of [-5.7, 5.7]) {
                this.box(root, [0.32, 3.6, 0.5], [x, 1.75, -4.1], 0x728896);
                this.glow(root, [0.065, 2.7, 0.07], [x, 1.8, -3.8], 0x98dce9);
            }
            this.plant(root, -5, 2.9); this.plant(root, 5.2, 2.8);
            this.box(root, [2.5, 0.5, 1], [-3.5, 0.25, -3.5], 0xa39c8c);
            this.box(root, [2.5, 0.65, 0.3], [-3.5, 0.65, -3.85], 0xa39c8c);
        }
        this.desk(root, -2.65, 0.5, 'terminal', jungle);
        this.desk(root, 2.25, -0.45, 'code', jungle);
        this.cylinder(root, 0.7, 0.15, [0.2, 0.06, 3], jungle ? 0xb9ba91 : 0x8398a5, 0.75);
        const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 0), this.material(jungle ? 0xd6e7a4 : 0x7cdae2, 0.6));
        core.position.set(0.2, 0.65, 3); root.add(core);
        const landing = new THREE.Mesh(new THREE.PlaneGeometry(130, 130), this.material(jungle ? 0x101c1a : 0x101622));
        landing.rotation.x = -Math.PI / 2; landing.position.y = -1.05; landing.receiveShadow = true; this.scene.add(landing);
    }
    private desk(parent: THREE.Object3D, x: number, z: number, action: Workstation, jungle: boolean): void {
        const group = new THREE.Group(); group.position.set(x, 0, z); group.userData.workstation = action; parent.add(group); this.roots.push(group);
        this.box(group, [3.2, 0.15, 1.55], [0, 1.15, 0], jungle ? 0xc0aa7b : 0xd2c9b5);
        for (const leg of [-1.28, 1.28]) this.box(group, [0.13, 1.1, 1.25], [leg, 0.54, 0], jungle ? 0x394e42 : 0x374656);
        this.box(group, [0.65, 0.06, 0.48], [0, 1.26, -0.25], 0x293645);
        this.box(group, [0.1, 0.35, 0.1], [0, 1.43, -0.35], 0x435664);
        this.box(group, [1.72, 1.04, 0.11], [0, 1.99, -0.36], 0x17222e);
        const texture = this.screenTexture(action);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 0.9), new THREE.MeshBasicMaterial({map:texture}));
        screen.position.set(0, 1.99, -0.296); group.add(screen);
        this.box(group, [0.9, 0.045, 0.3], [-0.15, 1.26, 0.28], 0x344353);
        for(let i=0;i<3;i++) this.box(group,[0.72,0.008,0.012],[-0.15,1.285,0.2+i*0.075],0x71808c);
        this.cylinder(group, 0.11, 0.25, [1.15, 1.32, 0.3], jungle ? 0xd3d3a8 : 0xc9a478);
        this.glow(group, [0.3, 0.025, 0.025], [-0.6, 1.42, -0.265], action === 'terminal' ? 0x9adbc6 : 0x9ebce9);
        // Chair and footrest. These are navigation landmarks, not pretend agents.
        this.cylinder(group, 0.15, 0.5, [0, 0.3, 1.35], 0x374656);
        this.box(group, [0.9, 0.16, 0.85], [0, 0.62, 1.35], jungle ? 0x758968 : 0x648697);
        this.box(group, [0.9, 0.85, 0.14], [0, 1.03, 1.72], jungle ? 0x758968 : 0x648697);
        const label = document.createElement('button'); label.className = 'omo-scene-label'; label.dataset.workstation = action;
        label.textContent = action === 'terminal' ? '01  Terminal ↗' : '02  Code ↗';
        label.setAttribute('aria-label', action === 'terminal' ? 'Open project terminal' : 'Open project code');
        label.addEventListener('click', () => {
            if(this.navigation==='walk'&&action==='terminal'){const distance=this.camera.position.distanceTo(new THREE.Vector3(-2.65,1.99,0.204));if(distance>3.2){this.options.onMessage('Walk closer to the terminal monitor.');return;}this.walker?.focusTerminal();}
            this.options.onSelect(action);
        });
        this.host.appendChild(label); this.labels.push(label);
    }
    private screenTexture(action: Workstation): THREE.CanvasTexture {
        if(action==='terminal'){
            this.terminalSurface=document.createElement('canvas');this.terminalSurface.width=1024;this.terminalSurface.height=576;
            this.terminalTexture=new THREE.CanvasTexture(this.terminalSurface);this.terminalTexture.colorSpace=THREE.SRGBColorSpace;
            this.setTerminalLines([]);return this.terminalTexture;
        }
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const c = canvas.getContext('2d')!;
        c.fillStyle='#111d2a'; c.fillRect(0,0,640,360);
        c.fillStyle='#a4c6ed'; c.font='24px monospace';
        c.fillText('PROJECT FILES',36,55);
        c.fillStyle='#d2dce6'; c.font='21px monospace';
        const lines=['README.md','src/','', 'Open in the editor →'];
        lines.forEach((line,i)=>c.fillText(line,36,115+i*43));
        c.fillStyle='#526c7c'; c.font='16px monospace'; c.fillText('OMO / WORKSTATION',36,330);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
    }
    private plant(parent: THREE.Object3D, x: number, z: number): void {
        this.cylinder(parent, 0.35, 0.5, [x, 0.25, z], 0xd1c7af, 0.25);
        this.fern(parent,x,z,0.5);
    }
    private fern(parent: THREE.Object3D, x: number, z: number, lift=0): void {
        for (let i=0;i<7;i++) {
            const a=i*Math.PI*2/7;
            const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26,8,6), this.material(i%2?0x6d9b71:0x4c7e62));
            leaf.scale.set(0.5,2.5,0.35); leaf.rotation.z=-Math.sin(a)*0.8; leaf.rotation.x=Math.cos(a)*0.8;
            leaf.position.set(x+Math.sin(a)*0.2,0.65+lift,z+Math.cos(a)*0.2); leaf.castShadow=true; parent.add(leaf);
        }
    }
    private tree(parent: THREE.Object3D, x: number, z: number, scale: number): void {
        const trunk=this.cylinder(parent,0.1*scale,2.6*scale,[x,1.3*scale,z],0x675940,0.16*scale,8);
        trunk.rotation.z=0.1;
        for(let i=0;i<4;i++) {
            const crown=new THREE.Mesh(new THREE.IcosahedronGeometry(0.75*scale,1),this.material(i%2?0x5c8661:0x466e55));
            crown.position.set(x+Math.sin(i*2.4)*0.5,2.4*scale+(i%2)*0.3,z+Math.cos(i*2.4)*0.4); crown.scale.y=0.8; crown.castShadow=true;parent.add(crown);
        }
    }
    private bindControls(canvas: HTMLCanvasElement): void {
        const down=(event:PointerEvent)=> {if(event.button!==0)return;this.pointer={x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,dragged:false};canvas.setPointerCapture(event.pointerId);};
        const move=(event:PointerEvent)=>{
            if(!this.pointer)return;
            if(Math.hypot(event.clientX-this.pointer.startX,event.clientY-this.pointer.startY)>5)this.pointer.dragged=true;
            if(this.pointer.dragged){this.state.azimuth-=(event.clientX-this.pointer.x)*0.006;this.state.elevation=Math.max(0.15,Math.min(1.4,this.state.elevation+(event.clientY-this.pointer.y)*0.004));this.positionCamera();}
            this.pointer.x=event.clientX;this.pointer.y=event.clientY;
        };
        const up=(event:PointerEvent)=>{
            if(!this.pointer)return;const dragged=this.pointer.dragged;this.pointer=undefined;
            if(dragged){this.options.onCameraChange({...this.state});return;}
            const rect=canvas.getBoundingClientRect();const p=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
            const ray=new THREE.Raycaster();ray.setFromCamera(p,this.camera);const hits=ray.intersectObjects(this.roots,true);
            for(const hit of hits){let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;if(node?.userData.workstation){this.options.onSelect(node.userData.workstation);break;}}
        };
        const wheel=(event:WheelEvent)=>{event.preventDefault();this.state.distance=Math.max(10,Math.min(30,this.state.distance+event.deltaY*0.01));this.positionCamera();this.options.onCameraChange({...this.state});};
        const key=(event:KeyboardEvent)=>{
            if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(event.key))return;event.preventDefault();
            if(event.key==='ArrowLeft')this.state.azimuth-=0.12;if(event.key==='ArrowRight')this.state.azimuth+=0.12;
            if(event.key==='ArrowUp')this.state.elevation=Math.min(1.4,this.state.elevation+0.08);if(event.key==='ArrowDown')this.state.elevation=Math.max(0.15,this.state.elevation-0.08);
            if(event.key==='+')this.state.distance=Math.max(10,this.state.distance-1);if(event.key==='-')this.state.distance=Math.min(30,this.state.distance+1);
            this.positionCamera();this.options.onCameraChange({...this.state});
        };
        canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('wheel',wheel,{passive:false});canvas.addEventListener('keydown',key);
        this.cleanup.push(()=>{canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('wheel',wheel);canvas.removeEventListener('keydown',key);});
    }
    setNavigation(mode: 'walk' | 'overview'): void {
        this.navigation = mode; this.camera.fov = mode === 'walk' ? 65 : 38; this.camera.updateProjectionMatrix();
        this.walker?.setEnabled(mode === 'walk');
        if (this.renderer) { this.renderer.domElement.dataset.navigation = mode; }
        this.labels.forEach(label => label.classList.toggle('is-walk', mode === 'walk'));
        this.positionCamera();
    }
    setTerminalLines(lines: string[]): void {
        this.terminalLines = lines;
        if (!this.terminalSurface || !this.terminalTexture) return;
        const c = this.terminalSurface.getContext('2d')!;
        c.fillStyle = '#091119'; c.fillRect(0,0,1024,576);
        c.fillStyle = '#87cdb4'; c.font = '17px monospace'; c.fillText('OMO / LIVE PROJECT TERMINAL',24,29);
        c.fillStyle = '#283e48'; c.fillRect(20,42,984,1);
        c.font = '20px monospace';
        if (!lines.length) {
            c.fillStyle='#c7ded4';c.fillText('Walk up and click this screen.',24,104);
            c.fillStyle='#7e9a9e';c.fillText('A real project shell will run here.',24,140);
        } else lines.slice(-22).forEach((line,i) => { c.fillStyle=line.includes('$')?'#b8e6ca':'#e0e8eb';c.fillText(line.slice(0,80),24,70+i*22); });
        this.terminalTexture.needsUpdate = true;
        if(this.renderer)this.renderer.domElement.dataset.terminalText=lines.join('\n');
    }
    private interactAt(x: number, y: number): Workstation | undefined {
        const rect=this.renderer.domElement.getBoundingClientRect();
        const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1),this.camera);
        for(const hit of ray.intersectObjects(this.roots,true)){
            let node:THREE.Object3D|null=hit.object;while(node&&!node.userData.workstation)node=node.parent;
            const action=node?.userData.workstation as Workstation|undefined;
            if(!action)continue;
            const center=action==='terminal'?new THREE.Vector3(-2.65,1.99,0.204):new THREE.Vector3(2.25,1.99,-0.746);
            if(this.camera.position.distanceTo(center)>3.2){this.options.onMessage('Walk closer to the workstation.');return;}
            this.options.onSelect(action);return action;
        }
        return undefined;
    }
    private positionCamera(): void {
        if (this.navigation === 'walk') { this.walker?.step(0); return; }
        const {azimuth:a,elevation:e,distance:d}=this.state;
        const fit = Math.max(1, 1.28 / this.camera.aspect);
        this.camera.position.set(Math.sin(a)*Math.cos(e)*d*fit,Math.sin(e)*d*fit,Math.cos(a)*Math.cos(e)*d*fit);
        this.camera.lookAt(0,0.7,0);
    }
    private resize():void {
        const w=this.host.clientWidth,h=this.host.clientHeight;if(!w||!h)return;
        this.renderer.setSize(w,h);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.positionCamera();
    }
    private draw=():void=>{
        if(this.disposed)return;
        const now=performance.now();const delta=(now-this.lastFrame)/1000;this.lastFrame=now;
        if(this.host.clientWidth&&this.host.clientHeight){
            this.walker?.step(delta);
            this.renderer.render(this.scene,this.camera);
            this.labels.forEach((label,i)=>{
                const p=new THREE.Vector3().copy(this.roots[i].position).add(new THREE.Vector3(0,this.navigation==='walk'?2.55:2.9,-0.3)).project(this.camera);
                label.style.left=`${(p.x*0.5+0.5)*this.host.clientWidth}px`;label.style.top=`${(-p.y*0.5+0.5)*this.host.clientHeight}px`;
                label.style.visibility=p.z>1||p.z< -1?'hidden':'visible';
                if(i===0){const screen=new THREE.Vector3(-2.65,1.99,0.204).project(this.camera);this.renderer.domElement.dataset.terminalX=String((screen.x*.5+.5)*this.host.clientWidth);this.renderer.domElement.dataset.terminalY=String((-screen.y*.5+.5)*this.host.clientHeight);}
            });
        }
        this.frame=requestAnimationFrame(this.draw);
    };
    resetCamera():void{if(this.navigation==='walk'){this.walker?.reset();return;}this.state={azimuth:0.56,elevation:0.61,distance:24};this.positionCamera();this.options.onCameraChange({...this.state});}
    dispose():void{
        this.disposed=true;this.walker?.dispose();cancelAnimationFrame(this.frame);this.observer?.disconnect();this.cleanup.forEach(fn=>fn());this.labels.forEach(label=>label.remove());
        this.scene.traverse(node=>{if(node instanceof THREE.Mesh){node.geometry.dispose();const ms=Array.isArray(node.material)?node.material:[node.material];ms.forEach(m=>{(m as THREE.MeshStandardMaterial).map?.dispose();m.dispose();});}});
        if(this.renderer){this.renderer.dispose();this.renderer.domElement.remove();}
    }
}
