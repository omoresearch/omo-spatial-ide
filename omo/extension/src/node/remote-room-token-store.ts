import { promises as fs } from 'fs';
import * as path from 'path';
import type { SavedRemoteRoom } from '../common/remote-room-protocol';
import type { RoomRole } from '../common/room-wire-protocol';
import { ROOM_ID_RE, ROOM_SECRET_RE } from '../common/room-wire-protocol';

interface Entry extends SavedRemoteRoom { token: string; memberId: string }
interface FileShape { version: 1; rooms: Record<string, Entry> }
const key = (server: string, roomId: string): string => `${server}|${roomId}`;

/**
 * Member tokens for remote rooms, in `<theia config dir>/omo/remote-rooms.json`, mode 0600
 * (directory 0700). Never in browser storage, never in a WorldSpec, never logged.
 * Owner tokens are not stored at all.
 */
export class RemoteRoomTokenStore {
    private chain: Promise<unknown> = Promise.resolve();
    constructor(private readonly file: () => Promise<string>) {}

    private serial<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.then(fn); this.chain = next.catch(() => undefined); return next; }

    private async read(): Promise<FileShape> {
        const file = await this.file();
        try {
            const stat = await fs.stat(file);
            if ((stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600); // repair loose permissions
            const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as FileShape;
            if (parsed?.version !== 1 || typeof parsed.rooms !== 'object' || !parsed.rooms) return { version: 1, rooms: {} };
            for (const [k, e] of Object.entries(parsed.rooms)) if (!e || !ROOM_SECRET_RE.test(e.token) || !ROOM_ID_RE.test(e.roomId)) delete parsed.rooms[k];
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rooms: {} };
            if (error instanceof SyntaxError) return { version: 1, rooms: {} };
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

    token(server: string, roomId: string): Promise<{ token: string; memberId: string; role: RoomRole } | undefined> {
        return this.serial(async () => { const e = (await this.read()).rooms[key(server, roomId)]; return e ? { token: e.token, memberId: e.memberId, role: e.role } : undefined; });
    }
    save(entry: { server: string; roomId: string; roomName: string; role: RoomRole; memberId: string; token: string }): Promise<void> {
        if (!ROOM_SECRET_RE.test(entry.token)) return Promise.reject(new Error('Refusing to store an invalid member token.'));
        return this.serial(async () => {
            const data = await this.read();
            data.rooms[key(entry.server, entry.roomId)] = { ...entry, savedAt: Date.now() };
            await this.write(data);
        });
    }
    remove(server: string, roomId: string): Promise<void> {
        return this.serial(async () => { const data = await this.read(); if (data.rooms[key(server, roomId)]) { delete data.rooms[key(server, roomId)]; await this.write(data); } });
    }
    list(): Promise<SavedRemoteRoom[]> {
        return this.serial(async () => Object.values((await this.read()).rooms).map(e => ({ server: e.server, roomId: e.roomId, roomName: e.roomName, role: e.role, savedAt: e.savedAt })).sort((a, b) => b.savedAt - a.savedAt));
    }
}
