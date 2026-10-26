import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  CodeRef,
  FlowDbAccess,
  FlowDiagram,
  FlowLane,
  FlowLaneKind,
  FlowMode,
  FlowRowState,
  FlowStep,
  LogAnalysisResult,
  LogEvidence,
  ResultKind,
  SimulationPreset,
  SimulationResult,
} from '../ai/nexo-ia.types';
import { functionLabel, isDecoratorFunctionName, refSymbolLabel } from '../ai/workspace-code-flow-ref-validator';
import { FlowStatusPill, WorkspaceCodeAiFlowService } from '../services/workspace-code-ai-flow.service';
import { UiScreenView, UiViewportId, WorkspaceCodeAiUiPreviewService } from '../services/workspace-code-ai-ui-preview.service';
import { WorkspaceCodeNotifyService } from '../services/workspace-code-notify.service';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { NexoBridge } from '../../bridge/nexo-bridge';

const NARROW_WIDTH = 600;
/** Casos predefinidos visibles con la lista recogida (ancho / estrecho). */
const PRESETS_COLLAPSED_WIDE = 6;
const PRESETS_COLLAPSED_NARROW = 4;
const LAB_MIN = 120;
const DIAGRAM_MIN = 80;
/** Vista de pantalla: ancho del popup en carga/error, margen lateral, alto mínimo libre encima y separación con la fila. */
const PREVIEW_WIDTH = 300;
const PREVIEW_GUTTER = 8;
const PREVIEW_MIN_TOP = 44;
const PREVIEW_GAP = 6;
/** Miniatura: margen interior del popup (11 + 11) y alto mínimo/máximo. */
const THUMB_INSET = 22;
const THUMB_MIN_H = 140;
const THUMB_MAX_H = 280;
/** Vista ampliada: escala mínima en «Ajustar» y máxima (nunca se amplía por encima del 100 %). */
const ZOOM_MIN_SCALE = 0.1;
const ZOOM_MAX_SCALE = 1;
/** Menú de acciones del paso: espera antes de cerrarse al salir del número o del panel. */
const STEP_MENU_CLOSE_MS = 160;

type PreviewScroll = 'none' | 'ifHidden' | 'force';

interface ArrowGeometry {
  self: boolean;
  /** Posición en % del carril (llamada interna) o del extremo izquierdo de la flecha. */
  left: number;
  width: number;
  reverse: boolean;
  /** Texto de la llamada interna a la izquierda (carril en la mitad derecha). */
  textLeft: boolean;
}

const LANE_ICONS: Record<FlowLaneKind, string> = {
  ui: 'bi-window', component: 'bi-puzzle', service: 'bi-gear', api: 'bi-hdd-network', db: 'bi-database',
  queue: 'bi-inboxes', external: 'bi-cloud', other: 'bi-box',
};

/**
 * Pestaña «Flujo · <título>» de Nexo IA: diagrama de secuencia animado con tres modos (Recorrido, Simular datos y
 * Analizar logs) y el validador inferior. Copia de chatFront adaptada a la extensión (portapapeles por el host). El estado vive en `WorkspaceCodeAiFlowService`; aquí solo se pinta.
 */
