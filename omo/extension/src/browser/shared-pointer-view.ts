/**
 * promise:share (L10) — draws shared pointers in the 3D room: a soft beam from an avatar's chest to the
 * spot it aims at, ending in a dot (with a faint halo). One for you (while you hold Q) and one per other
 * member who is pointing, in their name colour. Only positions come in; nothing is read from screens.
 */
import * as THREE from 'three';
import type { SharedPoint } from '../common/shared-pointer';

export interface BeamSpec { id: string; colour: string; from: SharedPoint; to: SharedPoint }

interface Beam { group: THREE.Group; rod: THREE.Mesh; dot: THREE.Mesh; halo: THREE.Mesh; colour: string }

const UP = new THREE.Vector3(0, 1, 0);

export class PointerBeams {
    private beams = new Map<string, Beam>();
    private rodGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 8, 1, true);
    private dotGeo = new THREE.SphereGeometry(0.055, 16, 12);
    private haloGeo = new THREE.SphereGeometry(0.16, 16, 12);
    constructor(private readonly scene: THREE.Scene) {}

    /** Replace the drawn set. Returns true when anything changed (the caller re-renders). */
    set(specs: BeamSpec[]): boolean {
        let changed = false;
        const want = new Set(specs.map(s => s.id));
        for (const [id, beam] of this.beams) if (!want.has(id)) { this.drop(beam); this.beams.delete(id); changed = true; }
        for (const spec of specs) {
            let beam = this.beams.get(spec.id);
            if (beam && beam.colour !== spec.colour) { this.drop(beam); this.beams.delete(spec.id); beam = undefined; }
            if (!beam) { beam = this.make(spec.colour); this.beams.set(spec.id, beam); changed = true; }
            changed = this.place(beam, spec.from, spec.to) || changed;
        }
        return changed;
    }

    dispose(): void {
        for (const beam of this.beams.values()) this.drop(beam);
        this.beams.clear();
        this.rodGeo.dispose(); this.dotGeo.dispose(); this.haloGeo.dispose();
    }

    private make(colour: string): Beam {
        const c = new THREE.Color(colour);
        const soft = (opacity: number) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity, depthWrite: false, toneMapped: false });
        const group = new THREE.Group(); group.name = 'omo-shared-pointer'; group.renderOrder = 20;
        const rod = new THREE.Mesh(this.rodGeo, soft(0.42));
        const dot = new THREE.Mesh(this.dotGeo, soft(0.95));
        const halo = new THREE.Mesh(this.haloGeo, soft(0.22));
        for (const m of [rod, dot, halo]) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; group.add(m); }
        this.scene.add(group);
        return { group, rod, dot, halo, colour };
    }

    private place(beam: Beam, from: SharedPoint, to: SharedPoint): boolean {
        const a = new THREE.Vector3(from.x, from.y, from.z), b = new THREE.Vector3(to.x, to.y, to.z);
        if (beam.dot.position.distanceToSquared(b) < 1e-6 && beam.rod.userData.from && (beam.rod.userData.from as THREE.Vector3).distanceToSquared(a) < 1e-6) return false;
        const length = Math.max(0.01, a.distanceTo(b));
        beam.rod.position.copy(a).add(b).multiplyScalar(0.5);
        beam.rod.scale.set(1, length, 1);
        beam.rod.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
        beam.rod.userData.from = a;
        beam.dot.position.copy(b); beam.halo.position.copy(b);
        return true;
    }

    private drop(beam: Beam): void {
        this.scene.remove(beam.group);
        for (const m of [beam.rod, beam.dot, beam.halo]) (m.material as THREE.Material).dispose();
    }
}
