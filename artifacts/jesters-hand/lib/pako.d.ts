declare module 'pako' {
  export interface InflateOptions {
    raw?: boolean;
    chunkSize?: number;
  }

  export class Inflate {
    constructor(options?: InflateOptions);
    err: number;
    msg: string;
    ended: boolean;
    onData: (chunk: Uint8Array) => void;
    push(data: Uint8Array, finish?: boolean): boolean;
  }
}