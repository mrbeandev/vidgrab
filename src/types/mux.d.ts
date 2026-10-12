declare module "mux.js/lib/mp4/transmuxer.js" {
  export interface TransmuxerOptions {
    remux?: boolean;
    keepOriginalTimestamps?: boolean;
    baseMediaDecodeTime?: number;
    alignGopsAtEnd?: boolean;
  }
  export interface TransmuxSegment {
    type: "combined" | "video" | "audio";
    initSegment: Uint8Array;
    data: Uint8Array;
    info?: Record<string, unknown>;
    captions?: unknown[];
    metadata?: unknown[];
  }
  export class Transmuxer {
    constructor(options?: TransmuxerOptions);
    push(data: Uint8Array): void;
    flush(): void;
    endTimeline(): void;
    reset(): void;
    setBaseMediaDecodeTime(time: number): void;
    on(event: "data", cb: (segment: TransmuxSegment) => void): void;
    on(event: "done", cb: () => void): void;
    on(event: "trackinfo", cb: (info: { hasAudio: boolean; hasVideo: boolean }) => void): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
    off(event: string, cb?: (...args: unknown[]) => void): void;
    dispose(): void;
  }
  const _default: { Transmuxer: typeof Transmuxer };
  export default _default;
}
