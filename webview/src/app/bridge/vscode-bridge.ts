import { Observable, Subject } from 'rxjs';
import { NexoBridge } from './nexo-bridge';
import { BridgeRequest, HostToWebview, WebviewToHost } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const HOST_TYPES = new Set(['init', 'config', 'openFlow', 'response', 'filesChanged', 'fileSaved']);

function isHostMessage(data: unknown): data is HostToWebview {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const type = (data as { type?: unknown }).type;
  if (typeof type !== 'string' || !HOST_TYPES.has(type)) return false;
  if (type === 'response') {
    const r = data as { id?: unknown; ok?: unknown };
    return typeof r.id === 'string' && typeof r.ok === 'boolean';
  }
  return true;
}

/** Puente real dentro de la webview de VS Code. */
export class VsCodeBridge extends NexoBridge {
  readonly isMock = false;
  private readonly api = acquireVsCodeApi();
  private readonly subject = new Subject<HostToWebview>();
  readonly messages$: Observable<HostToWebview> = this.subject.asObservable();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor() {
    super();
    window.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!isHostMessage(data)) return;
      if (data.type === 'response') {
        const entry = this.pending.get(data.id);
        if (!entry) return;
        this.pending.delete(data.id);
        if (data.ok) entry.resolve(data.result);
        else entry.reject(new Error(data.error));
        return;
      }
      this.subject.next(data);
    });
  }

  request<T>(req: BridgeRequest, id = this.newId()): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.api.postMessage({ type: 'request', id, ...req });
    });
  }

  cancel(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.api.postMessage({ type: 'cancel', id });
    const error = new Error('cancelled');
    error.name = 'AbortError';
    entry.reject(error);
  }

  post(msg: WebviewToHost): void {
    this.api.postMessage(msg);
  }
}
