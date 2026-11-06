import { randomUUID } from 'crypto';
import { presenceJoin, presenceLayout, presencePose, voiceSignal, voiceStatus, VOICE_INBOX_MAX, presenceColour, chatSay, PRESENCE_COLOURS, CHAT_INBOX_MAX, CHAT_RATE_COUNT, CHAT_RATE_WINDOW_MS } from '../common/presence-protocol';
import type { OmoPresenceService as OmoPresenceServiceType, PresenceJoin, RoomMember, RoomSnapshot, VoiceSignalEnvelope, ChatMessage, PresenceColour } from '../common/presence-protocol';
import { PLAYER_HOME } from '../common/player-state';
import type { PlayerPose, RoomLayoutId } from '../common/player-state';
interface Member extends RoomMember { clientId: string; seen: number; inbox?: VoiceSignalEnvelope[]; chat?: ChatMessage[]; said?: number[] }
/** First palette colour nobody in the room uses yet (stable, no randomness). */
function freeColour(room: { members: Map<string, Member> }, self: string): PresenceColour {
    const used = new Set([...room.members.values()].filter(m => m.id !== self).map(m => m.colour));
    return PRESENCE_COLOURS.find(c => !used.has(c)) ?? PRESENCE_COLOURS[room.members.size % PRESENCE_COLOURS.length];
}
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
            const result: RoomSnapshot = {roomId:roomId!,theme:room.theme,selfId,members:[...room.members.values()].map(m=>{const out:RoomMember={id:m.id,name:m.name,pose:{...m.pose}};if(m.voice)out.voice={...m.voice};if(m.colour)out.colour=m.colour;return out;})};
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
                const fresh:Member={id:selfId,clientId:input.clientId,name:input.name,pose:old?.pose??{...PLAYER_HOME},seen:this.now(),colour:old?.colour??freeColour(room,selfId)};if(old?.chat)fresh.chat=old.chat;if(old?.said)fresh.said=old.said;
                room.members.set(selfId,fresh);roomId=input.roomId;previousJoin=input;membershipToken=Symbol();
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
            // Room voice: the backend relays bounded signalling between voice-enabled members of
            // the SAME room only. Media flows peer to peer; the backend never sees audio.
            setVoice:async raw=>{
                open();const status=voiceStatus(raw);this.sweep();
                const member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                if(!member)throw new Error('Join a room before turning on voice.');
                if(status){if(member.voice?.session!==status.session)member.inbox=[];member.voice=status;}
                else{delete member.voice;delete member.inbox;}
            },
            signal:async raw=>{
                open();const message=voiceSignal(raw);this.sweep();
                const room=roomId?this.rooms.get(roomId):undefined,member=room?.members.get(selfId);
                if(!room||!member?.voice||member.voice.session!==message.session)throw new Error('Turn on voice in a room first.');
                const target=message.to!==selfId?room.members.get(message.to):undefined;
                if(!target?.voice||target.voice.session!==message.toSession)return; // stale peer session: drop quietly
                const inbox=target.inbox??(target.inbox=[]);
                if(inbox.length>=VOICE_INBOX_MAX)throw new Error('That member is not reading voice signals. Try again.');
                inbox.push({from:selfId,fromSession:message.session,kind:message.kind,data:message.data});
            },
            takeSignals:async()=>{
                open();const member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                if(!member?.voice||!member.inbox?.length)return [];
                const out=member.inbox;member.inbox=[];return out;
            },
            // Room text chat: fan out to the OTHER members of the same room only. Memory only, bounded,
            // rate limited. The backend never interprets a message and never forwards it to a terminal.
            setColour:async raw=>{
                open();const colour=presenceColour(raw);this.sweep();
                const member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                if(!member)throw new Error('Join a room before choosing a colour.');
                member.colour=colour;
            },
            say:async raw=>{
                open();const said=chatSay(raw);this.sweep();
                const room=roomId?this.rooms.get(roomId):undefined,member=room?.members.get(selfId);
                if(!room||!member)throw new Error('Join a room before chatting.');
                const now=this.now();member.said=(member.said??[]).filter(t=>now-t<CHAT_RATE_WINDOW_MS);
                if(member.said.length>=CHAT_RATE_COUNT)throw new Error('You are sending messages too fast. Wait a few seconds.');
                member.said.push(now);
                const message:ChatMessage={id:randomUUID(),from:selfId,fromName:member.name,at:now,kind:said.kind};
                if(member.colour)message.colour=member.colour;
                if(said.kind==='text')message.text=said.text;else message.emote=said.emote;
                for(const other of room.members.values()){
                    if(other.id===selfId)continue;
                    const inbox=other.chat??(other.chat=[]);
                    inbox.push({...message});if(inbox.length>CHAT_INBOX_MAX)inbox.splice(0,inbox.length-CHAT_INBOX_MAX);
                }
                return {...message};
            },
            takeChat:async()=>{
                open();const member=roomId?this.rooms.get(roomId)?.members.get(selfId):undefined;
                if(!member?.chat?.length)return [];
                const out=member.chat;member.chat=[];return out;
            },
            dispose:()=>{closed=true;leave();}
        };return service;
    }
}
