import { Observable, Subject } from 'rxjs';
import { SAMPLE_PROPOSALS, sampleCompareResponse } from '../sample/sample-changes';
import { SAMPLE_DB_CONNECTIONS, SAMPLE_DB_METADATA } from '../sample/sample-db';
import { SAMPLE_FILES, SAMPLE_FLOW } from '../sample/sample-project';
import { sampleFlowResponse } from '../sample/sample-results';
import { codeBaseName, codeExtension, isBinaryCodeExtension, isSensitiveCodeFile } from '../workspace-code/workspace-code.types';
import { NexoBridge } from './nexo-bridge';
import { BridgeRequest, HostToWebview, ProjectSnapshot, ReadFileResult, WebviewToHost } from './protocol';

/** Retardo simulado de las respuestas de la IA. */
const MOCK_DELAY_MS = 900;

/**
 * Puente del modo navegador (`ng serve`, sin `acquireVsCodeApi`): abre el flujo de ejemplo y simula el backend.
 * Nunca se usa dentro de VS Code.
 */
export class MockBridge extends NexoBridge {
  readonly isMock = true;
  private readonly subject = new Subject<HostToWebview>();
  readonly messages$: Observable<HostToWebview> = this.subject.asObservable();
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; reject: (error: Error) => void }>();
  private toastSeq = 0;
  private started = false;

  post(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.start();
        break;
      case 'notify':
        this.toast$.next({ id: ++this.toastSeq, level: msg.level, text: msg.text });
        break;
      case 'openRef':
        console.info('[Nexo] Abrir en el editor (modo navegador):', msg.sample?.path ?? msg.fileId, msg.line);
        break;
      case 'ask':
        console.info('[Nexo] Preguntar a la IA (modo navegador):', msg.text);
        break;
      case 'cancel':
        this.cancel(msg.id);
        break;
      default:
        break;
    }
  }

  /** Igual que el host real: `init` y el flujo pendiente se envían cuando la webview avisa de que está lista. */
  private start(): void {
    if (this.started) return;
    this.started = true;
    setTimeout(() => {
      this.subject.next({ type: 'init', language: 'es', modelName: 'Modelo de ejemplo', theme: 'nexo' });
      this.subject.next({ type: 'openFlow', flow: SAMPLE_FLOW, sample: true, proposals: SAMPLE_PROPOSALS });
    });
  }

  request<T>(req: BridgeRequest, id = this.newId()): Promise<T> {
    switch (req.op) {
      case 'listFiles':
        return Promise.resolve(this.snapshot() as T);
      case 'readFile': {
        const content = SAMPLE_FILES[req.fileId] ?? SAMPLE_FILES[req.fileId.replace(/^sample:/, '')];
        const result: ReadFileResult = content === undefined ? { ok: false, binary: false, content: '' } : { ok: true, binary: false, content };
        return Promise.resolve(result as T);
      }
      case 'readMountFile': {
        const content = SAMPLE_FILES[req.path];
        return Promise.resolve((content === undefined || req.as !== 'text' ? null : content) as T);
      }
      case 'copy':
        if (typeof navigator === 'undefined' || !navigator.clipboard) return Promise.reject(new Error('clipboard'));
        return navigator.clipboard.writeText(req.text).then(() => true as T);
      case 'flow':
        return this.delayed(id, () => sampleFlowResponse(req.kind, req.body.contextBase64) as T);
      case 'compareChange':
        return this.delayed(id, () => sampleCompareResponse(req.proposalId, req.body.contextBase64) as T);
      case 'dbExplain':
        return Promise.reject(new Error('«Mejorar con IA» no está disponible en el modo navegador.'));
      case 'applyFiles':
        return Promise.resolve({ ok: true } as T);
      case 'confirm':
        return Promise.resolve((typeof window !== 'undefined' && window.confirm(req.message)) as T);
      case 'dbConnections':
        return Promise.resolve(SAMPLE_DB_CONNECTIONS as T);
      case 'dbMetadata': {
        const meta = SAMPLE_DB_METADATA[req.key];
        return meta ? Promise.resolve(meta as T) : Promise.reject(new Error('No existe esa conexión de base de datos.'));
      }
      default:
        return Promise.reject(new Error('unknown'));
    }
  }

  /** Respuesta simulada con retardo, cancelable con `cancel(id)`. */
  private delayed<T>(id: string, produce: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.timers.delete(id);
        try {
          resolve(produce());
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error('mock'));
        }
      }, MOCK_DELAY_MS);
      this.timers.set(id, { timer, reject });
    });
  }

  cancel(id: string): void {
    const entry = this.timers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.timers.delete(id);
    const error = new Error('cancelled');
    error.name = 'AbortError';
    entry.reject(error);
  }

  private snapshot(): ProjectSnapshot {
    const files = Object.keys(SAMPLE_FILES).filter((path) => !isSensitiveCodeFile(codeBaseName(path))).map((path) => {
      const name = codeBaseName(path);
      const extension = codeExtension(name);
      return { id: `sample:${path}`, path, name, extension, binary: isBinaryCodeExtension(extension) };
    });
    return { mounts: [{ id: '', name: 'sample', alias: 'sample', path: '' }], files };
  }
}
