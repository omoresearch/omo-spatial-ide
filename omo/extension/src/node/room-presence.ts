import { randomUUID } from 'crypto';
import { presenceJoin, presenceLayout, presencePose } from '../common/presence-protocol';
import type { OmoPresenceService as OmoPresenceServiceType, PresenceJoin, RoomMember, RoomSnapshot } from '../common/presence-protocol';
import { PLAYER_HOME } from '../common/player-state';
import type { PlayerPose, RoomLayoutId } from '../common/player-state';
interface Member extends RoomMember { clientId: string; seen: number }
interface Room { projectUri: string; theme: PresenceJoin['theme']; layout: RoomLayoutId; members: Map<string,Member> }
/** Ephemeral visual presence. One server-owned member identity per RPC connection. */
export class RoomPresence {
    private rooms = new Map<string,Room>();
    private now: ()=>number;
    constructor(now: ()=>number = Date.now) { this.now = now; }
    private sweep(): void {
        for (const [code,room] of this.rooms) {
            for (const [id,member] of room.members) if (this.now()-member.seen>15000) room.members.delete(id);
            if (!room.members.size) this.rooms.delete(code);
        }
    }
    connection(): OmoPresenceServiceType & { dispose(): void } {
        const selfId=randomUUID(); let roomId: string|undefined,previousJoin:PresenceJoin|undefined,closed=false,membershipToken: symbol|undefined;
        const leave=():void=>{if(roomId){const room=this.rooms.get(roomId);room?.members.delete(selfId);if(room&&!room.members.size)this.rooms.delete(roomId);}roomId=undefined;previousJoin=undefined;membershipToken=undefined;};
        const snapshot=():RoomSnapshot=>{
            const room=roomId&&this.rooms.get(roomId);
            if(!room||!room.members.has(selfId))throw new Error('Join a room first. Presence expired or disconnected.');
            const result: RoomSnapshot = {roomId:roomId!,theme:room.theme,selfId,members:[...room.members.values()].map(m=>({id:m.id,name:m.name,pose:{...m.pose}}))};
            if (room.layout === 'wide') result.layout = 'wide';
            return result;
        };
        const open=():void=>{if(closed)throw new Error('This presence connection is closed.');};
        const service:OmoPresenceServiceType & {dispose():void} = {
            join:async raw=>{
                open();const input=presenceJoin(raw);this.sweep();let room=this.rooms.get(input.roomId);
                if(room){
                    if(room.projectUri!==input.projectUri||room.theme!==input.theme||room.layout!==presenceLayout(input))throw new Error('This room uses a different project or theme. Layout must also match.');
                    if([...room.members.values()].some(m=>m.clientId===input.clientId&&m.id!==selfId))throw new Error('This tab identity is already in the room. Open an independent tab or browser profile.');
                    if(!room.members.has(selfId)&&room.members.size>=8)throw new Error('This room is full (8 people maximum).');
                }else if(this.rooms.size>=32)throw new Error('Live room limit reached. Leave an unused room first.');
                if(roomId!==input.roomId)leave();
                if(!room){room={projectUri:input.projectUri,theme:input.theme,layout:presenceLayout(input),members:new Map()};this.rooms.set(input.roomId,room);}
                const old=room.members.get(selfId);
                room.members.set(selfId,{id:selfId,clientId:input.clientId,name:input.name,pose:old?.pose??{...PLAYER_HOME},seen:this.now()});roomId=input.roomId;previousJoin=input;membershipToken=Symbol();
                return snapshot();
            },
            update:async raw=>{
                open();const pose=presencePose(raw);this.sweep();
                let member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                if(!member){
                    // Browser scheduling can pause a live tab beyond the visual lease. Renew
                    // only this connection's explicit membership, through all normal join gates.
                    if(!previousJoin)throw new Error('Join a room first.');
                    const renewal=service.join(previousJoin);
                    const expectedMembership=membershipToken;
                    await renewal;
                    if(closed)throw new Error('This presence connection is closed.');
                    if(membershipToken!==expectedMembership)throw new Error('Join a room first. Presence expired or disconnected.');
                    member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                    if(!member)throw new Error('Join a room first. Presence expired or disconnected.');
                }
                member.pose=pose;member.seen=this.now();return snapshot();
            },
            leave:async()=>{leave();},
            dispose:()=>{closed=true;leave();}
        };return service;
    }
}
