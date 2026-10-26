import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';
import { BridgeToast, NexoBridge } from './bridge/nexo-bridge';
import { HostToWebview } from './bridge/protocol';
import { NexoConfigService } from './project/nexo-config.service';
import { NexoProjectService } from './project/nexo-project.service';
import { SAMPLE_PROPOSALS } from './sample/sample-changes';
import { SAMPLE_FILES, SAMPLE_FLOW } from './sample/sample-project';
import { SAMPLE_LOGS } from './sample/sample-logs';
import { FlowDiagram } from './workspace-code/ai/nexo-ia.types';
import { sanitizeFlowDiagram } from './workspace-code/ai/workspace-code-flow-sanitize';
import { WorkspaceCodeI18nService } from './workspace-code/i18n/workspace-code-i18n.service';
import { WorkspaceCodeAiChangeService } from './workspace-code/services/workspace-code-ai-change.service';
import { WorkspaceCodeAiFlowService } from './workspace-code/services/workspace-code-ai-flow.service';
import { WorkspaceCodeNotifyService } from './workspace-code/services/workspace-code-notify.service';

const TOAST_MS = 2500;

/** Raíz de la webview: recibe los mensajes del host y abre el flujo en `app-workspace-code-ai-flow`. */
@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css'],
})
export class AppComponent implements OnInit, OnDestroy {
  toasts: BridgeToast[] = [];
  private readonly sub = new Subscription();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Cola de mensajes: cada uno espera a que termine el anterior (abrir flujo, recargar archivos…). */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private bridge: NexoBridge,
    private project: NexoProjectService,
    private config: NexoConfigService,
    private i18n: WorkspaceCodeI18nService,
    private flowService: WorkspaceCodeAiFlowService,
    /** Registra `changeLookup` en el servicio del flujo (habilita «Simular cambios»). */
    private changes: WorkspaceCodeAiChangeService,
    private notify: WorkspaceCodeNotifyService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.sub.add(this.bridge.messages$.subscribe((msg) => {
      this.queue = this.queue.then(() => this.handle(msg)).catch((error: unknown) => {
        console.warn('[Traza] No se pudo procesar el mensaje del host.', error instanceof Error ? error.name : '');
      });
    }));
    this.sub.add(this.bridge.toast$.subscribe((toast) => this.showToast(toast)));
    this.bridge.post({ type: 'ready' });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  trackToast = (_: number, toast: BridgeToast) => toast.id;

  private async handle(msg: HostToWebview): Promise<void> {
    switch (msg.type) {
      case 'init':
      case 'config':
        this.i18n.setLanguage(msg.language);
        this.config.setModelName(msg.modelName);
        this.config.setTheme(msg.theme);
        this.cdr.markForCheck();
        return;
      case 'openFlow': {
        if (msg.sample) this.project.useSample(SAMPLE_FILES);
        else await this.project.loadFromHost();
        const mode = msg.mode === 'sim' || msg.mode === 'logs' ? msg.mode : 'walk';
        const step = typeof msg.step === 'number' && Number.isInteger(msg.step) && msg.step >= 0 ? msg.step : 0;
        // El host no conoce el ejemplo: con `sample` y sin flujo se abre el de la webview.
        const flow = msg.sample ? (msg.flow ?? SAMPLE_FLOW) : msg.flow;
        const proposals = msg.sample ? (msg.proposals?.length ? msg.proposals : SAMPLE_PROPOSALS) : (msg.proposals ?? []);
        // Primero el modo base; «Base de datos» y «Simular cambios» se activan cuando las propuestas ya están cargadas.
        // Flujo recién generado por la IA con escenario: se abre en «Simular» con el resultado reproducido.
        const scenario = !msg.sample && !!msg.source && !msg.mode && !!flow && typeof flow === 'object' && !Array.isArray(flow)
          && !!(flow as { scenario?: unknown }).scenario;
        if (msg.mode === 'changes') {
          // Petición de cambio: las propuestas se cargan antes de abrir para entrar directo en «Simular cambios»
          // (sin pasar por «Recorrido») y la comparación antes/después se lanza sola.
          const candidate = sanitizeFlowDiagram(flow, true);
          if (candidate) await this.changes.load(proposals, candidate, false);
          const opened = await this.flowService.open(flow, step, 'changes');
          if (!opened) {
            this.notify.show('El JSON no es un flujo válido', 'danger');
            return;
          }
          this.flowService.refreshChange();
          this.flowService.autoCompareActiveChange();
          return;
        }
        const ok = scenario && msg.source
          ? await this.flowService.openScenario(flow as FlowDiagram, { provider: 'lm', model: msg.source.model })
          : await this.flowService.open(flow, step, mode);
        if (!ok) {
          this.notify.show('El JSON no es un flujo válido', 'danger');
          return;
        }
        await this.changes.load(proposals, this.flowService.flow);
        if (msg.mode === 'db') this.flowService.setMode(msg.mode);
        // Modo navegador: los logs de ejemplo quedan precargados en «Analizar logs».
        if (this.bridge.isMock && msg.sample && !this.flowService.ui.logsInput) this.flowService.setLogsInput(SAMPLE_LOGS);
        return;
      }
      case 'filesChanged':
        if (this.project.sample) return;
        await this.project.loadFromHost();
        await this.flowService.revalidate();
        return;
      case 'fileSaved':
        if (this.project.sample) return;
        await this.flowService.revalidate();
        return;
      default:
        return;
    }
  }

  private showToast(toast: BridgeToast): void {
    this.toasts = [...this.toasts.slice(-2), toast];
    this.cdr.markForCheck();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.toasts = this.toasts.filter((t) => t.id !== toast.id);
      this.cdr.markForCheck();
    }, TOAST_MS);
    this.timers.add(timer);
  }
}
