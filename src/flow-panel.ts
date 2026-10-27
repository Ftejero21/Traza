import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { BridgeRequest, HostToWebview, NexoLanguage, NexoTheme, NotifyLevel } from '../webview/src/app/bridge/protocol';
import type { GeneratedFlow, HostAi } from './host-ai';
import { HostDb } from './host-db';
import { applyFiles, listFiles, openRef, readFile, readMountFile } from './host-files';
import { guardMessage } from './host-guards';

/** Carpeta del build de la webview (constante única; `outputPath.browser: ""` en `webview/angular.json`). */
const WEBVIEW_DIST = ['dist', 'webview'];
const FILES_DEBOUNCE_MS = 500;
const MAX_PROPOSALS = 10;

export interface FlowPayload {
  flow: unknown;
  sample: boolean;
  title: string;
  /** Propuestas de cambio que acompañan al flujo (habilitan «Simular cambios»). */
  proposals: unknown[];
  /** Flujo recién generado con el modelo de VS Code (su escenario, si lo trae, se abre en «Simular»). */
  source?: { model: string | null };
  mode?: 'walk' | 'sim' | 'logs' | 'db' | 'changes';
}

function viewConfig(): { language: NexoLanguage; modelName: string | null; theme: NexoTheme } {
  const config = vscode.workspace.getConfiguration('traza');
  const language = config.get<string>('language') === 'en' ? 'en' : 'es';
  const theme: NexoTheme = config.get<string>('theme') === 'vscode' ? 'vscode' : 'traza';
  const raw = config.get<unknown>('model');
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = (key: string): string | null => (typeof o[key] === 'string' && (o[key] as string).trim() ? (o[key] as string).trim().slice(0, 120) : null);
  return { language, modelName: pick('id') ?? pick('family'), theme };
}

