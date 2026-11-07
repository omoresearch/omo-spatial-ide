import { promises as fs } from 'fs';
import * as path from 'path';
import type { SavedRemoteRoom } from '../common/remote-room-protocol';
import type { RoomRole } from '../common/room-wire-protocol';
import { ROOM_ID_RE, ROOM_SECRET_RE } from '../common/room-wire-protocol';

interface Entry extends SavedRemoteRoom { token: string; memberId: string }
interface FileShape { version: 2; rooms: Record<string, Entry> }
const key = (server: string, roomId: string, memberId: string): string => `${server}|${roomId}|${memberId}`;

/**
 * Member tokens for remote rooms, in `<theia config dir>/omo/remote-rooms.json`, mode 0600
 * (directory 0700). Never in browser storage, never in a WorldSpec, never logged.
 * Owner tokens are not stored at all.
 *
 * One IDE backend can serve several browser tabs. Each live connection CLAIMS the membership it
 * uses, so a second tab never silently reuses (and kicks out) the first tab's membership: it
 * redeems the invite as a new member instead.
 */
export class RemoteRoomTokenStore {
    private chain: Promise<unknown> = Promise.resolve();
    private claims = new Map<string, symbol>();
    constructor(private readonly file: () => Promise<string>) {}

    private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.then(fn); this.chain = next.catch(() => undefined); return next; }

    private async read(): Promise<FileShape> {
        const file = await this.file();
        try {
            const stat = await fs.stat(file);
            if ((stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600); // repair loose permissions
            const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as FileShape;
            if (parsed?.version !== 2 || typeof parsed.rooms !== 'object' || !parsed.rooms) return { version: 2, rooms: {} };
            for (const [k, e] of Object.entries(parsed.rooms)) if (!e || !ROOM_SECRET_RE.test(e.token) || !ROOM_ID_RE.test(e.roomId)) delete parsed.rooms[k];
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, rooms: {} };
            if (error instanceof SyntaxError) return { version: 2, rooms: {} };
            throw error;
        }
    }
    private async write(data: FileShape): Promise<void> {
        const file = await this.file();
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data, undefined, 1), { mode: 0o600, flag: 'wx' });
        await fs.chmod(tmp, 0o600);
        await fs.rename(tmp, file);
    }

    /** Most recent saved membership for this room that no other live connection is using. */
    token(server: string, roomId: string, owner?: symbol): Promise<{ token: string; memberId: string; role: RoomRole } | undefined> {
        return this.serial(async () => {
            const free = Object.values((await this.read()).rooms)
                .filter(e => e.server === server && e.roomId === roomId)
                .filter(e => { const c = this.claims.get(key(server, roomId, e.memberId)); return !c || c === owner; })
                .sort((a, b) => b.savedAt - a.savedAt)[0];
            return free ? { token: free.token, memberId: free.memberId, role: free.role } : undefined;
        });
    }
    /** Mark a membership as used by one live connection. False if another connection holds it. */
    claim(server: string, roomId: string, memberId: string, owner: symbol): boolean {
        const k = key(server, roomId, memberId), c = this.claims.get(k);
        if (c && c !== owner) return false;
        this.claims.set(k, owner); return true;
    }
    release(owner: symbol): void { for (const [k, c] of this.claims) if (c === owner) this.claims.delete(k); }
    isClaimed(server: string, roomId: string, memberId: string, owner: symbol): boolean { const c = this.claims.get(key(server, roomId, memberId)); return !!c && c !== owner; }

    save(entry: { server: string; roomId: string; roomName: string; role: RoomRole; memberId: string; token: string }): Promise<void> {
        if (!ROOM_SECRET_RE.test(entry.token)) return Promise.reject(new Error('Refusing to store an invalid member token.'));
        return this.serial(async () => {
            const data = await this.read();
            data.rooms[key(entry.server, entry.roomId, entry.memberId)] = { ...entry, savedAt: Date.now() };
            await this.write(data);
        });
    }
    /** Remove one membership (memberId) or every membership this IDE holds for the room. */
    remove(server: string, roomId: string, memberId?: string): Promise<void> {
        return this.serial(async () => {
            const data = await this.read(); let changed = false;
            for (const [k, e] of Object.entries(data.rooms)) if (e.server === server && e.roomId === roomId && (memberId === undefined || e.memberId === memberId)) { delete data.rooms[k]; changed = true; }
            if (changed) await this.write(data);
        });
    }
    /** One row per room (the newest membership); tokens never leave the backend. */
    list(): Promise<SavedRemoteRoom[]> {
        return this.serial(async () => {
            const rows = new Map<string, SavedRemoteRoom>();
            for (const e of Object.values((await this.read()).rooms)) {
                const k = `${e.server}|${e.roomId}`, have = rows.get(k);
                if (!have || have.savedAt < e.savedAt) rows.set(k, { server: e.server, roomId: e.roomId, roomName: e.roomName, role: e.role, savedAt: e.savedAt });
            }
            return [...rows.values()].sort((a, b) => b.savedAt - a.savedAt);
        });
    }
}
