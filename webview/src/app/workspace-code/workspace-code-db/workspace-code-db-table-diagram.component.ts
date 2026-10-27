import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import { SnippetView } from '../ai/nexo-ia.types';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { WorkspaceCodeDbExplainService } from '../services/workspace-code-db-explain.service';
import { WorkspaceCodeNotifyService } from '../services/workspace-code-notify.service';
import { WorkspaceCodeDatabaseMetadata, WorkspaceCodeDbColumn, WorkspaceCodeDbTable } from '../services/workspace-code-runtime.types';
import { isForeignKeyColumn, relationCardinality, shortType } from './workspace-code-db.util';
import { ACTOR_API, ACTOR_APP, DbExplainPlayer, DbExplainScript, DbExplainStep, isExplainActor } from './workspace-code-db-explain';

const NODE_W = 232;
const HEAD_H = 34;
const ROW_H = 24;
const PAD_B = 8;
const MORE_H = 22;
const COL_GAP = 128;
const V_GAP = 26;
const STAGE_PAD = 28;
const CAPTION_H = 22;
const SELF_LOOP = 70;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const FIT_PAD = 16;
const COMPACT_MAX_H = 420;
const COMPACT_MIN_H = 200;
const ANCHOR_MAX_GAP = 8;
const ANCHOR_MIN_GAP = 4;
const POP_W = 300;
const POP_H_EST = 280;
const DRAG_THRESHOLD = 4;
const DRAG_MARGIN = 600;
const OFFSETS_MAX_KEYS = 60;
const BALLOON_W = 300;
const BALLOON_H_EST = 150;
const BALLOON_GAP = 14;
const ACTOR_H = 30;
const ACTOR_UP = 84;
/** Píldora de la función (conducida): alto, ancho mínimo y máximo, ancho estimado por carácter y espacio de iconos y padding. */
const FN_ACTOR_H = 38;
const FN_ACTOR_MIN_W = 240;
const FN_ACTOR_MAX_W = 320;
const FN_CHAR_W = 7.3;
const FN_ACTOR_CHROME = 70;
/** Popover con el código del método: ancho máximo y alto mínimo disponible. */
const CODE_POP_W = 460;
const CODE_POP_MIN_H = 140;
const EXPLAIN_PAD_X = 24;
const EXPLAIN_PAD_TOP = 70;
const EXPLAIN_PAD_BOTTOM = 96;
/** Conducida por el flujo: cabecera compacta y sin barra de controles propia. */
const DRIVEN_PAD_TOP = 92;
const DRIVEN_PAD_BOTTOM = 16;
/** Altura de la fila de funciones (chips `fn`) de una tarjeta en modo esquema. */
const FN_H = 20;

let seq = 0;

/** Posiciones movidas a mano, relativas al auto-layout: sobreviven a cambiar de pestaña. Solo en memoria de la sesión. */
const TD_OFFSETS = new Map<string, Map<string, { dx: number; dy: number }>>();

interface TdNode {
  name: string;
  side: 'center' | 'left' | 'right';
  x: number;
  y: number;
  /** Posición del auto-layout (sin el desplazamiento del usuario). */
  baseX: number;
  baseY: number;
  h: number;
  table: WorkspaceCodeDbTable;
  rows: WorkspaceCodeDbColumn[];
  hidden: number;
  /** Columnas que tienen una línea dibujada. */
  linked: Set<string>;
  delay: number;
  /** Modo esquema: funciones del flujo que tocan la tabla (sin duplicados). */
  fns: string[];
  /** Altura extra de la fila de funciones (0 si no hay). */
  fnH: number;
}

interface TdRelation {
  kind: 'out' | 'in' | 'self';
  src: string;
  srcCols: string[];
  dst: string;
  dstCols: string[];
  name: string;
  onDelete: string | null;
  onUpdate: string | null;
}

interface TdGeo {
  x1: number;
  y1: number;
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x2: number;
  y2: number;
}

interface TdEdge {
  id: string;
  from: string;
  to: string;
  fromCol: string;
  toCol: string;
  title: string;
  path: string;
  geo: TdGeo;
  delay: number;
  rel: TdRelation;
}

interface RawEdge {
  index: number;
  rel: TdRelation;
  src: TdNode;
  dst: TdNode;
  x1: number;
  x2: number;
  s1: number;
  s2: number;
  dx: number;
  y1: number;
  y2: number;
}

type TdGesture =
  | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
  | { kind: 'node'; name: string; startX: number; startY: number; nodeX: number; nodeY: number; moved: boolean };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
  x: number;
  y: number;
}

/** Camino que recorre el paquete del paso actual. */
interface XFlow {
  d: string;
  /** `path('…')` listo para `offset-path`. */
  css: string;
  /** Arista del diagrama que se ilumina; `null` si es un camino temporal. */
  edgeId: string | null;
  reverse: boolean;
  mid: Point;
}

interface XActor {
  id: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  w: number;
  h: number;
  active: boolean;
  /** Texto completo (atributo `title`). */
  title?: string;
  /** Píldora de la función del paso (explicación conducida). */
  fn?: boolean;
}

interface XBalloon {
  style: Record<string, string>;
  placement: 'above' | 'below' | 'right' | 'left';
}

interface XAnchor {
  /** Puntos para colocar el globo encima / debajo. */
  v?: [Point, Point];
  /** Puntos para colocarlo a la derecha / a la izquierda. */
  h?: [Point, Point];
  /** Rectángulo del ancla (coordenadas del mundo). */
  rect: Rect;
}

interface ExplainState {
  table: string;
  script: DbExplainScript;
  player: DbExplainPlayer;
  ai: 'idle' | 'loading' | 'done' | 'error';
  aiError: string | null;
  token: number;
  /** Conducida por el reproductor del flujo (modo esquema): sin barra propia ni teclado. */
  driven: boolean;
}

const NO_ACTORS: XActor[] = [];

/**
 * Diagrama ER de UNA tabla: la tabla en el centro, las que la referencian a la izquierda y las que ella referencia a la
 * derecha, con una línea animada por cada clave foránea (de la columna FK a la columna referenciada). Se construye con la
 * metadata real ya cargada; no consulta nada a la base de datos. Admite zoom (rueda, botones, ajustar), desplazamiento
 * arrastrando el fondo, mover cada tarjeta arrastrándola (las líneas la siguen), un menú contextual por tarjeta y, al hacer
 * clic en una línea, un panel que explica la relación y permite modificarla o eliminarla. Desde el menú, «Explicar» reproduce
 * una animación paso a paso de cómo se rellena la tabla.
 *
 * Copia de chatFront adaptada a la extensión: solo el modo esquema (modo «Base de datos» del flujo, conducido por su
 * reproductor). Sin conexión de base de datos, ni menú contextual, ni edición de relaciones.
 */
@Component({
  selector: 'app-workspace-code-db-table-diagram',
  templateUrl: './workspace-code-db-table-diagram.component.html',
  styleUrls: ['./workspace-code-db-shared.css', './workspace-code-db-table-diagram.component.css'],
})
export class WorkspaceCodeDbTableDiagramComponent implements OnChanges, AfterViewInit, OnDestroy {
  @Input({ required: true }) connectionKey!: string;
  @Input({ required: true }) tableName!: string;
  @Input() compact = false;
  /** Esquema propio (modo «Base de datos» del flujo): todas sus tablas en lugar de la tabla y sus vecinas. */
  @Input() schema: WorkspaceCodeDatabaseMetadata | null = null;
  @Input() schemaKey = '';
  /** Guion conducido por el reproductor del flujo (un paso por paso del flujo). */
  @Input() flowScript: DbExplainScript | null = null;
  @Input() flowIndex = 0;
  @Input() flowSpeed = 1;
  /** Modo conducido: acumula hasta el último paso del guion (fin de la reproducción o navegación manual). */
  @Input() flowRevealAll = false;
  /** Busca el código del método de la píldora del paso `scriptIndex` (modo conducido). Sin él, la píldora no es un botón. */
  @Input() fnCodeLoader: ((scriptIndex: number) => Promise<SnippetView | null>) | null = null;
  /** El usuario pide abrir en el editor el fragmento del método mostrado en el popover. */
  @Output() fnCodeOpen = new EventEmitter<SnippetView>();

  @HostBinding('class.is-compact') get hostCompact(): boolean { return this.compact; }

