import * as React from 'react';

/**
 * Omo line icons. One small set for the HUD, focus bar, chat and notifications, so no control
 * depends on a colour emoji font. 24×24 grid, 1.75 stroke, round joins, drawn in currentColor:
 * the colour always comes from the design tokens of the surrounding control.
 */
export type IconName =
    | 'chat' | 'bell' | 'keyboard' | 'more' | 'maximize' | 'minimize' | 'split' | 'single' | 'monitor' | 'window'
    | 'walk' | 'check' | 'alert' | 'x' | 'stop' | 'lock' | 'mic' | 'mic-off' | 'volume' | 'chevron-up' | 'chevron-down'
    | 'pencil' | 'refresh' | 'plus' | 'type' | 'follow' | 'users';

const PATHS: Record<IconName, React.ReactNode> = {
    chat: <path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z" />,
    bell: <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
    keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8" /></>,
    more: <><circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
    maximize: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
    minimize: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
    split: <><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M12 4.5v15" /></>,
    single: <rect x="3" y="4.5" width="18" height="15" rx="2" />,
    monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16v4" /></>,
    window: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></>,
    walk: <><path d="M10 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h4" /><path d="M15 8l4 4-4 4M19 12H9.5" /></>,
    check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
    alert: <><path d="M12 4 21 19.5H3Z" /><path d="M12 10v4.2M12 17h.01" /></>,
    x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
    lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
    mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></>,
    'mic-off': <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M4 4l16 16" /></>,
    volume: <><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4Z" /><path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" /></>,
    'chevron-up': <path d="M6.5 14.5 12 9l5.5 5.5" />,
    'chevron-down': <path d="M6.5 9.5 12 15l5.5-5.5" />,
    pencil: <path d="M14.5 5.5l4 4L8.5 19.5H4.5v-4Z" />,
    refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
    plus: <path d="M12 5.5v13M5.5 12h13" />,
    type: <path d="M4 7.5V5h10v2.5M9 5v14M7 19h4M14 12.5V11h6v1.5M17 11v8M15.8 19h2.4" />,
    follow: <path d="M12 3.5 19 20l-7-3.8L5 20Z" />,
    users: <><circle cx="9" cy="8.5" r="3.5" /><path d="M3 19.5a6 6 0 0 1 12 0M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14a6 6 0 0 1 3.5 5.5" /></>
};

/** Inline line icon. Decorative by default (aria-hidden): the control around it carries the name. */
export function Icon(props: { name: IconName; size?: number; className?: string; label?: string }): React.ReactElement {
    const size = props.size ?? 16;
    return <svg className={`omo-icon${props.className ? ` ${props.className}` : ''}`} data-icon={props.name} width={size} height={size} viewBox="0 0 24 24"
        fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
        {...(props.label ? { role: 'img', 'aria-label': props.label } : { 'aria-hidden': true, focusable: 'false' })}>
        {PATHS[props.name]}
    </svg>;
}
