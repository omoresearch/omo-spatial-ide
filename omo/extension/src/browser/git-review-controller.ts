import type { GitReviewService, GitReviewSnapshot, GitReviewPatch } from '../common/git-review-protocol';
export interface GitReviewState { phase:'idle'|'loading'|'ready'|'error'; projectUri?:string; snapshot?:GitReviewSnapshot; selected?:string; patch?:GitReviewPatch; loadingPatch:boolean; error:string }
/** Read-only UI state. No runtime, command or filesystem writers are injected. */
export class GitReviewController {
    state:GitReviewState={phase:'idle',loadingPatch:false,error:''};
    private epoch=0;
    private selectionEpoch=0;
    constructor(private service:GitReviewService,private changed:(state:GitReviewState)=>void){}
    private emit(state:GitReviewState):void {this.state=state;this.changed(state);}
    async open(projectUri:string):Promise<void> {
        const epoch=++this.epoch;
        this.emit({phase:'loading',projectUri,loadingPatch:false,error:''});
        try{const snapshot=await this.service.list(projectUri);if(snapshot.projectUri!==projectUri)throw new Error('Review project context changed. Refresh the list.');if(epoch===this.epoch)this.emit({phase:'ready',projectUri,snapshot,loadingPatch:false,error:''});}
        catch(error){if(epoch===this.epoch)this.emit({phase:'error',projectUri,loadingPatch:false,error:String(error)});}
    }
    close():void {++this.epoch;this.emit({phase:'idle',loadingPatch:false,error:''});}
    async select(path:string):Promise<void> {
        const epoch=this.epoch, selection=++this.selectionEpoch;
        const projectUri=this.state.projectUri;
        if(!projectUri||!this.state.snapshot?.changes.some(change=>change.path===path)){
            this.emit({...this.state,selected:undefined,patch:undefined,loadingPatch:false,error:'Choose an exact listed file.'});return;
        }
        this.emit({...this.state,selected:path,patch:undefined,loadingPatch:true,error:''});
        try{const patch=await this.service.diff({projectUri,path});if(patch.projectUri!==projectUri||patch.path!==path)throw new Error('Review patch context changed. Refresh the list.');if(epoch===this.epoch&&selection===this.selectionEpoch)this.emit({...this.state,patch,loadingPatch:false});}
        catch(error){if(epoch===this.epoch&&selection===this.selectionEpoch)this.emit({...this.state,patch:undefined,loadingPatch:false,error:String(error)});}
    }
}
