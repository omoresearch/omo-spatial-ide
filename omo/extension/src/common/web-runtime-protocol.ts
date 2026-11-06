export const OMO_WEB_PATH = '/services/omo-web';
export interface WebRuntimeStatus { available: boolean; detail: string }
/** One page tab of a web surface. Only the active tab is painted on the wall and takes input. */
export interface WebTab {
    id: string;
    url: string;
    title: string;
    active: boolean;
    loading: boolean;
    /** The leak guard closed this hidden tab's page; selecting it reloads its address. */
    sleeping: boolean;
    error?: string;
}
export interface WebSurface {
    id: string;
    /** url/title/loading/error describe the active tab. */
    url: string;
    title: string;
    width: number;
    height: number;
    loading: boolean;
    error?: string;
    muted: boolean;
    volume: number;
    /** Page tabs of this surface, in strip order (1..MAX_TABS). Links that open a new window add a tab. */
    tabs: WebTab[];
    activeTab: string;
}
export interface WebSurfaceFrame {
    sequence: number;
    surface: WebSurface;
    mime: 'image/jpeg';
    data: string;
}
export type WebKey = 'Enter' | 'Backspace' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Delete' | 'PageUp' | 'PageDown' | 'Space' | 'Escape' | 'Control+a' | 'Control+c' | 'Control+x' | 'Control+z';
/** A separate, sandboxed Chrome profile. No access to the user's ordinary Chrome sessions. */
export interface OmoWebService {
    status(): Promise<WebRuntimeStatus>;
    open(input: { url: string; width: number; height: number }): Promise<WebSurface>;
    navigate(input: { id: string; url: string }): Promise<WebSurface>;
    frame(input: { id: string; afterSequence: number }): Promise<WebSurfaceFrame>;
    click(input: { id: string; x: number; y: number; button?: 'left' | 'right' }): Promise<void>;
    typeText(input: { id: string; text: string }): Promise<void>;
    key(input: { id: string; key: WebKey }): Promise<void>;
    scroll(input: { id: string; x: number; y: number; deltaX: number; deltaY: number }): Promise<void>;
    setAudio(input: { id: string; muted: boolean; volume: number }): Promise<WebSurface>;
    /** The surface's page tabs, with fresh titles. */
    listTabs(input: { id: string }): Promise<WebTab[]>;
    /** Show another tab on the wall; input then goes to it. */
    selectTab(input: { id: string; tabId: string }): Promise<WebSurface>;
    /** Close one tab. The last tab stays (close the surface instead). */
    closeTab(input: { id: string; tabId: string }): Promise<WebSurface>;
    close(id: string): Promise<void>;
    closeAll(): Promise<void>;
}
export const OmoWebService = Symbol('OmoWebService');
