import { Observable, Subject } from 'rxjs';
import { BridgeRequest, HostToWebview, NotifyLevel, WebviewToHost } from './protocol';

export interface BridgeToast {
  id: number;
  level: NotifyLevel;
  text: string;
}

/**
 * Puente entre la webview y su host: `VsCodeBridge` dentro de VS Code, `MockBridge` en el navegador
 * (`ng serve`) con el proyecto de ejemplo.
 */
export abstract class NexoBridge {
  abstract readonly messages$: Observable<HostToWebview>;
  abstract readonly isMock: boolean;
  /** Avisos que pinta la propia webview (solo en el modo navegador). */
  readonly toast$ = new Subject<BridgeToast>();

  newId(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (error: unknown) {
      console.warn('[Nexo] randomUUID no disponible.', error instanceof Error ? error.name : '');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  abstract request<T>(req: BridgeRequest, id?: string): Promise<T>;
  abstract cancel(id: string): void;
  abstract post(msg: WebviewToHost): void;
}