function openFlowMessage(payload: FlowPayload): HostToWebview {
  return {
    type: 'openFlow', flow: payload.flow, sample: payload.sample, proposals: payload.proposals,
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.mode ? { mode: payload.mode } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : 'Error inesperado.';
}

/** Panel único «Flujo · <título>» con la webview Angular. */
export class FlowPanel {
  private static current: FlowPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly db: HostDb;
  private readonly inFlight = new Set<string>();
  private payload: FlowPayload;
  private ready = false;
  private queue: HostToWebview[] = [];
  private filesTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  static show(context: vscode.ExtensionContext, ai: HostAi, payload: FlowPayload): void {
    const title = `Flujo · ${payload.title}`;
    const existing = FlowPanel.current;
    if (existing) {
      existing.payload = payload;
      existing.panel.title = title;
      existing.panel.reveal(undefined, false);
      existing.post(openFlowMessage(payload));
      return;
    }
    const distUri = vscode.Uri.joinPath(context.extensionUri, ...WEBVIEW_DIST);
    const panel = vscode.window.createWebviewPanel('trazaFlow', title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [distUri],
    });
    FlowPanel.current = new FlowPanel(panel, ai, distUri, payload);
    FlowPanel.current.post(openFlowMessage(payload));
  }

  /**
   * Abre un flujo generado: con escenario se abre el escenario (sin `mode`); si se pidió un escenario y el modelo no lo
   * devolvió, en «Simular»; en otro caso, «Recorrido».
   */
  static showGenerated(context: vscode.ExtensionContext, ai: HostAi, generated: GeneratedFlow): void {
    const hasScenario = !!generated.flow['scenario'];
    FlowPanel.show(context, ai, {
      flow: generated.flow, sample: false, title: generated.title, proposals: [], source: { model: generated.model },
      ...(generated.scenarioAsked && !hasScenario ? { mode: 'sim' as const } : {}),
    });
  }

  /** Flujo abierto en el panel (sin el de ejemplo) y sus propuestas; `null` si no hay panel o es el ejemplo. */
  static currentFlow(): { flow: unknown; title: string; proposals: unknown[] } | null {
    const current = FlowPanel.current;
    if (!current || current.payload.sample || !current.payload.flow) return null;
    return { flow: current.payload.flow, title: current.payload.title, proposals: [...current.payload.proposals] };
  }

  /** Añade una propuesta al flujo abierto y abre «Simular cambios» (re-envía `openFlow` con las acumuladas, máx. 10). */
  static addProposal(proposal: unknown): boolean {
    const current = FlowPanel.current;
    if (!current || current.payload.sample || !current.payload.flow) return false;
    const proposalFlowId = proposal && typeof proposal === 'object' ? (proposal as { flowId?: unknown }).flowId : undefined;
    const flowObj = current.payload.flow;
    const panelFlowId = flowObj && typeof flowObj === 'object' ? (flowObj as { id?: unknown }).id : undefined;
    if (typeof proposalFlowId === 'string' && typeof panelFlowId === 'string' && proposalFlowId !== panelFlowId) return false;
    const proposals = [...current.payload.proposals, proposal].slice(-MAX_PROPOSALS);
    current.payload = { ...current.payload, proposals, mode: 'changes' };
    current.panel.reveal(undefined, false);
    current.post(openFlowMessage(current.payload));
    return true;
  }

  /** Limpia la caché de metadata de base de datos del panel abierto (contraseña o conexiones cambiadas). */
  static clearDbCache(): void {
    FlowPanel.current?.db.clearCache();
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly ai: HostAi, private readonly distUri: vscode.Uri, payload: FlowPayload) {
    this.payload = payload;
    this.db = new HostDb(ai.secrets);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message), null, this.disposables);
    const filesChanged = () => this.scheduleFilesChanged();
    this.disposables.push(
      vscode.workspace.onDidCreateFiles(filesChanged),
      vscode.workspace.onDidDeleteFiles(filesChanged),
      vscode.workspace.onDidRenameFiles(filesChanged),
      vscode.workspace.onDidChangeWorkspaceFolders(filesChanged),
      vscode.workspace.onDidSaveTextDocument(() => this.post({ type: 'fileSaved' })),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('traza.databases')) this.db.clearCache();
        if (event.affectsConfiguration('traza')) this.post({ type: 'config', ...viewConfig() });
      }),
    );
    void this.loadHtml();
  }

  /** Envía un mensaje a la webview; hasta que avisa con `ready` se encola. */
  private post(message: HostToWebview): void {
    if (this.disposed) return;
    if (!this.ready) {
      // Solo interesa el último flujo pedido y no se duplican avisos de archivos.
      if (message.type === 'openFlow') this.queue = this.queue.filter((m) => m.type !== 'openFlow');
      if ((message.type === 'filesChanged' || message.type === 'fileSaved') && this.queue.some((m) => m.type === message.type)) return;
      this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message).then(undefined, (error: unknown) => {
      console.warn('[Traza] No se pudo enviar el mensaje a la webview.', error instanceof Error ? error.name : '');
    });
  }

  private scheduleFilesChanged(): void {
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => {
      this.filesTimer = null;
      this.post({ type: 'filesChanged' });
    }, FILES_DEBOUNCE_MS);
  }

  private async loadHtml(): Promise<void> {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    let html: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.distUri, 'index.html'));
      html = new TextDecoder('utf-8').decode(bytes);
    } catch (error: unknown) {
      console.warn('[Traza] No se encontró el build de la webview.', error instanceof Error ? error.name : '');
      const csp = `default-src 'none'; style-src 'unsafe-inline';`;
      html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>`
        + `<body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px;">`
        + `<p>${escapeHtml('No se encontró la webview compilada. Ejecuta npm run build en la carpeta de la extensión.')}</p></body></html>`;
      if (!this.disposed) webview.html = html;
      return;
    }
    const source = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `img-src ${source} data: blob:`,
      `font-src ${source} data:`,
      `style-src ${source} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${source}`,
      `frame-src ${source} data: blob:`,
      `connect-src 'none'`,
    ].join('; ') + ';';
    const base = `${webview.asWebviewUri(this.distUri).toString().replace(/\/+$/, '')}/`;
    html = html.replace(/<base href="[^"]*"\s*\/?>/i, `<base href="${base}">`);
    html = html.replace(/<head>/i, `<head>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
    html = html.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
    if (!this.disposed) webview.html = html;
  }

  private onMessage(raw: unknown): void {
    const message = guardMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'init', ...viewConfig() });
        for (const queued of this.queue.splice(0)) this.post(queued);
        return;
      case 'request':
        void this.handleRequest(message.id, message.req);
        return;
      case 'cancel':
        this.ai.cancel(message.id);
        return;
      case 'openRef':
        void openRef(message.fileId, message.line, message.sample);
        return;
      case 'notify':
        this.notify(message.level, message.text);
        return;
      case 'ask':
        void this.ask(message.text);
        return;
      case 'saveDbMap': {
        this.ai.rememberDbMap(message.flowId, message.dbMap);
        const flow = this.payload.flow;
        if (!this.payload.sample && flow && typeof flow === 'object' && !Array.isArray(flow) && (flow as { id?: unknown }).id === message.flowId) {
          this.payload = { ...this.payload, flow: { ...(flow as Record<string, unknown>), dbMap: message.dbMap } };
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleRequest(id: string, req: BridgeRequest): Promise<void> {
    this.inFlight.add(id);
    try {
      let result: unknown;
      switch (req.op) {
        case 'listFiles':
          result = await listFiles();
          break;
        case 'readFile':
          result = await readFile(req.fileId, req.as, req.maxBytes);
          break;
        case 'readMountFile':
          result = await readMountFile(req.mountId, req.path, req.as, req.maxBytes);
          break;
        case 'flow':
          result = await this.ai.flowRequest(id, req.kind, req.body, (message) => this.post({ type: 'progress', id, message }));
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(req.text);
          result = true;
          break;
        case 'compareChange':
          result = await this.ai.compareChange(id, req.proposalId, req.body);
          break;
        case 'dbExplain':
          result = await this.ai.dbExplain(id, req.body);
          break;
        case 'applyFiles':
          result = await applyFiles(req.writes);
          break;
        case 'confirm': {
          const choice = await vscode.window.showWarningMessage(req.title || req.message, { modal: true, ...(req.title ? { detail: req.message } : {}) }, req.confirm);
          result = choice === req.confirm;
          break;
        }
        case 'dbConnections':
          result = await this.db.list();
          break;
        case 'dbMetadata':
          result = await this.db.metadata(req.key);
          break;
        default:
          throw new Error('Operación no permitida.');
      }
      this.post({ type: 'response', id, ok: true, result });
    } catch (error: unknown) {
      this.post({ type: 'response', id, ok: false, error: errorText(error) });
    } finally {
      this.inFlight.delete(id);
    }
  }

  private notify(level: NotifyLevel, text: string): void {
    if (level === 'danger') void vscode.window.showErrorMessage(text);
    else if (level === 'warning') void vscode.window.showWarningMessage(text);
    else void vscode.window.showInformationMessage(text);
  }

  /** «Preguntar a la IA»: abre el chat de VS Code con la pregunta; si no se puede, la copia al portapapeles. */
  private async ask(text: string): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: text });
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo abrir el chat.', error instanceof Error ? error.name : '');
      try {
        await vscode.env.clipboard.writeText(text);
        void vscode.window.showInformationMessage('No se pudo abrir el chat; la pregunta se ha copiado al portapapeles.');
      } catch (copyError: unknown) {
        console.warn('[Traza] No se pudo copiar la pregunta.', copyError instanceof Error ? copyError.name : '');
        void vscode.window.showWarningMessage('No se pudo abrir el chat ni copiar la pregunta.');
      }
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (FlowPanel.current === this) FlowPanel.current = undefined;
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = null;
    this.ai.cancelAll(this.inFlight);
    this.inFlight.clear();
    this.queue = [];
    while (this.disposables.length) {
      const item = this.disposables.pop();
      try {
        item?.dispose();
      } catch (error: unknown) {
        console.warn('[Traza] No se pudo liberar un recurso.', error instanceof Error ? error.name : '');
      }
    }
  }
}