  /** Globo del paso actual: se mide su alto para colocarlo sin tapar tarjetas ni píldoras. */
  @ViewChild('xballoon') set xBalloonRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement ?? null;
    if (el === this.balloonEl) return;
    this.balloonObserver?.disconnect();
    this.balloonObserver = null;
    this.balloonEl = el;
    if (!el || typeof ResizeObserver === 'undefined') return;
    this.balloonObserver = new ResizeObserver(() => this.onBalloonResize(el));
    this.balloonObserver.observe(el);
  }

  /** El lienzo vive dentro de un *ngIf: el setter conecta y desconecta los gestos cuando aparece o desaparece. */
  @ViewChild('canvas') set canvasRef(ref: ElementRef<HTMLDivElement> | undefined) {
    const el = ref?.nativeElement ?? null;
    if (el === this.canvasEl) return;
    this.detachCanvas();
    this.canvasEl = el;
    if (!el) return;
    // Los gestos no pasan por la zona de Angular: se redibuja una vez por fotograma.
    this.zone.runOutsideAngular(() => {
      const wheel = (event: WheelEvent) => this.onWheel(event);
      const down = (event: PointerEvent) => this.onPointerDown(event);
      // Tras arrastrar una tarjeta el navegador dispara un `click`: se descarta antes de que llegue a la cabecera de la vecina.
      const click = (event: MouseEvent) => {
        if (!this.suppressClick) return;
        this.suppressClick = false;
        event.stopPropagation();
        event.preventDefault();
      };
      el.addEventListener('wheel', wheel, { passive: false });
      el.addEventListener('pointerdown', down);
      el.addEventListener('click', click, true);
      this.canvasCleanup.push(
        () => el.removeEventListener('wheel', wheel),
        () => el.removeEventListener('pointerdown', down),
        () => el.removeEventListener('click', click, true),
      );
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
          if (this.destroyed) return;
          // Conducida por el flujo: el panel cambia de alto al mover el divisor; se reencuadra siempre.
          if (this.explain?.driven) this.zone.run(() => this.fitInvolved());
          else if (!this.userAdjusted) this.autoFit();
        });
        observer.observe(el);
        this.resizeObserver = observer;
      }
    });
    setTimeout(() => {
      if (!this.fitted && !this.destroyed) this.autoFit();
    });
  }

  readonly uid = 'wtd' + (++seq);
  readonly nodeWidth = NODE_W;
  readonly headHeight = HEAD_H;
  readonly rowHeight = ROW_H;
  readonly stagePad = STAGE_PAD;
  readonly speeds = [0.5, 1, 1.5, 2];

  nodes: TdNode[] = [];
  edges: TdEdge[] = [];
  width = 0;
  height = 0;
  xLeft = STAGE_PAD;
  xRight = 0;
  hasLeft = false;
  hasRight = false;
  expandedAll = false;
  hoverEdge: string | null = null;
  hoverNode: string | null = null;
  renderKey = '';

  view = { x: 0, y: 0, z: 1 };
  grabbing = false;
  /** Tarjeta que se está arrastrando. */
  dragging: string | null = null;
  selectedEdge: string | null = null;
  /** Punto del clic en coordenadas del mundo (se mueve con el zoom y el desplazamiento). */
  popAt: { x: number; y: number } | null = null;
  actionError: string | null = null;
  /** Explicación animada en curso (solo en el diagrama completo, nunca en el compacto). */
  explain: ExplainState | null = null;
  /** Popover con el código del método de la píldora de la función. */
  fnCode: { fn: string; status: 'loading' | 'ready' | 'empty'; view: SnippetView | null } | null = null;
  readonly reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  private subs = new Subscription();
  private fitted = false;
  private userAdjusted = false;
  private frame = 0;
  private gesture: TdGesture | null = null;
  private gestureCleanup: (() => void) | null = null;
  private canvasCleanup: (() => void)[] = [];
  private globalCleanup: (() => void)[] = [];
  private resizeObserver?: ResizeObserver;
  private destroyed = false;
  private canvasEl: HTMLDivElement | null = null;

  private relations: TdRelation[] = [];
  private nodeIndex = new Map<string, TdNode>();
  private offsets = new Map<string, { dx: number; dy: number }>();
  private offsetKey = '';
  private edgesDirty = false;
  private suppressClick = false;
  private layoutVersion = 0;
  private explainToken = 0;
  private fnCodeToken = 0;
  private flowCache: { key: string; flow: XFlow | null } | null = null;
  private actorCache: { key: string; list: XActor[] } | null = null;
  /** Alto medido del globo del paso actual y escala con que se midió (solo crece dentro de un mismo paso y escala). */
  private balloonMeasure: { key: string; h: number; s: number } | null = null;
  private balloonObserver: ResizeObserver | null = null;
  private balloonEl: HTMLElement | null = null;
  private schemaBalloonCache: { key: string; balloon: XBalloon } | null = null;
  private filledCache: { script: DbExplainScript | null; index: number; set: Set<string> } = { script: null, index: -1, set: new Set() };
  private valuesCache: { script: DbExplainScript | null; index: number; map: Map<string, string> } = { script: null, index: -1, map: new Map() };
  private seenCache: { script: DbExplainScript | null; upto: number; set: Set<string> } = { script: null, upto: -2, set: new Set() };
  private partsCache = new Map<string, { t: string; code: boolean }[]>();

  constructor(
    private cdr: ChangeDetectorRef,
    private notify: WorkspaceCodeNotifyService,
    private i18n: WorkspaceCodeI18nService,
    private zone: NgZone,
    private host: ElementRef<HTMLElement>,
    private explainSvc: WorkspaceCodeDbExplainService,
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    const structural = ['connectionKey', 'tableName', 'compact', 'schema', 'schemaKey'].some((key) => key in changes);
    if (structural) {
      this.renderKey = this.schema ? `flow|${this.schemaKey}` : this.connectionKey + '|' + this.tableName;
      this.offsetKey = this.schema ? `flow|${this.schemaKey}` : `${this.connectionKey}|${this.tableName}|${this.compact ? 'c' : 'f'}`;
      this.offsets = TD_OFFSETS.get(this.offsetKey) ?? new Map();
      this.hoverEdge = null;
      this.hoverNode = null;
      this.fitted = false;
      this.userAdjusted = false;
      this.selectedEdge = null;
      this.popAt = null;
      this.actionError = null;
      this.closeFnCode(false);
      this.dropExplain();
      this.rebuild();
    }
    if ('flowRevealAll' in changes) {
      this.valuesCache = { script: null, index: -1, map: new Map() };
      this.seenCache = { script: null, upto: -2, set: new Set() };
      this.cdr.markForCheck();
    }
    if (!structural && ('flowScript' in changes || 'flowIndex' in changes)) this.closeFnCode(false);
    // El guion conducido sigue al reproductor del flujo sin reconstruir el diagrama.
    if (structural || 'flowScript' in changes) this.syncDriven(true);
    else if ('flowIndex' in changes || 'flowSpeed' in changes) this.syncDriven(false);
  }

  ngAfterViewInit(): void {
    this.zone.runOutsideAngular(() => {
      const key = (event: KeyboardEvent) => this.onGlobalKey(event);
      const outside = (event: PointerEvent) => {
        if (this.selectedEdge && !this.host.nativeElement.contains(event.target as Node)) this.zone.run(() => this.closeRelation());
        if (this.fnCode) {
          const target = event.target instanceof Element ? event.target : null;
          if (!target?.closest('.wtd-codepop, .wtd-xactor.is-fn')) this.zone.run(() => this.closeFnCode(false));
        }
      };
      window.addEventListener('keydown', key);
      document.addEventListener('pointerdown', outside, true);
      this.globalCleanup.push(() => window.removeEventListener('keydown', key), () => document.removeEventListener('pointerdown', outside, true));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.fnCodeToken++;
    this.balloonObserver?.disconnect();
    this.balloonObserver = null;
    this.balloonEl = null;
    this.explain?.player.destroy();
    this.detachCanvas();
    this.globalCleanup.forEach((fn) => fn());
    this.globalCleanup = [];
    this.endGesture();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.subs.unsubscribe();
  }

  private detachCanvas(): void {
    this.canvasCleanup.forEach((fn) => fn());
    this.canvasCleanup = [];
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.endGesture();
  }

  /** Teclado global: Esc cierra la relación o sale de «Explicar»; ← → y Espacio gobiernan la explicación. */
  private onGlobalKey(event: KeyboardEvent): void {
    const ex = this.explain;
    if (event.key === 'Escape') {
      if (this.fnCode) {
        this.zone.run(() => this.closeFnCode(true));
        return;
      }
      if (ex && !ex.driven) this.zone.run(() => this.exitExplain());
      else if (this.selectedEdge) this.zone.run(() => this.closeRelation());
      return;
    }
    // La explicación conducida la gobierna el reproductor del flujo (sus propias teclas).
    if (!ex || ex.driven || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== ' ') return;
    const hostEl = this.host.nativeElement;
    if (hostEl.offsetParent === null) return;
    const active = document.activeElement;
    if (active && active !== document.body && !hostEl.contains(active)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input, textarea, select, [contenteditable], .monaco-editor')) return;
    if (event.key === ' ' && target?.closest('button')) return;
    event.preventDefault();
    this.zone.run(() => {
      if (event.key === 'ArrowRight') ex.player.next();
      else if (event.key === 'ArrowLeft') ex.player.prev();
      else ex.player.toggle();
    });
  }

  /* ---------------------------- estado ---------------------------- */

  get table(): WorkspaceCodeDbTable | null {
    return this.tableOf(this.tableName) ?? this.schema?.tables[0] ?? null;
  }

  /** Tabla del diagrama: la del esquema propio (en la extensión solo existe el modo esquema). */
  private tableOf(name: string | null | undefined): WorkspaceCodeDbTable | null {
    if (this.schema) return name ? this.schema.tables.find((t) => t.name === name) ?? null : null;
    return null;
  }

  /** En la extensión no hay tablas de una conexión abierta (abrir, datos, estructura y editar no existen). */
  realTable(_name: string | null | undefined): WorkspaceCodeDbTable | null {
    return null;
  }

  /** Modo esquema (diagrama de las tablas de un flujo). */
  get schemaMode(): boolean {
    return !!this.schema;
  }

  get schemaCount(): number {
    return this.schema?.tables.length ?? 0;
  }

  /** Clave de la conexión para «Explicar»: en modo esquema sin conexión real, una clave propia del flujo. */
  private get explainConn(): string {
    return 'flow:' + this.schemaKey;
  }

  get loading(): boolean {
    return false;
  }

  get error(): string | null {
    return null;
  }

  get connected(): boolean {
    return false;
  }

  get outgoingCount(): number {
    return this.table?.foreignKeys.length ?? 0;
  }

  get incomingCount(): number {
    const table = this.table;
    return table ? table.referencedBy.filter((r) => r.table !== table.name).length : 0;
  }

  get summaryParams(): Record<string, number> {
    return { out: this.outgoingCount, in: this.incomingCount };
  }

  get hasRelations(): boolean {
    return this.edges.length > 0;
  }

  /** Alguna tarjeta está fuera de su sitio del auto-layout. */
  get hasCustomLayout(): boolean {
    return this.offsets.size > 0;
  }

  /* ---------------------------- construcción ---------------------------- */

  private get maxCenter(): number { return this.compact ? 10 : 14; }
  private get maxNeighbor(): number { return this.compact ? 6 : 8; }

  private visibleRows(table: WorkspaceCodeDbTable, max: number, linked: Set<string>): { rows: WorkspaceCodeDbColumn[]; hidden: number } {
    if (this.expandedAll || table.columns.length <= max) return { rows: table.columns, hidden: 0 };
    const keep = new Set<string>(linked);
    for (const column of table.columns) if (column.primaryKey) keep.add(column.name);
    for (const column of table.columns) {
      if (keep.size >= max) break;
      keep.add(column.name);
    }
    const rows = table.columns.filter((c) => keep.has(c.name));
    return { rows, hidden: table.columns.length - rows.length };
  }

  private heightOf(rows: number, hidden: number): number {
    return HEAD_H + rows * ROW_H + (hidden ? MORE_H : 0) + PAD_B;
  }

  private clearLayout(): void {
    this.nodes = [];
    this.edges = [];
    this.relations = [];
    this.nodeIndex = new Map();
    this.width = 0;
    this.height = 0;
    this.layoutVersion++;
    this.dropExplain();
    this.cdr.markForCheck();
  }

  private rebuild(): void {
    if (this.schema) {
      this.rebuildSchema(this.schema);
      return;
    }
    const table = this.table;
    if (!table) {
      this.clearLayout();
      return;
    }
    const exists = (name: string) => !!this.tableOf(name);
    const fkOf = (tableName: string, name: string) => this.tableOf(tableName)?.foreignKeys.find((f) => f.name === name);
    const relations: TdRelation[] = [];
    for (const fk of table.foreignKeys) {
      if (!exists(fk.refTable)) continue;
      relations.push({
        kind: fk.refTable === table.name ? 'self' : 'out', src: table.name, srcCols: fk.columns, dst: fk.refTable, dstCols: fk.refColumns, name: fk.name,
        onDelete: fk.onDelete ?? null, onUpdate: fk.onUpdate ?? null,
      });
    }
    for (const ref of table.referencedBy) {
      if (ref.table === table.name || !exists(ref.table)) continue;
      relations.push({
        kind: 'in', src: ref.table, srcCols: ref.columns, dst: table.name, dstCols: ref.refColumns, name: ref.name,
        onDelete: ref.onDelete ?? fkOf(ref.table, ref.name)?.onDelete ?? null,
        onUpdate: ref.onUpdate ?? fkOf(ref.table, ref.name)?.onUpdate ?? null,
      });
    }

    const rightNames = [...new Set(relations.filter((r) => r.kind === 'out').map((r) => r.dst))].sort((a, b) => a.localeCompare(b));
    const leftNames = [...new Set(relations.filter((r) => r.kind === 'in').map((r) => r.src))]
      .filter((name) => !rightNames.includes(name))
      .sort((a, b) => a.localeCompare(b));
    const hasSelf = relations.some((r) => r.kind === 'self');

    const build = (name: string, side: TdNode['side']): TdNode => {
      const t = this.tableOf(name)!;
      const linked = new Set<string>();
      for (const r of relations) {
        if (r.src === name) r.srcCols.forEach((c) => linked.add(c));
        if (r.dst === name) r.dstCols.forEach((c) => linked.add(c));
      }
      const max = side === 'center' ? this.maxCenter : this.maxNeighbor;
      const { rows, hidden } = this.visibleRows(t, max, linked);
      return { name, side, x: 0, y: 0, baseX: 0, baseY: 0, h: this.heightOf(rows.length, hidden), table: t, rows, hidden, linked, delay: 0, fns: [], fnH: 0 };
    };

    const center = build(table.name, 'center');
    const left = leftNames.map((n) => build(n, 'left'));
    const right = rightNames.map((n) => build(n, 'right'));

    const columnHeight = (list: TdNode[]) => list.reduce((sum, n) => sum + n.h, 0) + V_GAP * Math.max(0, list.length - 1);
    const inner = Math.max(columnHeight([center]), columnHeight(left), columnHeight(right));
    const xLeft = STAGE_PAD;
    const xCenter = left.length ? xLeft + NODE_W + COL_GAP : STAGE_PAD;
    const xRight = xCenter + NODE_W + COL_GAP;
    const place = (list: TdNode[], x: number) => {
      let y = STAGE_PAD + CAPTION_H + (inner - columnHeight(list)) / 2;
      for (const n of list) {
        n.baseX = x;
        n.baseY = y;
        y += n.h + V_GAP;
      }
    };
    place([center], xCenter);
    place(left, xLeft);
    place(right, xRight);
    center.delay = 0;
    [...left, ...right].forEach((n, i) => { n.delay = 80 * (i + 1); });

    this.xLeft = xLeft;
    this.xRight = xRight;
    this.hasLeft = left.length > 0;
    this.hasRight = right.length > 0;
    this.width = (right.length ? xRight + NODE_W : xCenter + NODE_W + (hasSelf ? SELF_LOOP : 0)) + STAGE_PAD;
    this.height = STAGE_PAD * 2 + CAPTION_H + inner;

    this.finishLayout([center, ...left, ...right], relations);
  }

  /**
   * Modo esquema: todas las tablas del esquema en orden, en columnas (una tabla por columna si hay ≤ 4; si no,
   * `ceil(n/4)` filas por columna, centradas en vertical), con las relaciones de sus FK internas.
   */
  private rebuildSchema(schema: WorkspaceCodeDatabaseMetadata): void {
    const tables = schema.tables;
    if (!tables.length) {
      this.clearLayout();
      return;
    }
    const names = new Set(tables.map((t) => t.name));
    const relations: TdRelation[] = [];
    for (const t of tables) {
      for (const fk of t.foreignKeys) {
        if (!names.has(fk.refTable)) continue;
        relations.push({
          kind: fk.refTable === t.name ? 'self' : 'out', src: t.name, srcCols: fk.columns, dst: fk.refTable, dstCols: fk.refColumns, name: fk.name,
          onDelete: fk.onDelete ?? null, onUpdate: fk.onUpdate ?? null,
        });
      }
    }
    const stepColumns = new Map<string, Set<string>>();
    const fns = new Map<string, string[]>();
    for (const step of this.flowScript?.steps ?? []) {
      if (!step.table) continue;
      const set = stepColumns.get(step.table) ?? new Set<string>();
      step.columns.forEach((c) => set.add(c));
      stepColumns.set(step.table, set);
      if (step.fn) {
        const list = fns.get(step.table) ?? [];
        if (!list.includes(step.fn)) list.push(step.fn);
        fns.set(step.table, list);
      }
    }
    const nodes: TdNode[] = tables.map((t, i) => {
      const linked = new Set<string>();
      for (const r of relations) {
        if (r.src === t.name) r.srcCols.forEach((c) => linked.add(c));
        if (r.dst === t.name) r.dstCols.forEach((c) => linked.add(c));
      }
      const keep = new Set<string>([...linked, ...(stepColumns.get(t.name) ?? [])]);
      const { rows, hidden } = this.visibleRows(t, this.maxCenter, keep);
      const tableFns = fns.get(t.name) ?? [];
      const fnH = tableFns.length ? FN_H : 0;
      const node: TdNode = {
        name: t.name, side: 'right', x: 0, y: 0, baseX: 0, baseY: 0, h: this.heightOf(rows.length, hidden) + fnH, table: t, rows, hidden, linked,
        delay: 80 * i, fns: tableFns, fnH,
      };
      return node;
    });

    const perColumn = nodes.length <= 4 ? 1 : Math.ceil(nodes.length / 4);
    const columns: TdNode[][] = [];
    for (let i = 0; i < nodes.length; i += perColumn) columns.push(nodes.slice(i, i + perColumn));
    const columnHeight = (list: TdNode[]) => list.reduce((sum, n) => sum + n.h, 0) + V_GAP * Math.max(0, list.length - 1);
    const inner = Math.max(...columns.map(columnHeight));
    columns.forEach((list, c) => {
      const x = STAGE_PAD + c * (NODE_W + COL_GAP);
      let y = STAGE_PAD + CAPTION_H + (inner - columnHeight(list)) / 2;
      for (const n of list) {
        n.baseX = x;
        n.baseY = y;
        y += n.h + V_GAP;
      }
    });
    const hasSelf = relations.some((r) => r.kind === 'self');
    this.xLeft = STAGE_PAD;
    this.xRight = STAGE_PAD;
    this.hasLeft = false;
    this.hasRight = false;
    this.width = STAGE_PAD + columns.length * NODE_W + (columns.length - 1) * COL_GAP + (hasSelf ? SELF_LOOP : 0) + STAGE_PAD;
    this.height = STAGE_PAD * 2 + CAPTION_H + inner;
    this.finishLayout(nodes, relations);
  }

  /** Parte común del layout: desplazamientos del usuario, índice, líneas y encuadre. */
  private finishLayout(all: TdNode[], relations: TdRelation[]): void {
    const index = new Map<string, TdNode>(all.map((n) => [n.name, n]));

    // Los desplazamientos del usuario se aplican sobre el auto-layout; los de tablas que ya no se muestran se descartan.
    let pruned = false;
    for (const name of [...this.offsets.keys()]) {
      if (!index.has(name)) {
        this.offsets.delete(name);
        pruned = true;
      }
    }
    if (pruned) this.storeOffsets();
    for (const n of all) {
      const off = this.offsets.get(n.name);
      n.x = n.baseX + (off?.dx ?? 0);
      n.y = n.baseY + (off?.dy ?? 0);
    }

    this.relations = relations;
    this.nodeIndex = index;
    this.nodes = all;
    this.layoutEdges();
    if (this.selectedEdge && !this.edges.some((e) => e.id === this.selectedEdge)) this.closeRelation();
    if (this.explain && !this.explain.driven && !index.has(this.explain.table)) this.exitExplain();
    if (!this.userAdjusted) setTimeout(() => { if (!this.destroyed && !this.userAdjusted) this.autoFit(); });
    this.cdr.markForCheck();
  }

  /**
   * Trazado de las líneas con las posiciones ACTUALES de las tarjetas: el lado de cada extremo depende de dónde está una
   * tarjeta respecto a la otra, y las líneas que llegan a la misma fila se reparten en vertical. Se repite en cada fotograma
   * mientras se arrastra (sin rehacer el layout) y conserva los ids para no reiniciar el trazado ni el pulso.
   */
  private layoutEdges(): void {
    const anchor = (node: TdNode, column: string) => {
      const i = node.rows.findIndex((c) => c.name === column);
      return i < 0 ? node.y + HEAD_H / 2 : node.y + HEAD_H + node.fnH + i * ROW_H + ROW_H / 2;
    };

    // Primera pasada: extremos en bruto (lado, columna y altura de la fila).
    const raws: RawEdge[] = [];
    this.relations.forEach((r, i) => {
      const src = this.nodeIndex.get(r.src);
      const dst = this.nodeIndex.get(r.dst);
      if (!src || !dst) return;
      const y1 = anchor(src, r.srcCols[0]);
      const y2 = anchor(dst, r.dstCols[0]);
      let x1: number, x2: number, s1: number, s2: number, dx: number;
      if (r.kind === 'self') {
        x1 = x2 = src.x + NODE_W;
        s1 = s2 = 1;
        dx = 60;
      } else if (src.x + NODE_W + 24 <= dst.x) {
        x1 = src.x + NODE_W; x2 = dst.x; s1 = 1; s2 = -1;
        dx = Math.max(40, Math.min(120, Math.abs(x2 - x1) / 2));
      } else if (dst.x + NODE_W + 24 <= src.x) {
        x1 = src.x; x2 = dst.x + NODE_W; s1 = -1; s2 = 1;
        dx = Math.max(40, Math.min(120, Math.abs(x2 - x1) / 2));
      } else {
        // Tarjetas que se solapan en horizontal: ambas líneas salen por la derecha y dan la vuelta.
        x1 = src.x + NODE_W; x2 = dst.x + NODE_W; s1 = s2 = 1;
        dx = Math.min(140, 60 + Math.abs(y2 - y1) / 4);
      }
      raws.push({ index: i, rel: r, src, dst, x1, x2, s1, s2, dx, y1, y2 });
    });

    // Las líneas que llegan a la misma fila, lado y tabla se reparten en vertical, ordenadas por la altura del otro extremo.
    interface End { raw: RawEdge; end: 'from' | 'to'; other: number }
    const groups = new Map<string, { node: TdNode; anchorY: number; ends: End[] }>();
    const addEnd = (raw: RawEdge, end: 'from' | 'to') => {
      const node = end === 'from' ? raw.src : raw.dst;
      const column = end === 'from' ? raw.rel.srcCols[0] : raw.rel.dstCols[0];
      const side = end === 'from' ? raw.s1 : raw.s2;
      const key = `${node.name}|${side}|${column}`;
      let group = groups.get(key);
      if (!group) {
        group = { node, anchorY: end === 'from' ? raw.y1 : raw.y2, ends: [] };
        groups.set(key, group);
      }
      group.ends.push({ raw, end, other: end === 'from' ? raw.y2 : raw.y1 });
    };
    for (const raw of raws) {
      addEnd(raw, 'from');
      addEnd(raw, 'to');
    }
    const finalY = new Map<RawEdge, { y1: number; y2: number }>(raws.map((raw) => [raw, { y1: raw.y1, y2: raw.y2 }]));
    for (const group of groups.values()) {
      const n = group.ends.length;
      if (n < 2) continue;
      group.ends.sort((a, b) => a.other - b.other || a.raw.index - b.raw.index);
      const bodyTop = group.node.y + HEAD_H + group.node.fnH + 4;
      const bodyBottom = group.node.y + group.node.h - 4;
      const spacing = Math.min(ANCHOR_MAX_GAP, Math.max(ANCHOR_MIN_GAP, (bodyBottom - bodyTop) / n));
      const band = spacing * (n - 1);
      const start = Math.min(Math.max(group.anchorY - band / 2, bodyTop), Math.max(bodyTop, bodyBottom - band));
      group.ends.forEach((e, i) => {
        const y = start + i * spacing;
        const target = finalY.get(e.raw)!;
        if (e.end === 'from') target.y1 = y;
        else target.y2 = y;
      });
    }

    // Segunda pasada: trazados definitivos.
    this.edges = raws.map((raw) => {
      const { y1, y2 } = finalY.get(raw)!;
      const r = raw.rel;
      const geo: TdGeo = { x1: raw.x1, y1, c1x: raw.x1 + raw.s1 * raw.dx, c1y: y1, c2x: raw.x2 + raw.s2 * raw.dx, c2y: y2, x2: raw.x2, y2 };
      return {
        id: `${r.kind}:${r.src}.${r.name}`,
        from: raw.src.name,
        to: raw.dst.name,
        fromCol: r.srcCols[0],
        toCol: r.dstCols[0],
        title: `${r.src}.${r.srcCols.join(', ')} → ${r.dst}.${r.dstCols.join(', ')} (${r.name})`,
        path: `M ${geo.x1} ${geo.y1} C ${geo.c1x} ${geo.c1y}, ${geo.c2x} ${geo.c2y}, ${geo.x2} ${geo.y2}`,
        geo,
        delay: 250 + 60 * raw.index,
        rel: r,
      };
    });
    this.layoutVersion++;
  }

  /* ---------------------------- vista: zoom, desplazamiento, ajustar ---------------------------- */

  get worldTransform(): string {
    return `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.z})`;
  }

  get gridStyle(): Record<string, string> {
    const size = 22 * this.view.z;
    return { 'background-size': `${size}px ${size}px`, 'background-position': `${this.view.x}px ${this.view.y}px` };
  }

  get zoomLabel(): string {
    return `${Math.round(this.view.z * 100)}%`;
  }

  get compactHeight(): number {
    return Math.min(COMPACT_MAX_H, Math.max(COMPACT_MIN_H, this.height + 2 * FIT_PAD));
  }

  /** Caja que contiene el escenario, todas las tarjetas (también las movidas) y, si se explica, las píldoras. */
  private bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = 0;
    let minY = 0;
    let maxX = this.width;
    let maxY = this.height;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + n.h);
    }
    if (this.explain) {
      for (const a of this.xActors) {
        minX = Math.min(minX, a.x);
        minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x + a.w);
        maxY = Math.max(maxY, a.y + a.h);
      }
    }
    return { minX, minY, maxX, maxY };
  }

  /** Ajusta el diagrama al lienzo (sin pasar del 100 %); si no cabe ni al zoom mínimo, lo alinea arriba a la izquierda. */
  fit(): void {
    const el = this.canvasEl;
    if (!el || !this.width || !this.height) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const b = this.bounds();
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const z = Math.min(Math.max(Math.min((w - 2 * FIT_PAD) / bw, (h - 2 * FIT_PAD) / bh, 1), MIN_ZOOM), MAX_ZOOM);
    const x = bw * z <= w - 2 * FIT_PAD ? (w - bw * z) / 2 - b.minX * z : FIT_PAD - b.minX * z;
    const y = bh * z <= h - 2 * FIT_PAD ? (h - bh * z) / 2 - b.minY * z : FIT_PAD - b.minY * z;
    this.view = { x, y, z };
    this.fitted = true;
    this.userAdjusted = false;
    this.schedule();
  }

  /** Encuadre automático: las tarjetas implicadas si la explicación la conduce el flujo; si no, todo el diagrama. */
  private autoFit(): void {
    if (this.explain?.driven) this.fitInvolved();
    else this.fit();
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    const el = this.canvasEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const my = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const z = Math.min(Math.max(this.view.z * factor, MIN_ZOOM), MAX_ZOOM);
    const ratio = z / this.view.z;
    this.view = { z, x: mx - (mx - this.view.x) * ratio, y: my - (my - this.view.y) * ratio };
    this.userAdjusted = true;
    this.schedule();
  }

  resetZoom(): void {
    this.zoomBy(1 / this.view.z);
  }

  private schedule(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.destroyed) return;
      // Las líneas se recalculan una sola vez por fotograma, aunque lleguen muchos eventos de puntero.
      if (this.edgesDirty) {
        this.edgesDirty = false;
        this.layoutEdges();
      }
      this.cdr.detectChanges();
    });
  }

  private toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvasEl!.getBoundingClientRect();
    return { x: (clientX - rect.left - this.view.x) / this.view.z, y: (clientY - rect.top - this.view.y) / this.view.z };
  }

  /* ---------------------------- gestos ---------------------------- */

  private onWheel(event: WheelEvent): void {
    if ((event.target as HTMLElement).closest('.wtd-zoombar')) return;
    // En modo foco el panel hace scroll: la rueda solo hace zoom con Ctrl/Meta.
    if (this.compact && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const dy = Math.max(-120, Math.min(120, event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY));
    const k = event.ctrlKey && Math.abs(event.deltaY) < 40 ? 0.01 : 0.0015;
    this.zoomBy(Math.exp(-dy * k), event.clientX, event.clientY);
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (this.compact && event.pointerType === 'touch') return;
    const target = event.target as HTMLElement;
    if (target.closest('.wtd-zoombar, .wtd-edge__hit, .wtd-xbar, .wtd-xballoon, .wtd-xhead, .wtd-pop, button, a, input, select')) return;
    this.endGesture();
    const nodeEl = target.closest<HTMLElement>('.wtd-node');
    if (nodeEl) {
      // Una tarjeta se arrastra desde cualquier punto. Sin `preventDefault`: se conservan el foco y el clic.
      const node = this.nodeIndex.get(nodeEl.dataset['table'] ?? '');
      if (!node) return;
      this.gesture = { kind: 'node', name: node.name, startX: event.clientX, startY: event.clientY, nodeX: node.x, nodeY: node.y, moved: false };
    } else {
      this.gesture = { kind: 'pan', startX: event.clientX, startY: event.clientY, viewX: this.view.x, viewY: this.view.y, moved: false };
      this.grabbing = true;
    }
    const move = (e: PointerEvent) => this.onPointerMove(e);
    const up = () => this.onPointerUp();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.gestureCleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    this.schedule();
  }

  private endGesture(): void {
    this.gestureCleanup?.();
    this.gestureCleanup = null;
    this.gesture = null;
    this.grabbing = false;
    this.dragging = null;
  }

  private onPointerMove(event: PointerEvent): void {
    const g = this.gesture;
    if (!g) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (g.kind === 'pan') {
      if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
      if (!g.moved) return;
      this.userAdjusted = true;
      this.view = { ...this.view, x: g.viewX + dx, y: g.viewY + dy };
      this.schedule();
      return;
    }
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.moved = true;
      this.dragging = g.name;
    }
    const node = this.nodeIndex.get(g.name);
    if (!node) return;
    const z = this.view.z || 1;
    node.x = Math.round(Math.min(Math.max(g.nodeX + dx / z, -DRAG_MARGIN), this.width + DRAG_MARGIN - NODE_W));
    node.y = Math.round(Math.min(Math.max(g.nodeY + dy / z, -DRAG_MARGIN), this.height + DRAG_MARGIN - node.h));
    const offset = { dx: node.x - node.baseX, dy: node.y - node.baseY };
    if (offset.dx === 0 && offset.dy === 0) this.offsets.delete(node.name);
    else this.offsets.set(node.name, offset);
    this.storeOffsets();
    // El ResizeObserver no debe reencuadrar mientras el usuario coloca tarjetas.
    this.userAdjusted = true;
    this.edgesDirty = true;
    this.schedule();
  }

  private onPointerUp(): void {
    const g = this.gesture;
    this.endGesture();
    if (g?.kind === 'node') {
      if (g.moved) {
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; });
      }
      if (this.edgesDirty) {
        this.edgesDirty = false;
        this.layoutEdges();
      }
      if (!g.moved && this.selectedEdge) this.zone.run(() => this.closeRelation());
      this.zone.run(() => this.cdr.markForCheck());
    } else if (g && !g.moved && this.selectedEdge) {
      this.zone.run(() => this.closeRelation());
    }
    this.schedule();
  }

  /* ---------------------------- posiciones de las tarjetas ---------------------------- */

  /** Guarda los desplazamientos en la caché de la sesión (como mucho 60 diagramas; sale el más antiguo). */
  private storeOffsets(): void {
    TD_OFFSETS.delete(this.offsetKey);
    if (!this.offsets.size) return;
    TD_OFFSETS.set(this.offsetKey, this.offsets);
    while (TD_OFFSETS.size > OFFSETS_MAX_KEYS) TD_OFFSETS.delete(TD_OFFSETS.keys().next().value as string);
  }

  /** Vuelve todas las tarjetas a su sitio del auto-layout. */
  resetLayout(): void {
    this.offsets.clear();
    TD_OFFSETS.delete(this.offsetKey);
    for (const n of this.nodes) {
      n.x = n.baseX;
      n.y = n.baseY;
    }
    this.layoutEdges();
    this.userAdjusted = false;
    this.fit();
  }

  resetNode(name: string): void {
    const n = this.nodeIndex.get(name);
    if (!n) return;
    this.offsets.delete(name);
    this.storeOffsets();
    n.x = n.baseX;
    n.y = n.baseY;
    this.layoutEdges();
    this.schedule();
  }

  /** Centra la vista en una tarjeta sin cambiar el zoom. */
  centerOn(name: string): void {
    const n = this.nodeIndex.get(name);
    const el = this.canvasEl;
    if (!n || !el) return;
    const z = this.view.z;
    this.view = { x: el.clientWidth / 2 - (n.x + NODE_W / 2) * z, y: el.clientHeight / 2 - (n.y + n.h / 2) * z, z };
    this.userAdjusted = true;
    this.schedule();
  }

  /* ---------------------------- relación seleccionada ---------------------------- */

  get selectedRelation(): TdRelation | null {
    return this.edges.find((e) => e.id === this.selectedEdge)?.rel ?? null;
  }

  selectEdge(edge: TdEdge, event: MouseEvent): void {
    event.stopPropagation();
    this.selectedEdge = edge.id;
    this.popAt = this.canvasEl ? this.toWorld(event.clientX, event.clientY) : null;
    this.actionError = null;
    this.cdr.markForCheck();
  }

  closeRelation(): void {
    this.selectedEdge = null;
    this.popAt = null;
    this.cdr.markForCheck();
  }

  /** Nombre `Clase.método` de la función del paso conducido actual (sin `()`). */
  get fnCodeName(): string {
    return this.explain?.player.step?.fn ?? '';
  }

  /** La píldora de la función es un botón: hay cargador, explicación conducida y el paso actual tiene función. */
  get fnCodeClickable(): boolean {
    return !!this.fnCodeLoader && !!this.explain?.driven && !!this.explain.player.step?.fn;
  }

  /** Abre o cierra el popover con el código del método de la píldora. */
  toggleFnCode(event: Event): void {
    event.stopPropagation();
    if (this.fnCode) {
      this.closeFnCode(true);
      return;
    }
    const ex = this.explain;
    const loader = this.fnCodeLoader;
    const fn = ex?.player.step?.fn;
    if (!ex || !loader || !fn || !ex.driven) return;
    this.closeRelation();
    const token = ++this.fnCodeToken;
    this.fnCode = { fn, status: 'loading', view: null };
    const done = (view: SnippetView | null) => {
      if (token !== this.fnCodeToken || this.destroyed || !this.fnCode) return;
      this.fnCode = view?.lines.length ? { fn, status: 'ready', view } : { fn, status: 'empty', view: null };
      this.cdr.markForCheck();
    };
    // Un fallo del cargador se muestra como «sin código», no como error de la vista.
    loader(ex.player.index).then(done, () => done(null));
    this.cdr.markForCheck();
    setTimeout(() => {
      if (token === this.fnCodeToken && !this.destroyed) this.host.nativeElement.querySelector<HTMLElement>('.wtd-codepop__close')?.focus({ preventScroll: true });
    });
  }

  /** Cierra el popover del código; `restoreFocus` devuelve el foco a la píldora. Descarta una carga en curso. */
  closeFnCode(restoreFocus: boolean): void {
    this.fnCodeToken++;
    if (!this.fnCode) return;
    this.fnCode = null;
    this.cdr.markForCheck();
    if (restoreFocus && !this.destroyed) this.host.nativeElement.querySelector<HTMLElement>('.wtd-xactor.is-fn')?.focus({ preventScroll: true });
  }

  /** Posición del popover: justo debajo de la píldora de la función, dentro del lienzo y con el alto disponible. */
  get codePopStyle(): Record<string, string> {
    const el = this.canvasEl;
    const a = this.xActors.find((x) => x.id === ACTOR_API);
    if (!el || !a) return {};
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const z = this.view.z;
    const pw = Math.min(CODE_POP_W, cw - 16);
    const cx = this.view.x + (a.x + a.w / 2) * z;
    const left = Math.min(Math.max(cx - pw / 2, 8), Math.max(8, cw - pw - 8));
    const top = Math.min(Math.max(this.view.y + (a.y + a.h) * z + 8, 8), Math.max(8, ch - CODE_POP_MIN_H));
    return { left: `${left}px`, top: `${top}px`, width: `${pw}px`, maxHeight: `${Math.max(CODE_POP_MIN_H - 16, ch - top - 8)}px` };
  }

  cardinalityKey(r: TdRelation): string {
    return 'dbw.rel.' + relationCardinality(this.tableOf(r.src), r.srcCols);
  }

  explainKey(r: TdRelation): string {
    if (r.kind === 'self') return 'dbw.tdiag.explainSelf';
    return relationCardinality(this.tableOf(r.src), r.srcCols) === 'oneToOne' ? 'dbw.tdiag.explainOne' : 'dbw.tdiag.explainMany';
  }

  explainParams(r: TdRelation): Record<string, string> {
    return { src: r.src, dst: r.dst, cols: r.srcCols.join(', ') };
  }

  get popStyle(): Record<string, string> {
    const el = this.canvasEl;
    const at = this.popAt;
    if (!el || !at) return {};
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const pw = Math.min(POP_W, cw - 16);
    const sx = this.view.x + at.x * this.view.z;
    const sy = this.view.y + at.y * this.view.z + 12;
    const left = Math.min(Math.max(sx - pw / 2, 8), Math.max(8, cw - pw - 8));
    const top = this.compact ? Math.max(8, sy) : (sy + POP_H_EST > ch ? Math.max(8, sy - 24 - POP_H_EST) : sy);
    return { left: `${left}px`, top: `${top}px`, width: `${pw}px` };
  }

  canEdit(_r: TdRelation): boolean {
    return false;
  }

  otherTable(r: TdRelation): string {
    return r.src === this.tableName ? r.dst : r.src;
  }

  /* ---------------------------- acciones ---------------------------- */

  toggleExpandAll(): void {
    this.expandedAll = !this.expandedAll;
    this.fitted = false;
    this.userAdjusted = false;
    this.rebuild();
    setTimeout(() => { if (!this.destroyed) this.fit(); });
  }

  isLink(_node: TdNode): boolean {
    return false;
  }

  /* ---------------------------- resaltado ---------------------------- */

  isEdgeHot(edge: TdEdge): boolean {
    return this.hoverEdge === edge.id || this.selectedEdge === edge.id || (!!this.hoverNode && (edge.from === this.hoverNode || edge.to === this.hoverNode));
  }

  isEdgeDim(edge: TdEdge): boolean {
    return !!this.selectedEdge && this.selectedEdge !== edge.id;
  }

  isHot(node: TdNode, column: string): boolean {
    if (!this.hoverEdge && !this.hoverNode && !this.selectedEdge) return false;
    return this.edges.some((e) => this.isEdgeHot(e) && ((e.from === node.name && e.fromCol === column) || (e.to === node.name && e.toCol === column)));
  }

  /* ---------------------------- modo «Explicar» ---------------------------- */

  get explaining(): boolean {
    return !!this.explain;
  }

  /** Explicación iniciada por el usuario (no la conducida por el flujo). */
  get userExplaining(): boolean {
    return !!this.explain && !this.explain.driven;
  }

  /** Tabla que explica el botón «Explicar»: la del paso actual del flujo o `tableName`. */
  get explainTableName(): string {
    const ex = this.explain;
    if (ex?.driven) return this.xStep?.table || ex.script.table || this.tableName;
    return this.tableName;
  }

  /** Velocidad de reproducción (multiplica la duración de las animaciones del paquete). */
  get xSpeed(): number {
    const ex = this.explain;
    return ex ? ex.player.speed : 1;
  }

  /** Paso actual de la explicación. */
  get xStep(): DbExplainStep | null {
    return this.explain?.player.step ?? null;
  }

  get xInsertActive(): boolean {
    return this.xStep?.kind === 'insert';
  }

  /** La tarjeta forma parte de lo que se explica (se destaca; el resto se atenúa). */
  xInvolved(name: string): boolean {
    return !!this.explain?.script.involved.includes(name);
  }

  /** La tarjeta es origen o destino del paso actual. */
  xActive(name: string): boolean {
    const step = this.xStep;
    return !!step && (step.from === name || step.to === name);
  }

  /** La tarjeta es la destino de la explicación (la que se está rellenando). */
  xIsTarget(name: string): boolean {
    const ex = this.explain;
    if (ex?.driven) {
      const step = this.xStep;
      return !!step && (step.to === name || step.table === name);
    }
    return ex?.script.table === name;
  }

  /** Columna tocada por el paso actual del flujo (modo conducido). */
  xTouched(node: TdNode, column: string): boolean {
    const ex = this.explain;
    const step = this.xStep;
    return !!ex?.driven && !!step && step.table === node.name && step.columns.includes(column);
  }

  /** Último paso del guion hasta el que se acumula (modo conducido): el actual o, con `flowRevealAll`, el último. */
  private xUpto(ex: ExplainState): number {
    return ex.driven && this.flowRevealAll ? ex.script.steps.length - 1 : ex.player.index;
  }

  /** Valores del flujo acumulados por `${tabla}.${columna}` hasta el paso actual (modo conducido). */
  private get xDrivenValues(): Map<string, string> {
    const ex = this.explain;
    if (!ex) return this.valuesCache.map;
    const cache = this.valuesCache;
    const upto = this.xUpto(ex);
    if (cache.script !== ex.script || cache.index !== upto) {
      const map = new Map<string, string>();
      for (let i = 0; i <= upto; i++) {
        const step = ex.script.steps[i];
        if (!step?.table || !step.values) continue;
        for (const [column, value] of Object.entries(step.values)) map.set(`${step.table}.${column}`, value);
      }
      this.valuesCache = { script: ex.script, index: upto, map };
    }
    return this.valuesCache.map;
  }

  /** Columnas ya alcanzadas por el flujo (`${tabla}.${columna}`) hasta el paso actual, o todas con `flowRevealAll`. */
  private get xSeenSet(): Set<string> {
    const ex = this.explain;
    if (!ex?.driven) return this.seenCache.set;
    const upto = this.xUpto(ex);
    const cache = this.seenCache;
    if (cache.script !== ex.script || cache.upto !== upto) {
      const set = new Set<string>();
      for (let i = 0; i <= upto; i++) {
        const step = ex.script.steps[i];
        if (!step?.table) continue;
        for (const column of step.columns) set.add(`${step.table}.${column}`);
      }
      this.seenCache = { script: ex.script, upto, set };
    }
    return this.seenCache.set;
  }

  /** Columna ya tocada en el diagrama por algún paso alcanzado (resaltado suave acumulativo). */
  xSeen(node: TdNode, column: string): boolean {
    return !!this.explain?.driven && this.xSeenSet.has(`${node.name}.${column}`);
  }

  xEdgeInvolved(edge: TdEdge): boolean {
    return this.xInvolved(edge.from) && this.xInvolved(edge.to);
  }

  get xActiveEdge(): string | null {
    return this.xFlow?.edgeId ?? null;
  }

  /** Columnas ya rellenadas hasta el paso actual (acumulativo). */
  private get xFilled(): Set<string> {
    const ex = this.explain;
    if (!ex) return this.filledCache.set;
    const cache = this.filledCache;
    if (cache.script !== ex.script || cache.index !== ex.player.index) {
      const set = new Set<string>();
      for (let i = 0; i <= ex.player.index; i++) ex.script.steps[i]?.columns.forEach((c) => set.add(c));
      this.filledCache = { script: ex.script, index: ex.player.index, set };
    }
    return this.filledCache.set;
  }

  /** Valor de ejemplo de una columna de la tarjeta destino si ya se ha rellenado en un paso anterior o en el actual. */
  xValueOf(node: TdNode, column: string): string | null {
    const ex = this.explain;
    if (ex?.driven) return this.xDrivenValues.get(`${node.name}.${column}`) ?? null;
    if (!ex || node.name !== ex.script.table || !this.xFilled.has(column)) return null;
    return ex.script.sample.find((s) => s.column === column)?.value || null;
  }

  /** Separa un texto por las comillas invertidas: las partes entre ellas se muestran como código. */
  textParts(text: string): { t: string; code: boolean }[] {
    let parts = this.partsCache.get(text);
    if (!parts) {
      parts = [];
      text.split('`').forEach((piece, i) => { if (piece) parts!.push({ t: piece, code: i % 2 === 1 }); });
      if (this.partsCache.size > 300) this.partsCache.clear();
      this.partsCache.set(text, parts);
    }
    return parts;
  }

  startExplain(name: string): void {
    if (this.compact || this.destroyed) return;
    this.closeRelation();
    this.closeFnCode(false);
    const script = this.schema ? this.explainSvc.local(this.explainConn, name, this.schema) : this.explainSvc.local(this.connectionKey, name);
    if (!script || !script.steps.length) return;
    // Sustituye a la explicación conducida por el flujo (vuelve al salir).
    this.explain?.player.destroy();
    const token = ++this.explainToken;
    const state: ExplainState = { table: name, script, player: this.createPlayer(script), ai: 'idle', aiError: null, token, driven: false };
    this.explain = state;
    this.flowCache = null;
    this.actorCache = null;
    this.fitInvolved();
    state.player.start(!this.reducedMotion);
    setTimeout(() => this.host.nativeElement.querySelector<HTMLElement>('.wtd-xbar [data-x="play"]')?.focus({ preventScroll: true }));
    void this.explainSvc.endpointHint(this.explainConn, name).then((endpoint) => {
      const ex = this.explain;
      if (!endpoint || !ex || ex.token !== token) return;
      let changed = false;
      for (const step of ex.script.steps) {
        if (step.kind !== 'request' || (step.endpoint && !step.endpointGuess)) continue;
        step.endpoint = endpoint;
        step.endpointGuess = false;
        changed = true;
      }
      if (changed) this.zone.run(() => this.cdr.markForCheck());
    });
    this.cdr.markForCheck();
  }

  /** Sale de «Explicar»; en modo esquema vuelve a la animación conducida por el flujo. */
  exitExplain(): void {
    const ex = this.explain;
    if (!ex) return;
    this.dropExplain();
    if (!ex.driven && this.flowScript && this.schema) this.syncDriven(true);
  }

  private dropExplain(): void {
    const ex = this.explain;
    if (!ex) return;
    this.closeFnCode(false);
    ex.player.destroy();
    this.explain = null;
    this.explainToken++;
    this.flowCache = null;
    this.actorCache = null;
    this.cdr.markForCheck();
    this.schedule();
  }

  /**
   * Explicación conducida por el reproductor del flujo (modo esquema). Si hay una explicación del usuario activa no hace
   * nada. `create`: (re)crea el estado con el guion actual y encuadra las tablas; si no, solo va al paso y a la velocidad
   * del flujo. Nunca reproduce por su cuenta ni mueve el foco.
   */
  private syncDriven(create: boolean): void {
    if (this.destroyed || this.compact) return;
    const ex = this.explain;
    if (ex && !ex.driven) return;
    const script = this.flowScript;
    if (!script || !this.schema || !script.steps.length) {
      if (ex) this.dropExplain();
      return;
    }
    if (create || !ex || ex.script !== script) {
      ex?.player.destroy();
      const token = ++this.explainToken;
      const player = this.createPlayer(script);
      player.setSpeed(this.flowSpeed);
      this.explain = { table: script.table, script, player, ai: 'idle', aiError: null, token, driven: true };
      this.flowCache = null;
      this.actorCache = null;
      player.go(this.flowIndex);
      this.fitInvolved();
    } else {
      ex.player.setSpeed(this.flowSpeed);
      if (ex.player.index !== this.flowIndex) ex.player.go(this.flowIndex);
    }
    this.cdr.markForCheck();
  }

  async improveExplain(): Promise<void> {
    const ex = this.explain;
    if (!ex || ex.ai === 'loading') return;
    const token = ex.token;
    ex.ai = 'loading';
    ex.aiError = null;
    this.cdr.markForCheck();
    try {
      const script = await this.explainSvc.enhance(this.explainConn, ex.table, ex.script, this.schema ?? undefined);
      if (this.explain !== ex || ex.token !== token || this.destroyed) return;
      ex.player.destroy();
      ex.script = script;
      ex.player = this.createPlayer(script);
      ex.ai = 'done';
      this.flowCache = null;
      this.actorCache = null;
      this.fitInvolved();
      ex.player.start(!this.reducedMotion);
      this.notify.show(this.i18n.t('dbw.explain.aiDone'), 'success');
    } catch (error: unknown) {
      if (this.explain !== ex || ex.token !== token || this.destroyed) return;
      ex.ai = 'error';
      ex.aiError = error instanceof Error && error.message ? error.message : this.i18n.t('dbw.explain.aiFailed');
    }
    this.cdr.markForCheck();
  }

  setSpeed(value: string): void {
    const speed = Number(value);
    if (this.explain && speed > 0) this.explain.player.setSpeed(speed);
  }

  private createPlayer(script: DbExplainScript): DbExplainPlayer {
    return new DbExplainPlayer(script.steps, () => this.zone.run(() => this.cdr.markForCheck()), (fn) => this.zone.runOutsideAngular(fn));
  }

  /** Encuadra las tarjetas implicadas y las píldoras, dejando sitio a la cabecera y a la barra de controles. */
  private fitInvolved(): void {
    const el = this.canvasEl;
    const ex = this.explain;
    if (!el || !ex) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    const rects: Rect[] = [];
    for (const name of ex.script.involved) {
      const n = this.nodeIndex.get(name);
      if (n) rects.push({ x: n.x, y: n.y, w: NODE_W, h: n.h });
    }
    for (const a of this.xActors) rects.push({ x: a.x, y: a.y, w: a.w, h: a.h });
    if (!rects.length) return;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    // Las tablas empiezan por debajo de la cabecera «Datos de …» para que no las tape.
    const head = this.host.nativeElement.querySelector<HTMLElement>('.wtd-xhead');
    const headBottom = head ? head.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 12 : 0;
    const padTop = Math.max(ex.driven ? DRIVEN_PAD_TOP : EXPLAIN_PAD_TOP, headBottom);
    const padBottom = ex.driven ? DRIVEN_PAD_BOTTOM : EXPLAIN_PAD_BOTTOM;
    // Conducida o en modo esquema: se deja hueco (en unidades del mundo) para que el globo, del ancho de una tabla, vaya a su lado.
    const extra = ex.driven || this.schemaMode ? NODE_W + BALLOON_GAP : 0;
    const availW = Math.max(80, w - 2 * EXPLAIN_PAD_X);
    const availH = Math.max(80, h - padTop - padBottom);
    const z = Math.min(Math.max(Math.min(availW / (bw + extra), availH / bh, 1), MIN_ZOOM), MAX_ZOOM);
    const x = EXPLAIN_PAD_X + (availW - (bw + extra) * z) / 2 - minX * z;
    const y = padTop + Math.max(0, (availH - bh * z) / 2) - minY * z;
    this.view = { x, y, z };
    this.fitted = true;
    this.userAdjusted = true;
    this.schedule();
  }

  private nodeRect(n: TdNode): Rect {
    return { x: n.x, y: n.y, w: NODE_W, h: n.h };
  }

  /** Píldoras «App» y «Backend (API)» encima de la tarjeta destino (en coordenadas del mundo). */
  get xActors(): XActor[] {
    const ex = this.explain;
    if (!ex) return NO_ACTORS;
    const key = `${ex.token}|${this.layoutVersion}|${ex.player.stepKey}|${this.i18n.language}|${ex.script.table}`;
    if (this.actorCache?.key === key) return this.actorCache.list;
    const d = this.nodeIndex.get(ex.script.table);
    let list = NO_ACTORS;
    if (d && d.table.type !== 'VIEW') {
      const step = ex.player.step;
      if (ex.driven) {
        // Conducida: una sola píldora, la función que hace la operación sobre la tabla.
        const label = step?.fn ? step.fn + '()' : this.i18n.t('dbw.explain.actor.api');
        // Más grande que las demás: fuente mono 12px, alto 38px y ancho según la etiqueta (240–320px). El borde inferior no se mueve.
        const w = Math.min(FN_ACTOR_MAX_W, Math.max(FN_ACTOR_MIN_W, Math.round(label.length * FN_CHAR_W + FN_ACTOR_CHROME)));
        list = [{ id: ACTOR_API, label, title: label, icon: 'bi-braces', fn: true, x: d.x + NODE_W / 2 - w / 2, y: d.y - ACTOR_UP - (FN_ACTOR_H - ACTOR_H), w, h: FN_ACTOR_H, active: false }];
      } else list = [
        { id: ACTOR_APP, label: this.i18n.t('dbw.explain.actor.app'), icon: 'bi-window', x: d.x - 40, y: d.y - ACTOR_UP, w: 104, h: ACTOR_H, active: false },
        { id: ACTOR_API, label: this.i18n.t('dbw.explain.actor.api'), icon: 'bi-hdd-network', x: d.x + NODE_W - 82, y: d.y - ACTOR_UP, w: 136, h: ACTOR_H, active: false },
      ];
      for (const a of list) a.active = !!step && (step.from === a.id || step.to === a.id);
    }
    this.actorCache = { key, list };
    return list;
  }

  /** Camino del paquete del paso actual: la flecha FK si existe o un camino temporal entre tarjeta y/o píldora. */
  get xFlow(): XFlow | null {
    const ex = this.explain;
    if (!ex) return null;
    const key = `${ex.token}|${this.layoutVersion}|${ex.player.stepKey}`;
    if (this.flowCache?.key === key) return this.flowCache.flow;
    const flow = this.computeFlow(ex);
    this.flowCache = { key, flow };
    return flow;
  }

  private placeRect(id: string): Rect | null {
    if (isExplainActor(id)) {
      const actor = this.xActors.find((a) => a.id === id);
      return actor ? { x: actor.x, y: actor.y, w: actor.w, h: actor.h } : null;
    }
    const node = this.nodeIndex.get(id);
    if (node) return this.nodeRect(node);
    // Tabla que no está en el diagrama (p. ej. un padre lejano): se representa por el backend.
    const api = this.xActors.find((a) => a.id === ACTOR_API);
    return api ? { x: api.x, y: api.y, w: api.w, h: api.h } : null;
  }

  private computeFlow(ex: ExplainState): XFlow | null {
    const step = ex.player.step;
    if (!step || !step.from || !step.to) return null;
    const { from, to } = step;
    if (this.nodeIndex.has(from) && this.nodeIndex.has(to)) {
      const edge = from === to
        ? this.edges.find((e) => e.rel.kind === 'self' && e.from === from)
        : this.edges.find((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
      if (edge) {
        const g = edge.geo;
        return {
          d: edge.path, css: `path('${edge.path}')`, edgeId: edge.id, reverse: from !== to && edge.from !== from,
          mid: { x: (g.x1 + 3 * g.c1x + 3 * g.c2x + g.x2) / 8, y: (g.y1 + 3 * g.c1y + 3 * g.c2y + g.y2) / 8 },
        };
      }
    }
    if (step.kind === 'fill' || step.kind === 'note' || from === to) return null;
    const a = this.placeRect(from);
    const b = this.placeRect(to);
    return a && b ? this.connect(a, b) : null;
  }

  /** Curva entre dos rectángulos: vertical si se solapan en horizontal, lateral si no. */
  private connect(a: Rect, b: Rect): XFlow {
    let x1: number, y1: number, x2: number, y2: number, c1x: number, c1y: number, c2x: number, c2y: number;
    if (a.x < b.x + b.w && b.x < a.x + a.w) {
      const lo = Math.max(a.x, b.x);
      const hi = Math.min(a.x + a.w, b.x + b.w);
      const x = (lo + hi) / 2;
      const down = a.y + a.h / 2 <= b.y + b.h / 2;
      y1 = down ? a.y + a.h : a.y;
      y2 = down ? b.y : b.y + b.h;
      const k = Math.max(24, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
      x1 = x2 = c1x = c2x = x;
      c1y = y1 + k;
      c2y = y2 - k;
    } else {
      let s1 = 1;
      let s2 = -1;
      if (a.x + a.w + 24 <= b.x) { x1 = a.x + a.w; x2 = b.x; }
      else if (b.x + b.w + 24 <= a.x) { x1 = a.x; x2 = b.x + b.w; s1 = -1; s2 = 1; }
      else if (a.x + a.w / 2 <= b.x + b.w / 2) { x1 = a.x + a.w; x2 = b.x; }
      else { x1 = a.x; x2 = b.x + b.w; s1 = -1; s2 = 1; }
      y1 = a.y + a.h / 2;
      y2 = b.y + b.h / 2;
      const dx = Math.max(40, Math.min(120, Math.abs(x2 - x1) / 2));
      c1x = x1 + s1 * dx;
      c1y = y1;
      c2x = x2 + s2 * dx;
      c2y = y2;
    }
    const d = `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
    return { d, css: `path('${d}')`, edgeId: null, reverse: false, mid: { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * c1y + 3 * c2y + y2) / 8 } };
  }

  /** Puntos del mundo a los que apunta el globo del paso actual. */
  private xAnchor(step: DbExplainStep): XAnchor | null {
    const ex = this.explain;
    if (!ex) return null;
    const flow = this.xFlow;
    if (flow) return { v: [flow.mid, flow.mid], rect: { x: flow.mid.x, y: flow.mid.y, w: 0, h: 0 } };
    const above = (r: Rect): [Point, Point] => [{ x: r.x + r.w / 2, y: r.y }, { x: r.x + r.w / 2, y: r.y + r.h }];
    const actorId = [step.to, step.from].find((id) => isExplainActor(id));
    if (actorId) {
      const r = this.placeRect(actorId);
      if (r) return { v: above(r), rect: r };
    }
    const node = this.nodeIndex.get(step.to ?? '') ?? this.nodeIndex.get(ex.script.table);
    if (!node) return null;
    const r = this.nodeRect(node);
    if (step.kind === 'fill' || step.kind === 'note') {
      const y = node.y + Math.min(node.h / 2, 80);
      return { h: [{ x: node.x + NODE_W + 12, y }, { x: node.x - 12, y }], v: above(r), rect: r };
    }
    return { v: above(r), rect: r };
  }

  /** Escala del globo: en modo esquema sigue al zoom absoluto (igual que las tablas); fuera de él, siempre 1. */
  private balloonScale(): number {
    if (!this.schemaMode || !this.explain) return 1;
    return Math.round(Math.min(Math.max(this.view.z, MIN_ZOOM), MAX_ZOOM) * 100) / 100;
  }

  /** Globo del paso actual en coordenadas de pantalla (en modo esquema escala con el zoom relativo al encuadre), con la cola hacia su ancla. */
  get xBalloon(): XBalloon | null {
    const ex = this.explain;
    const el = this.canvasEl;
    const step = this.xStep;
    if (!ex || !el || !step) return null;
    const anchor = this.xAnchor(step);
    if (!anchor) return null;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    // Modo esquema: el globo busca un hueco libre que no tape tarjetas, píldoras ni la cabecera.
    if (this.schemaMode) {
      const s = this.balloonScale();
      const h = this.balloonHeight(ex, s);
      const { x, y, z } = this.view;
      const key = `${ex.token}|${ex.player.stepKey}|${this.layoutVersion}|${x}|${y}|${z}|${cw}|${ch}|${h}|${s}`;
      if (this.schemaBalloonCache?.key === key) return this.schemaBalloonCache.balloon;
      const placed = this.placeSchemaBalloon(ex, step, anchor, cw, ch);
      // Sin la cabecera aún en el DOM no se cachea: se recalcula en el siguiente ciclo.
      if (placed.ready) this.schemaBalloonCache = { key, balloon: placed.balloon };
      return placed.balloon;
    }
    const pw = Math.min(BALLOON_W, Math.max(120, cw - 16));
    const { x: vx, y: vy, z } = this.view;
    const screen = (p: Point): Point => ({ x: vx + p.x * z, y: vy + p.y * z });
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const num = (value: number) => `${Math.round(value)}px`;

    if (anchor.h) {
      const right = screen(anchor.h[0]);
      const left = screen(anchor.h[1]);
      const side = right.x + BALLOON_GAP + pw <= cw - 8 ? 'right' : left.x - BALLOON_GAP - pw >= 8 ? 'left' : null;
      if (side) {
        const p = side === 'right' ? right : left;
        const top = clamp(p.y, 100, ch - 100);
        return {
          placement: side,
          style: {
            left: num(side === 'right' ? p.x + BALLOON_GAP : p.x - BALLOON_GAP), top: num(top), width: num(pw),
            translate: side === 'right' ? '0 -50%' : '-100% -50%', '--tail': num(clamp(p.y - top, -40, 40)),
          },
        };
      }
    }
    return this.verticalBalloon(anchor, cw, ch, pw);
  }

  /** Colocación clásica encima o debajo del ancla. */
  private verticalBalloon(anchor: XAnchor, cw: number, ch: number, pw: number, s = 1): XBalloon {
    const { x: vx, y: vy, z } = this.view;
    const screen = (p: Point): Point => ({ x: vx + p.x * z, y: vy + p.y * z });
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const num = (value: number) => `${Math.round(value)}px`;
    const v = anchor.v ?? anchor.h ?? [{ x: anchor.rect.x + anchor.rect.w / 2, y: anchor.rect.y }, { x: anchor.rect.x + anchor.rect.w / 2, y: anchor.rect.y + anchor.rect.h }];
    const up = screen(v[0]);
    const down = screen(v[1]);
    const hEst = BALLOON_H_EST * s;
    const gap = BALLOON_GAP * s;
    const placeAbove = up.y - gap - hEst >= 8;
    const p = placeAbove ? up : down;
    const boxLeft = clamp(p.x, pw / 2 + 8, cw - pw / 2 - 8);
    const tail = clamp(p.x - (boxLeft - pw / 2), 16, pw - 16);
    const top = placeAbove ? Math.max(hEst + 8, up.y - gap) : Math.min(down.y + gap, ch - 120);
    return {
      placement: placeAbove ? 'above' : 'below',
      style: {
        left: num(boxLeft), top: num(top), width: num(pw), translate: placeAbove ? '-50% -100%' : '-50% 0', '--tail': num(tail), '--bz': String(s),
      },
    };
  }

  /** Alto del globo del paso actual a la escala `s`: el medido si es de este paso (reescalado si cambió la escala); si no, la estimación. */
  private balloonHeight(ex: ExplainState, s = 1): number {
    const m = this.balloonMeasure;
    if (!m || m.key !== `${ex.token}|${ex.player.stepKey}`) return BALLOON_H_EST * s;
    return m.s === s ? m.h : (m.h * s) / m.s;
  }

  /** Mide el globo; dentro de un mismo paso el alto solo crece (la colocación no oscila). */
  private onBalloonResize(el: HTMLElement): void {
    const ex = this.explain;
    if (!ex || this.destroyed || el !== this.balloonEl) return;
    const key = `${ex.token}|${ex.player.stepKey}`;
    const h = el.offsetHeight;
    if (!h) return;
    const s = parseFloat(el.style.getPropertyValue('--bz')) || 1;
    const prev = this.balloonMeasure;
    if (prev && prev.key === key && prev.s === s && h <= prev.h + 2) return;
    this.balloonMeasure = { key, h, s };
    this.zone.run(() => this.cdr.markForCheck());
  }

  /**
   * Modo esquema: primer hueco libre (derecha, izquierda, debajo y encima del destino, con 3 alineaciones cada uno;
   * después los canales libres a los lados del contenido). Si ninguno está libre, el que menos área tapa.
   */
  private placeSchemaBalloon(ex: ExplainState, step: DbExplainStep, anchor: XAnchor, cw: number, ch: number): { balloon: XBalloon; ready: boolean } {
    const M = 8;
    const PAD = 6;
    const s = this.balloonScale();
    const gap = BALLOON_GAP * s;
    const minW = NODE_W * s * 0.85;
    const pw = Math.min(NODE_W * s, Math.max(120, cw - 16));
    const h = this.balloonHeight(ex, s);
    const { x: vx, y: vy, z } = this.view;
    const toScreen = (r: Rect): Rect => ({ x: vx + r.x * z, y: vy + r.y * z, w: r.w * z, h: r.h * z });
    const inflate = (r: Rect): Rect => ({ x: r.x - PAD, y: r.y - PAD, w: r.w + 2 * PAD, h: r.h + 2 * PAD });
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
    const num = (value: number) => `${Math.round(value)}px`;

    const node = ex.driven ? this.nodeIndex.get(step.table || step.to || '') : undefined;
    const T = toScreen(node ? this.nodeRect(node) : anchor.rect);
    const tr = T.x + T.w;
    const tb = T.y + T.h;
    const tcx = T.x + T.w / 2;
    const tcy = T.y + T.h / 2;

    // Obstáculos en pantalla: tarjetas visibles, píldoras, cabecera y barra de «Explicar».
    const obstacles: Rect[] = [];
    let contentL = Infinity;
    let contentR = -Infinity;
    const addContent = (r: Rect) => {
      obstacles.push(inflate(r));
      contentL = Math.min(contentL, r.x);
      contentR = Math.max(contentR, r.x + r.w);
    };
    for (const n of this.nodes) {
      const r = toScreen(this.nodeRect(n));
      if (r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= cw || r.y >= ch) continue;
      addContent(r);
    }
    for (const a of this.xActors) addContent(toScreen({ x: a.x, y: a.y, w: a.w, h: a.h }));
    const hostEl = this.host.nativeElement;
    const head = hostEl.querySelector<HTMLElement>('.wtd-xhead');
    for (const chrome of [head, hostEl.querySelector<HTMLElement>('.wtd-xbar')]) {
      if (chrome) obstacles.push(inflate({ x: chrome.offsetLeft, y: chrome.offsetTop, w: chrome.offsetWidth, h: chrome.offsetHeight }));
    }

    type Candidate = { x: number; y: number; w: number; side: XBalloon['placement'] };
    const candidates: Candidate[] = [];
    const yOf = (y: number) => clamp(y, M, ch - M - h);
    const xOf = (x: number, w: number) => clamp(x, M, cw - M - w);
    const lateral = (x: number, w: number, side: 'right' | 'left') => {
      if (w < minW) return;
      for (const y of [tcy - h / 2, T.y, tb - h]) candidates.push({ x, y: yOf(y), w, side });
    };
    const vertical = (y: number, side: 'above' | 'below') => {
      for (const x of [tcx - pw / 2, T.x, tr - pw]) candidates.push({ x: xOf(x, pw), y, w: pw, side });
    };
    const rightX = tr + gap;
    lateral(rightX, Math.min(pw, cw - M - rightX), 'right');
    const leftW = Math.min(pw, T.x - gap - M);
    lateral(T.x - gap - leftW, leftW, 'left');
    if (tb + gap + h <= ch - M) vertical(tb + gap, 'below');
    if (T.y - gap - h >= M) vertical(T.y - gap - h, 'above');
    if (Number.isFinite(contentR)) {
      const x = contentR + gap;
      const w = Math.min(pw, cw - M - x);
      if (w >= minW) candidates.push({ x, y: yOf(tcy - h / 2), w, side: 'right' });
    }
    if (Number.isFinite(contentL)) {
      const w = Math.min(pw, contentL - gap - M);
      if (w >= minW) candidates.push({ x: contentL - gap - w, y: yOf(tcy - h / 2), w, side: 'left' });
    }

    const overlap = (c: Candidate): number => {
      let total = 0;
      for (const o of obstacles) {
        const ix = Math.min(c.x + c.w, o.x + o.w) - Math.max(c.x, o.x);
        const iy = Math.min(c.y + h, o.y + o.h) - Math.max(c.y, o.y);
        if (ix > 0 && iy > 0) total += ix * iy;
      }
      return total;
    };
    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of candidates) {
      const score = overlap(c);
      if (score < bestScore) {
        best = c;
        bestScore = score;
        if (score === 0) break;
      }
    }
    if (!best) return { balloon: this.verticalBalloon(anchor, cw, ch, pw, s), ready: !!head };

    const half = Math.max(0, h / 2 - 14 * s);
    const tail = best.side === 'right' || best.side === 'left'
      ? clamp(tcy - (best.y + h / 2), -half, half)
      : clamp(tcx - best.x, 16, best.w - 16);
    return {
      balloon: {
        placement: best.side,
        style: { left: num(best.x), top: num(best.y), width: num(best.w), translate: '0 0', '--tail': num(tail), '--bz': String(s) },
      },
      ready: !!head,
    };
  }

  trackActor = (_: number, actor: XActor) => actor.id;

  /* ---------------------------- plantilla ---------------------------- */

  isFk(node: TdNode, column: WorkspaceCodeDbColumn): boolean {
    return isForeignKeyColumn(node.table, column.name);
  }

  typeOf(column: WorkspaceCodeDbColumn): string {
    return shortType(column);
  }

  rowTitle(node: TdNode, column: WorkspaceCodeDbColumn): string {
    const fk = node.table.foreignKeys.find((f) => f.columns.includes(column.name));
    const ref = fk ? ` → ${fk.refTable}.${fk.refColumns[fk.columns.indexOf(column.name)] ?? ''}` : '';
    return `${column.name} · ${shortType(column)}${ref}`;
  }

  trackNode = (_: number, node: TdNode) => this.renderKey + '|' + node.name;
  trackEdge = (_: number, edge: TdEdge) => this.renderKey + '|' + edge.id;
  trackColumn = (_: number, column: WorkspaceCodeDbColumn) => column.name;
}
