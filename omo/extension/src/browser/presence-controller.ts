import { OmoPresenceService, PresenceJoin, RoomSnapshot, presenceJoin } from '../common/presence-protocol';
import { PlayerPose } from '../common/player-state';
export interface PresenceState { phase: 'solo'|'joining'|'joined'; join?: PresenceJoin; snapshot?: RoomSnapshot; error: string }
interface Options { service: OmoPresenceService; pose(): PlayerPose; schedule(fn: ()=>void, ms: number): unknown; cancel(handle: unknown): void; onChange(state: PresenceState): void }
/** Serialized presence requests. Never owns or starts terminals, browsers or agents. */
export class PresenceController {
    state: PresenceState = {phase:'solo',error:''};
    private epoch=0;
    private timer?:unknown;
    private serial:Promise<unknown>=Promise.resolve();
    private disposed=false;
    constructor(private options:Options){}
    private emit(state:PresenceState):void {this.state=state;this.options.onChange(state);}
    private stop():void {if(this.timer!==undefined)this.options.cancel(this.timer);this.timer=undefined;}
    private queue<T>(fn:()=>Promise<T>):Promise<T> {const task=this.serial.then(fn);this.serial=task.catch(()=>undefined);return task;}
    async join(raw:PresenceJoin):Promise<void> {
        if(this.disposed)throw new Error('Presence controller is disposed.');
        if(this.state.phase==='joining')throw new Error('This tab is already joining a room. Wait for that request or leave it first.');
        let input:PresenceJoin;try{input=presenceJoin(raw);}catch(error){this.emit({...this.state,error:String(error)});return;}
        const epoch=++this.epoch, previous=this.state;this.stop();this.emit({...previous,phase:'joining',error:''});
        await this.queue(async()=>{
            if(epoch!==this.epoch)return;
            try{const snapshot=await this.options.service.join(input);if(epoch===this.epoch){this.emit({phase:'joined',join:input,snapshot,error:''});this.schedule(epoch);}}
            catch(error){if(epoch===this.epoch){this.emit({...previous,phase:previous.snapshot?'joined':'solo',error:String(error)});if(previous.snapshot)this.schedule(epoch);}}
        });
    }
    private schedule(epoch:number):void {
        if(this.disposed||epoch!==this.epoch||!this.state.snapshot)return;
        this.timer=this.options.schedule(()=>this.tick(epoch),200);
    }
    private async tick(epoch:number):Promise<void> {
        this.timer=undefined;
        await this.queue(async()=>{
            if(this.disposed||epoch!==this.epoch||!this.state.snapshot)return;
            try{
                const raw=this.options.pose(),pose={...raw,yaw:Math.atan2(Math.sin(raw.yaw),Math.cos(raw.yaw))};
                const snapshot=await this.options.service.update(pose);
                if(epoch===this.epoch){this.emit({...this.state,snapshot,error:''});this.schedule(epoch);}
            }catch(error){if(epoch===this.epoch){this.emit({phase:'solo',error:`Presence lost. Join again: ${String(error)}`});}}
        });
    }
    async leave():Promise<void> {++this.epoch;this.stop();this.emit({phase:'solo',error:''});await this.queue(()=>this.options.service.leave());}
    async dispose():Promise<void> {if(this.disposed)return;this.disposed=true;await this.leave();}
}
