export interface CodeReviewFrame { title:string; lines:string[]; status:string }
/** The physical display is only a preview; never silently imply the full patch is shown. */
export function codeReviewPreview(frame:CodeReviewFrame):CodeReviewFrame {
    const visible=frame.lines.slice(0,22), clipped=visible.some(line=>Array.from(line).length>100);
    const lines=visible.map(line=>Array.from(line).slice(0,100).join(''));
    const count=frame.lines.length>22?`22/${frame.lines.length} lines`:`${frame.lines.length} lines`;
    return {title:frame.title,lines,status:`PREVIEW ${count}${clipped?' · 100-char clip':''} · ${frame.status} · Code for full view`};
}
