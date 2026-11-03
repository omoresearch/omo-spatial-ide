export const OMO_WEB_PATH = '/services/omo-web';
export interface WebRuntimeStatus { available: boolean; detail: string }
export interface WebSurface {
    id: string;
    url: string;
    title: string;
    width: number;
    height: number;
    loading: boolean;
    error?: string;
    muted: boolean;
    volume: number;
}
export interface WebSurfaceFrame {
    sequence: number;
    surface: WebSurface;
    mime: 'image/jpeg';
    data: string;
}
export type WebKey = 'Enter' | 'Backspace' | 'Tab' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Delete' | 'PageUp' | 'PageDown' | 'Escape' | 'Control+a' | 'Control+c' | 'Control+x' | 'Control+z';
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
    close(id: string): Promise<void>;
    closeAll(): Promise<void>;
}
export const OmoWebService = Symbol('OmoWebService');
