import type { TerApi } from '../shared/ipc';

declare global {
  interface Window {
    ter: TerApi;
    terInternals: {
      oniguruma(): Promise<Uint8Array>;
      onInitialProject(callback: (root: string) => void): () => void;
    };
  }
}

export {};