@Component({
  selector: 'app-workspace-code-ai-flow',
  templateUrl: './workspace-code-ai-flow.component.html',
  styleUrls: ['../workspace-code-ai-scroll.css', './workspace-code-ai-flow.component.css'],
})
export class WorkspaceCodeAiFlowComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('root') root?: ElementRef<HTMLDivElement>;
  @ViewChild('main') main?: ElementRef<HTMLDivElement>;
  @ViewChild('lab') lab?: ElementRef<HTMLDivElement>;
  @ViewChild('detail') detail?: ElementRef<HTMLElement>;
  @ViewChild('diagram') diagram?: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') canvas?: ElementRef<HTMLDivElement>;
  @ViewChild('uiPreview') uiPreview?: ElementRef<HTMLElement>;
  @ViewChild('uiFrame') uiFrame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('uiThumb') uiThumb?: ElementRef<HTMLDivElement>;
  @ViewChild('uiZoomFrame') uiZoomFrame?: ElementRef<HTMLIFrameElement>;
  @ViewChild('uiZoomBody') uiZoomBody?: ElementRef<HTMLDivElement>;
  @ViewChild('uiZoomStage') uiZoomStage?: ElementRef<HTMLDivElement>;
  @ViewChild('uiZoomFold') uiZoomFold?: ElementRef<HTMLDivElement>;
  @ViewChild('uiZoomMeta') uiZoomMeta?: ElementRef<HTMLSpanElement>;

  /** Modo de escala de la vista ampliada: ajustada al espacio disponible o tamaño real. */
  zoomFit: 'fit' | 'actual' = 'fit';
  private zoomWasOpen = false;

  narrow = false;
  /** Casos predefinidos: lista completa (true) o recogida con «+N más». */
  presetsExpanded = false;

  private get presetLimit(): number {
    return this.narrow ? PRESETS_COLLAPSED_NARROW : PRESETS_COLLAPSED_WIDE;
  }

  visiblePresets(list: SimulationPreset[]): SimulationPreset[] {
    const limit = this.presetLimit;
    if (this.presetsExpanded || list.length <= limit) return list;
    return list.filter((p: SimulationPreset, i: number) => i < limit || p.id === this.flowService.ui.simPreset);
  }

  hiddenPresetCount(list: SimulationPreset[]): number {
    return list.length - this.visiblePresets(list).length;
  }

  hasPresetOverflow(list: SimulationPreset[]): boolean {
    return list.length > this.presetLimit;
  }

  togglePresets(): void {
    this.presetsExpanded = !this.presetsExpanded;
  }

  trackPreset(_: number, p: SimulationPreset): string {
    return p.id;
  }
  /** Paso con el menú de acciones abierto (`null` = ninguno). */
  stepMenu: number | null = null;
  private stepMenuTimer: ReturnType<typeof setTimeout> | null = null;
  private stepMenuRaf: number | null = null;
  private stepMenuRetry: ReturnType<typeof setTimeout> | null = null;
  readonly speeds: (0.5 | 1 | 2)[] = [0.5, 1, 2];
  private readonly baseModes: { id: FlowMode; icon: string; key: string }[] = [
    { id: 'walk', icon: 'bi-play-circle', key: 'aiFlow.mode.walk' },
    { id: 'sim', icon: 'bi-braces', key: 'aiFlow.mode.sim' },
    { id: 'logs', icon: 'bi-terminal', key: 'aiFlow.mode.logs' },
  ];
  /** Vista de pantalla (fase 2): «Visualizar pantalla» en el menú del paso y en la tarjeta de resultado. */
  readonly previewEnabled = true;

  private readonly changesMode: { id: FlowMode; icon: string; key: string } = { id: 'changes', icon: 'bi-arrow-left-right', key: 'aiFlow.mode.changes' };
  private readonly dbMode: { id: FlowMode; icon: string; key: string } = { id: 'db', icon: 'bi-database', key: 'aiFlow.mode.db' };
  private readonly modeLists = new Map<string, { id: FlowMode; icon: string; key: string }[]>();

  /**
   * «Base de datos» solo aparece si el flujo toca la base de datos (después de «Analizar logs»); «Simular cambios», con una
   * propuesta `pending`/`applied` del flujo abierto, siempre al final.
   */
  get modes(): { id: FlowMode; icon: string; key: string }[] {
    const db = this.flowService.hasDb;
    const changes = !!this.flowService.activeChange;
    const key = `${db}|${changes}`;
    let list = this.modeLists.get(key);
    if (!list) {
      list = [...this.baseModes, ...(db ? [this.dbMode] : []), ...(changes ? [this.changesMode] : [])];
      this.modeLists.set(key, list);
    }
    return list;
  }

  private readonly sub = new Subscription();
  private resizeObserver: ResizeObserver | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStep = -1;
  private dragOrigin: { top: number; bottom: number; height: number } | null = null;
  private destroyed = false;
  /** Vista previa: temporizador de la colocación, scroll pendiente y resultado mostrado la última vez. */
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Estilos inline previos del diagrama mientras está ampliado para que quepa el popup. */
  private diagramSavedStyle: {
    minHeight: string;
    panel: HTMLElement | null;
    panelFlexShrink: string;
    panelMinHeight: string;
  } | null = null;
  /** Lado del popup en la última colocación (se conserva mientras siga cabiendo, para evitar saltos). */
  private previewSide: 'above' | 'below' | null = null;
  private previewSideKey: string | null = null;
  /** Observa popup, diagrama y `#main`: su tamaño cambia sin que cambie el de `root`. */
  private previewObserver: ResizeObserver | null = null;
  private observedNodes: Element[] = [];
  private previewScroll: PreviewScroll = 'none';
  private previewKey: object | null = null;
  /** Geometría del popup en la última colocación: solo se desplaza el scroll cuando cambia. */
  private previewGeomKey: string | null = null;

  constructor(
    public flowService: WorkspaceCodeAiFlowService,
    public preview: WorkspaceCodeAiUiPreviewService,
    private notify: WorkspaceCodeNotifyService,
    private i18n: WorkspaceCodeI18nService,
    private bridge: NexoBridge,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {}

  ngOnInit(): void {
    this.flowService.labMeasure = () => {
      const el = this.lab?.nativeElement;
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    this.sub.add(this.flowService.changed$.subscribe(() => {
      if (this.destroyed) return;
      this.cdr.markForCheck();
      if (this.flowService.ui.step !== this.lastStep) {
        this.lastStep = this.flowService.ui.step;
        // Solo cuando avanza la reproducción: tras un clic, la fila bajo el cursor no se mueve.
        if (this.flowService.player.lastChange === 'auto') this.scheduleScroll();
      }
      this.syncPreview();
    }));
    this.sub.add(this.preview.changed$.subscribe(() => {
      if (this.destroyed) return;
      this.cdr.markForCheck();
      this.schedulePreviewLayout();
    }));
    this.sub.add(this.preview.reveal$.subscribe(() => {
      if (this.destroyed) return;
      this.cdr.markForCheck();
      this.schedulePreviewLayout('force');
    }));
    this.syncPreview();
  }

  ngAfterViewInit(): void {
    const root = this.root?.nativeElement;
    if (!root) return;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        this.schedulePreviewLayout();
        const width = entries[0]?.contentRect.width ?? root.clientWidth;
        const narrow = width > 0 && width < NARROW_WIDTH;
        if (narrow === this.narrow) return;
        this.zone.run(() => {
          this.narrow = narrow;
          this.cdr.markForCheck();
        });
      });
      this.resizeObserver.observe(root);
    }
    setTimeout(() => {
      if (!this.destroyed) root.focus({ preventScroll: true });
    });
    this.schedulePreviewLayout();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    // Al ocultar la página el reproductor se pausa; el estado del flujo sobrevive en el servicio.
    this.flowService.player.pause();
    this.flowService.labMeasure = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.previewObserver?.disconnect();
    this.previewObserver = null;
    this.observedNodes = [];
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = null;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = null;
    if (this.stepMenuTimer) clearTimeout(this.stepMenuTimer);
    this.stepMenuTimer = null;
    this.cancelStepMenuPlacement();
    this.restoreDiagramHeight();
    this.endDrag();
    this.sub.unsubscribe();
  }

  /* ---------------------------- datos ---------------------------- */

  get flow(): FlowDiagram | null {
    return this.flowService.flow;
  }

  get step(): number {
    return this.flowService.player.step;
  }

  get current(): FlowStep | null {
    return this.flow?.steps[this.step] ?? null;
  }

  get result(): SimulationResult | LogAnalysisResult | null {
    return this.flowService.result;
  }

  /** Modo «Base de datos»: acceso a datos del paso actual (`null` si no accede). */
  get currentAccess(): FlowDbAccess | null {
    return this.flowService.ui.mode === 'db' ? this.flowService.dbAccess(this.step) : null;
  }

  /** Modo «Base de datos»: posición del paso actual dentro del guion conducido (solo pasos con acceso). */
  get dbFlowIndex(): number {
    return Math.max(0, this.flowService.dbView?.indexes.indexOf(this.step) ?? 0);
  }

  private allIndexes: number[] = [];

  /** Índices de los segmentos del pie: las paradas del reproductor o todos los pasos. */
  get segmentIndexes(): number[] {
    const stops = this.flowService.player.stops;
    if (stops) return stops;
    const n = this.flow?.steps.length ?? 0;
    if (this.allIndexes.length !== n) this.allIndexes = Array.from({ length: n }, (_, i) => i);
    return this.allIndexes;
  }

  /** Columnas del acceso con su valor del flujo (`col ← valor`). */
  accessColumns(access: FlowDbAccess): { column: string; value: string | null }[] {
    const values = access.values ?? {};
    const columns = [...new Set([...access.columns, ...Object.keys(values)])];
    return columns.map((column) => ({ column, value: values[column] ?? null }));
  }

  get logsResult():LogAnalysisResult | null {
    return this.flowService.ui.mode === 'logs' ? this.flowService.ui.logsResult : null;
  }

  get pill(): FlowStatusPill {
    return this.flowService.statusPill();
  }

  get fileCount(): number {
    const flow = this.flow;
    if (!flow) return 0;
    const files = new Set<string>();
    for (const ref of flow.files) files.add(ref.file);
    for (const step of flow.steps) if (step.ref) files.add(step.ref.file);
    return files.size;
  }

  /** Factor de tiempo de las animaciones del diagrama (`1 / velocidad`). */
  get timeFactor(): string {
    return String(1 / this.flowService.player.speed);
  }

  /** Selección manual de un paso: el índice sale de `data-step` del elemento pulsado (nunca de una clausura). */
  onStep(event: Event): void {
    const index = Number((event.currentTarget as HTMLElement | null)?.dataset['step']);
    if (!Number.isInteger(index)) return;
    this.flowService.selectStep(index);
  }

  laneX(lane: string | number): number {
    const flow = this.flow;
    if (!flow || !flow.lanes.length) return 50;
    const index = typeof lane === 'number' ? lane : Math.max(0, flow.lanes.findIndex((l) => l.id === lane));
    return ((index + 0.5) / flow.lanes.length) * 100;
  }

  laneIcon(lane: FlowLane): string {
    return LANE_ICONS[lane.kind] ?? LANE_ICONS.other;
  }

  laneName(id: string): string {
    const lane = this.flow?.lanes.find((l) => l.id === id);
    return lane ? lane.name : id;
  }

  laneTone(lane: FlowLane): string | null {
    return this.flowService.laneHighlight(lane.id);
  }

  arrow(step: FlowStep): ArrowGeometry {
    const from = this.laneX(step.from);
    const to = this.laneX(step.to);
    if (step.from === step.to) return { self: true, left: from, width: 0, reverse: false, textLeft: from > 50 };
    return { self: false, left: Math.min(from, to), width: Math.abs(to - from), reverse: to < from, textLeft: false };
  }

  rowState(index: number): FlowRowState {
    return this.flowService.rowState(index);
  }

  inLogs(index: number): boolean {
    return this.flowService.inLogs(index);
  }

  /** `nombre()` o `@Decorador` (sin paréntesis). */
  fnLabel(fn: string): string {
    return functionLabel(fn);
  }

  /** `Clase.función()` o `Clase @Decorador`. */
  refSymbol(ref: CodeRef): string {
    return refSymbolLabel(ref);
  }

  isDeco(fn: string): boolean {
    return isDecoratorFunctionName(fn);
  }

  refLabel(ref: CodeRef | null, withFile = false): string {
    if (!ref) return '';
    const fn = refSymbolLabel(ref);
    if (!withFile) return `${fn} · L${ref.line}`;
    const file = ref.file.slice(ref.file.lastIndexOf('/') + 1);
    return `${fn} · ${file}:${ref.line}`;
  }

  /** Texto bajo la flecha: `Clase.función() · Lnn`, o el badge real en el paso que falla. */
  subLine(step: FlowStep, index: number): string {
    const state = this.rowState(index);
    const r = this.result;
    if ((state === 'fail' || state === 'stop') && r) {
      const ref = r.where ?? step.ref;
      return [r.badge, this.refLabel(ref, true)].filter(Boolean).join(' · ');
    }
    return this.refLabel(step.ref);
  }

  stepNumberText(index: number): string {
    const state = this.rowState(index);
    return state === 'fail' ? '!' : String(index + 1);
  }

  /* ---------------------------- resultado ---------------------------- */

  badgeIcon(kind: ResultKind): string {
    return kind === 'error' ? 'bi-x-octagon-fill' : kind === 'stop' ? 'bi-pause-circle-fill' : kind === 'ok' ? 'bi-check-circle-fill' : 'bi-question-circle';
  }

  resultStepIndex(): number {
    const r = this.result;
    const flow = this.flow;
    if (!r || !flow || !r.failStepId) return -1;
    return flow.steps.findIndex((s) => s.id === r.failStepId);
  }

  resultTone(): 'danger' | 'warning' | 'accent' {
    const kind = this.result?.kind;
    return kind === 'error' ? 'danger' : kind === 'stop' ? 'warning' : 'accent';
  }

  evidenceStep(e: LogEvidence): number {
    if (!e.stepId || !this.flow) return -1;
    return this.flow.steps.findIndex((s) => s.id === e.stepId);
  }

  get running(): boolean {
    return !!this.result && !this.flowService.ui.resultVisible;
  }

  get runTotal(): number {
    const fail = this.resultStepIndex();
    return fail >= 0 ? fail + 1 : this.flow?.steps.length ?? 0;
  }

  /* ---------------------------- menú de acciones del paso ---------------------------- */

  openStepMenu(index: number): void {
    this.cancelStepMenuClose();
    if (this.stepMenu === index) return;
    this.cancelStepMenuPlacement();
    this.stepMenu = index;
    this.cdr.markForCheck();
    this.zone.runOutsideAngular(() => {
      this.stepMenuRaf = requestAnimationFrame(() => {
        this.stepMenuRaf = null;
        if (this.destroyed || this.stepMenu !== index) return;
        if (!this.placeStepMenu(index)) {
          this.stepMenuRetry = setTimeout(() => {
            this.stepMenuRetry = null;
            if (!this.destroyed && this.stepMenu === index) this.placeStepMenu(index);
          }, 0);
        }
      });
    });
  }

  private cancelStepMenuPlacement(): void {
    if (this.stepMenuRaf !== null) cancelAnimationFrame(this.stepMenuRaf);
    this.stepMenuRaf = null;
    if (this.stepMenuRetry) clearTimeout(this.stepMenuRetry);
    this.stepMenuRetry = null;
  }

  /**
   * Coloca el menú del paso en el espacio visible del diagrama (debajo de la fila; si no cabe, encima; si no, ajustado
   * al área visible) para que `.wcf__diagram{overflow:auto}` no lo recorte. `false` si aún no está en el DOM.
   */
  private placeStepMenu(index: number): boolean {
    const canvas = this.canvas?.nativeElement;
    const row = canvas?.querySelector<HTMLElement>(`.wcf-row[data-step="${index}"]`);
    const menu = row?.querySelector<HTMLElement>('.wcf-stepmenu');
    if (!row || !menu) return false;
    menu.style.top = '';
    menu.style.maxHeight = '';
    menu.style.bottom = 'auto';
    const vis = this.diagramVisibleRect();
    if (vis) {
      const rRect = row.getBoundingClientRect();
      const visTop = vis.top - rRect.top + 4;
      const visBottom = vis.bottom - rRect.top - 4;
      const h = menu.offsetHeight;
      const rowH = row.offsetHeight;
      let top: number;
      if (6 + h <= visBottom) top = 6;
      else if (rowH - 6 - h >= visTop) top = rowH - 6 - h;
      else top = Math.max(visTop, Math.min(6, visBottom - h));
      if (h > visBottom - visTop) {
        menu.style.maxHeight = `${Math.max(0, Math.floor(visBottom - visTop))}px`;
        top = visTop;
      }
      menu.style.top = `${Math.round(top)}px`;
    }
    menu.classList.add('is-placed');
    return true;
  }

  scheduleStepMenuClose(): void {
    this.cancelStepMenuClose();
    this.stepMenuTimer = setTimeout(() => {
      this.stepMenuTimer = null;
      if (this.destroyed || this.stepMenu === null) return;
      this.cancelStepMenuPlacement();
      this.stepMenu = null;
      this.cdr.markForCheck();
    }, STEP_MENU_CLOSE_MS);
  }

  cancelStepMenuClose(): void {
    if (this.stepMenuTimer) clearTimeout(this.stepMenuTimer);
    this.stepMenuTimer = null;
  }

  private closeStepMenu(): void {
    this.cancelStepMenuClose();
    this.cancelStepMenuPlacement();
    this.stepMenu = null;
    this.cdr.markForCheck();
  }

  /** «Visualizar pantalla» (menú del paso ancla o botón de la tarjeta). */
  visualize(event: Event): void {
    event.stopPropagation();
    this.closeStepMenu();
    this.preview.show();
  }

  askStep(index: number): void {
    this.closeStepMenu();
    this.flowService.askAboutStep(index);
  }

  copyStep(index: number): void {
    this.closeStepMenu();
    const text = this.flowService.stepReference(index);
    const fail = (error?: unknown): void => {
      if (error !== undefined) console.warn('[Nexo IA] No se pudo copiar la referencia.', error instanceof Error ? error.name : '');
      this.notify.show(this.i18n.t('aiFlow.stepMenu.copyFailed'), 'warning');
    };
    if (!text) {
      fail();
      return;
    }
    this.bridge.request<unknown>({ op: 'copy', text: text.slice(0, 10000) }).then(
      () => this.notify.show(this.i18n.t('aiFlow.stepMenu.copied'), 'success'),
      (error: unknown) => fail(error),
    );
  }

  /* ---------------------------- vista de pantalla ---------------------------- */

  get previewView(): UiScreenView | null {
    return this.preview.view;
  }

  closePreview(): void {
    this.preview.close();
    this.root?.nativeElement.focus({ preventScroll: true });
  }

  private syncPreview(): void {
    this.preview.sync(this.flowService.screenContext());
    const key = this.preview.ctx?.key ?? null;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.restoreDiagramHeight();
    }
    this.schedulePreviewLayout();
  }

  /**
   * Asigna el `srcdoc` por `ElementRef` (sin pasar por el saneador de Angular; el iframe va con `sandbox=""`) y la
   * geometría de la miniatura: iframe al ancho del tamaño elegido escalado al popup y desplazado al encuadre (`frame.crop`).
   */
  private applyFrame(): void {
    const view = this.preview.status === 'ready' ? this.previewView : null;
    const frame = this.uiFrame?.nativeElement;
    const thumb = this.uiThumb?.nativeElement;
    const popup = this.uiPreview?.nativeElement;
    if (frame && thumb && popup) {
      const srcdoc = view?.srcdoc ?? '';
      if (frame.srcdoc !== srcdoc) frame.srcdoc = srcdoc;
      if (view) {
        const crop = view.frame.crop;
        const tw = Math.max(1, (popup.offsetWidth || PREVIEW_WIDTH) - THUMB_INSET);
        const s = view.frame.contain
          ? Math.min(1, tw / Math.max(1, crop.w), THUMB_MAX_H / Math.max(1, crop.h))
          : Math.min(1, tw / Math.max(1, crop.w));
        const th = Math.min(THUMB_MAX_H, Math.max(THUMB_MIN_H, Math.round(crop.h * s)));
        thumb.style.width = `${tw}px`;
        thumb.style.height = `${th}px`;
        frame.style.width = `${view.frame.width}px`;
        frame.style.height = `${view.frame.height}px`;
        frame.style.transform = `scale(${s})`;
        frame.style.transformOrigin = '0 0';
        // Encuadres más estrechos que la miniatura (p. ej. móvil): centrados en horizontal.
        frame.style.left = crop.w * s < tw ? `${Math.round((tw - crop.w * s) / 2 - crop.x * s)}px` : `${Math.round(-crop.x * s)}px`;
        frame.style.top = `${Math.round(-crop.y * s)}px`;
      }
    }
    const zoomFrame = this.uiZoomFrame?.nativeElement;
    if (!zoomFrame) {
      this.zoomWasOpen = false;
      return;
    }
    if (!this.zoomWasOpen) {
      this.zoomWasOpen = true;
      if (this.zoomFit !== 'fit') {
        this.zone.run(() => {
          this.zoomFit = 'fit';
          this.cdr.markForCheck();
        });
      }
    }
    const srcdoc = this.preview.zoom && view ? view.srcdoc : '';
    if (zoomFrame.srcdoc !== srcdoc) zoomFrame.srcdoc = srcdoc;
    const body = this.uiZoomBody?.nativeElement;
    const stage = this.uiZoomStage?.nativeElement;
    if (!view || !body || !stage) return;
    const w = view.frame.width;
    const vh = view.frame.viewportHeight;
    const fh = Math.max(view.frame.height, vh);
    const cs = getComputedStyle(body);
    const availW = body.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const availH = body.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    let s = ZOOM_MAX_SCALE;
    if (this.zoomFit === 'fit' && availW > 0 && availH > 0 && w > 0 && vh > 0) {
      s = Math.min(ZOOM_MAX_SCALE, Math.max(ZOOM_MIN_SCALE, Math.min(availW / w, availH / vh)));
    }
    zoomFrame.style.width = `${w}px`;
    zoomFrame.style.height = `${fh}px`;
    zoomFrame.style.transform = `scale(${s})`;
    zoomFrame.style.transformOrigin = '0 0';
    stage.style.width = `${Math.round(w * s)}px`;
    stage.style.height = `${Math.round(fh * s)}px`;
    const fold = this.uiZoomFold?.nativeElement;
    if (fold) {
      fold.hidden = fh <= vh;
      fold.style.top = `${Math.round(vh * s)}px`;
    }
    const meta = this.uiZoomMeta?.nativeElement;
    if (meta) meta.textContent = `${w} × ${vh} · ${Math.round(s * 100)} %`;
  }

  setViewport(id: UiViewportId): void {
    void this.preview.setViewport(id);
  }

  setZoomFit(mode: 'fit' | 'actual'): void {
    if (this.zoomFit === mode) return;
    this.zoomFit = mode;
    this.cdr.markForCheck();
    this.schedulePreviewLayout();
  }

  private schedulePreviewLayout(scroll: PreviewScroll = 'none'): void {
    if (scroll === 'force' || (scroll === 'ifHidden' && this.previewScroll === 'none')) this.previewScroll = scroll;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.zone.runOutsideAngular(() => {
      this.previewTimer = setTimeout(() => {
        this.previewTimer = null;
        if (this.destroyed) return;
        const mode = this.previewScroll;
        this.previewScroll = 'none';
        this.applyFrame();
        this.layoutPreview(mode);
      }, 0);
    });
  }

  /**
   * Área realmente visible del diagrama en coordenadas de viewport: su zona cliente intersecada con `#main` y con la
   * ventana. `null` si no hay diagrama o no queda nada visible.
   */
  private diagramVisibleRect(): { top: number; bottom: number; left: number; right: number } | null {
    const diagram = this.diagram?.nativeElement;
    if (!diagram) return null;
    const d = diagram.getBoundingClientRect();
    let top = d.top + diagram.clientTop;
    let bottom = top + diagram.clientHeight;
    let left = d.left + diagram.clientLeft;
    let right = left + diagram.clientWidth;
    const main = this.main?.nativeElement;
    if (main) {
      const m = main.getBoundingClientRect();
      top = Math.max(top, m.top);
      bottom = Math.min(bottom, m.bottom);
      left = Math.max(left, m.left);
      right = Math.min(right, m.right);
    }
    top = Math.max(top, 0);
    left = Math.max(left, 0);
    bottom = Math.min(bottom, window.innerHeight);
    right = Math.min(right, window.innerWidth);
    return bottom > top && right > left ? { top, bottom, left, right } : null;
  }

  /** Observa popup, diagrama y `#main` (los tres van con `*ngIf`): se re-observa cuando cambia la identidad del nodo. */
  private syncPreviewObserver(): void {
    if (typeof ResizeObserver === 'undefined') return;
    const nodes = [this.uiPreview?.nativeElement, this.diagram?.nativeElement, this.main?.nativeElement].filter(
      (n): n is HTMLElement => !!n,
    );
    if (!this.previewObserver) {
      this.zone.runOutsideAngular(() => {
        this.previewObserver = new ResizeObserver(() => this.schedulePreviewLayout());
      });
    }
    const observer = this.previewObserver;
    if (!observer) return;
    const old = this.observedNodes;
    if (nodes.length === old.length && nodes.every((n, i) => n === old[i])) return;
    for (const n of old) if (!nodes.includes(n as HTMLElement)) observer.unobserve(n);
    for (const n of nodes) if (!old.includes(n)) observer.observe(n);
    this.observedNodes = nodes;
  }

  /** Coloca el popup junto a la flecha del paso ancla (encima o debajo) y hace crecer el canvas si no cabe. */
  private layoutPreview(scroll: PreviewScroll): void {
    this.syncPreviewObserver();
    const canvas = this.canvas?.nativeElement;
    if (!canvas) return;
    const popup = this.uiPreview?.nativeElement;
    const ctx = this.preview.ctx;
    canvas.style.paddingBottom = '';
    if (!popup || !ctx || !this.preview.open || this.preview.screenStep < 0) {
      this.previewGeomKey = null;
      this.previewSide = null;
      this.previewSideKey = null;
      this.restoreDiagramHeight();
      return;
    }
    const row = canvas.querySelector<HTMLElement>(`.wcf-row[data-step="${this.preview.screenStep}"]`);
    if (!row) {
      this.previewGeomKey = null;
      this.restoreDiagramHeight();
      return;
    }
    const sideKey = `${ctx.key}|${this.preview.screenStep}`;
    if (sideKey !== this.previewSideKey) {
      this.previewSideKey = sideKey;
      this.previewSide = null;
    }
    const grew = this.fitDiagramHeight(popup);
    const target = row.querySelector<HTMLElement>('.wcf-arrow, .wcf-loop') ?? row;
    const cRect = canvas.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    const aRect = target.getBoundingClientRect();
    const width = popup.offsetWidth || PREVIEW_WIDTH;
    const height = popup.offsetHeight;
    const centerX = aRect.left + aRect.width / 2 - cRect.left;
    const maxLeft = Math.max(PREVIEW_GUTTER, canvas.clientWidth - width - PREVIEW_GUTTER);
    const left = Math.min(maxLeft, Math.max(PREVIEW_GUTTER, centerX - width / 2));
    const total = this.flow?.steps.length ?? 0;
    const rowTop = rRect.top - cRect.top;
    const rowBottom = rRect.bottom - cRect.top;
    const rowH = rRect.height;
    const aboveTop = rowTop - height - PREVIEW_GAP;
    const belowTop = rowBottom + PREVIEW_GAP;
    // Area visible real del diagrama en coordenadas del canvas: el popup debe quedar dentro.
    const vis = this.diagramVisibleRect();
    const visTop = vis ? vis.top - cRect.top : Number.NEGATIVE_INFINITY;
    const visBottom = vis ? vis.bottom - cRect.top : Number.POSITIVE_INFINITY;
    const fitsBelow = belowTop + height <= visBottom - PREVIEW_GUTTER;
    const fitsAbove = aboveTop >= Math.max(PREVIEW_MIN_TOP, visTop + PREVIEW_GUTTER);
    // En los 3 ultimos pasos se prueba primero encima; en el resto, debajo.
    const preferAbove = this.preview.screenStep >= total - 3;
    const previous = this.previewSide;
    let top: number;
    let side: 'above' | 'below' | null = null;
    let needReveal = false;
    if (previous === 'above' && fitsAbove) side = 'above';
    else if (previous === 'below' && fitsBelow) side = 'below';
    else if (preferAbove && fitsAbove) side = 'above';
    else if (fitsBelow) side = 'below';
    else if (fitsAbove) side = 'above';
    if (side) {
      top = side === 'above' ? aboveTop : belowTop;
    } else if (vis && height + rowH + PREVIEW_GAP <= visBottom - visTop - 2 * PREVIEW_GUTTER) {
      // No cabe con el scroll actual: se elige un lado y se desplaza el diagrama para verlo junto a la fila.
      const above = aboveTop >= PREVIEW_MIN_TOP && (preferAbove || rowTop - visTop > visBottom - rowBottom);
      side = above ? 'above' : 'below';
      top = above ? aboveTop : belowTop;
      needReveal = true;
    } else {
      // Ni así cabe: se encaja en el área visible (puede tapar la fila).
      const lo = visTop + PREVIEW_GUTTER;
      const hi = visBottom - PREVIEW_GUTTER - height;
      top = Math.max(PREVIEW_MIN_TOP, Math.min(Math.max(belowTop, lo), hi));
    }
    this.previewSide = side;
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
    const basePadding = parseFloat(getComputedStyle(canvas).paddingBottom) || 0;
    const extra = top + height + PREVIEW_GUTTER - canvas.offsetHeight;
    if (extra > 0) canvas.style.paddingBottom = `${Math.ceil(basePadding + extra)}px`;
    const key = `${this.preview.screenStep}|${Math.round(top)}|${Math.round(left)}|${height}|${width}`;
    const geomChanged = key !== this.previewGeomKey;
    this.previewGeomKey = key;
    let hidden = false;
    if (vis) {
      const pRect = popup.getBoundingClientRect();
      hidden = pRect.top < vis.top || pRect.bottom > vis.bottom || pRect.left < vis.left || pRect.right > vis.right;
    }
    if (grew || scroll === 'force' || ((hidden || needReveal) && (geomChanged || scroll === 'ifHidden'))) {
      this.revealInDiagram(popup, row);
    }
  }

  /**
   * Desplaza solo el área del diagrama hasta el popup (`scrollIntoView` movería también la cabecera del flujo): deja a la
   * vista popup y fila si caben juntos en el alto visible; si no, solo el popup.
   */
  private revealInDiagram(popup: HTMLElement, row: HTMLElement): void {
    const diagram = this.diagram?.nativeElement;
    const vis = this.diagramVisibleRect();
    if (!diagram || !vis) return;
    const pRect = popup.getBoundingClientRect();
    const rRect = row.getBoundingClientRect();
    const visH = vis.bottom - vis.top;
    const uTop = Math.min(pRect.top, rRect.top);
    const uBottom = Math.max(pRect.bottom, rRect.bottom);
    const both = uBottom - uTop <= visH - 2 * PREVIEW_GUTTER;
    const tTop = both ? uTop : pRect.top;
    const tBottom = both ? uBottom : pRect.bottom;
    const limitBottom = vis.bottom - PREVIEW_GUTTER;
    const limitTop = vis.top + PREVIEW_GUTTER;
    if (tBottom > limitBottom) diagram.scrollTop += Math.max(0, Math.min(tBottom - limitBottom, tTop - limitTop));
    else if (tTop < limitTop) diagram.scrollTop -= limitTop - tTop;
    const limitRight = vis.right - PREVIEW_GUTTER;
    const limitLeft = vis.left + PREVIEW_GUTTER;
    if (pRect.right > limitRight) diagram.scrollLeft += Math.max(0, Math.min(pRect.right - limitRight, pRect.left - limitLeft));
    else if (pRect.left < limitLeft) diagram.scrollLeft -= limitLeft - pRect.left;
  }

  /**
   * Si el área visible del diagrama es más baja que el popup (alto real + margen), la amplía con `min-height` inline
   * temporal (gana al `height` fijo de `changes` y al encogimiento flex de `sim`) y deja que el panel inferior encoja
   * (con su scroll interno) en vez de quedar empujado fuera de la vista. Devuelve `true` cuando cambia el `min-height`.
   */
  private fitDiagramHeight(popup: HTMLElement): boolean {
    const diagram = this.diagram?.nativeElement;
    if (!diagram) return false;
    const previousMin = this.diagramSavedStyle ? diagram.style.minHeight : null;
    this.restoreDiagramHeight();
    if (popup.offsetHeight <= 0) return false;
    const need = Math.ceil(popup.offsetHeight + 24);
    const main = this.main?.nativeElement;
    const split = main?.querySelector<HTMLElement>('.wcf__split');
    const max = main ? main.clientHeight - (split?.offsetHeight ?? 0) - 4 : need;
    const target = Math.floor(Math.min(need, max));
    if (target <= 0 || diagram.clientHeight >= target) return false;
    const panel = this.lab?.nativeElement ?? this.detail?.nativeElement ?? null;
    this.diagramSavedStyle = {
      minHeight: diagram.style.minHeight,
      panel,
      panelFlexShrink: panel?.style.flexShrink ?? '',
      panelMinHeight: panel?.style.minHeight ?? '',
    };
    diagram.style.minHeight = `${target}px`;
    if (panel) {
      panel.style.flexShrink = '1';
      panel.style.minHeight = '0';
    }
    return previousMin !== diagram.style.minHeight;
  }

  /** Restaura los estilos inline previos del diagrama y del panel inferior (popup cerrado, otro resultado o destrucción). */
  private restoreDiagramHeight(): void {
    const saved = this.diagramSavedStyle;
    if (!saved) return;
    this.diagramSavedStyle = null;
    const diagram = this.diagram?.nativeElement;
    if (diagram) diagram.style.minHeight = saved.minHeight;
    if (saved.panel) {
      saved.panel.style.flexShrink = saved.panelFlexShrink;
      saved.panel.style.minHeight = saved.panelMinHeight;
    }
  }

  /* ---------------------------- validador ---------------------------- */

  get inputText(): string {
    return this.flowService.ui.mode === 'logs' ? this.flowService.ui.logsInput : this.flowService.ui.simInput;
  }

  get inputRows(): number {
    const lines = this.inputText.split('\n').length;
    return Math.min(18, Math.max(6, lines));
  }

  onInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    if (this.flowService.ui.mode === 'logs') this.flowService.setLogsInput(value);
    else this.flowService.setSimInput(value);
  }

  run(): void {
    if (this.flowService.ui.mode === 'logs') void this.flowService.analyze();
    else void this.flowService.simulate();
  }

  get canRun(): boolean {
    const ui = this.flowService.ui;
    return !ui.busy && !!this.inputText.trim();
  }

  /* ---------------------------- separador horizontal ---------------------------- */

  startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    const main = this.main?.nativeElement.getBoundingClientRect();
    // El mismo separador redimensiona el validador (Simular datos / Analizar logs) o el detalle del Recorrido.
    const lab = (this.lab ?? this.detail)?.nativeElement.getBoundingClientRect();
    if (!main || !lab) return;
    event.preventDefault();
    this.dragOrigin = { top: main.top, bottom: main.bottom, height: main.height };
    this.zone.runOutsideAngular(() => {
      window.addEventListener('pointermove', this.onDragMove);
      window.addEventListener('pointerup', this.endDrag);
      window.addEventListener('pointercancel', this.endDrag);
    });
  }

  private onDragMove = (event: PointerEvent): void => {
    const origin = this.dragOrigin;
    if (!origin) return;
    const max = Math.max(LAB_MIN, origin.height - DIAGRAM_MIN - 7);
    const height = Math.round(Math.min(max, Math.max(LAB_MIN, origin.bottom - event.clientY)));
    this.zone.run(() => this.flowService.setLabHeight(height));
  };

  private endDrag = (): void => {
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.endDrag);
    window.removeEventListener('pointercancel', this.endDrag);
    this.dragOrigin = null;
  };

  resetLab(): void {
    this.flowService.setLabHeight(null);
  }

  /* ---------------------------- teclado ---------------------------- */

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (this.stepMenu !== null) {
        event.preventDefault();
        this.closeStepMenu();
        return;
      }
      if (this.preview.zoom) {
        event.preventDefault();
        this.preview.closeZoom();
        return;
      }
      if (this.preview.open) {
        event.preventDefault();
        this.closePreview();
        return;
      }
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const player = this.flowService.player;
    if (event.key === ' ' || event.code === 'Space') {
      if (target?.closest?.('button')) return;
      event.preventDefault();
      player.toggle();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.flowService.selectStep(player.step - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.flowService.selectStep(player.step + 1);
    }
  }

  /* ---------------------------- utilidades ---------------------------- */

  private scheduleScroll(): void {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      const row = this.diagram?.nativeElement.querySelector<HTMLElement>('.wcf-row.is-current, .wcf-row.is-fail, .wcf-row.is-stop');
      row?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 30);
  }

  trackLane = (_: number, lane: FlowLane) => lane.id;
  trackStep = (_: number, step: FlowStep) => step.id;
  trackValue = (_: number, v: number) => v;
  trackIndex = (index: number) => index;
  trackEvidence = (_: number, e: LogEvidence) => e.index;
}
