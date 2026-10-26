import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { NexoBridge } from '../../bridge/nexo-bridge';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { NexoProjectService } from '../../project/nexo-project.service';
import {
  WorkspaceCodeFile,
  codeMimeFor,
  encodeUtf8Base64,
  isCodeFileReady,
  isSensitiveCodeFile,
  normalizeCodePath,
  resolveCodeReference,
} from '../workspace-code.types';
import { CodeRef, FlowStep, UiPlanContext, UiPlanFile, UiPreviewPlan, UiPreviewState } from '../ai/nexo-ia.types';
import { ChangeProposal, FileChange } from '../ai/nexo-ia.changes.types';
import { applyFileChange, resolveChangeTarget, safeRelativePath, sha256Hex } from '../ai/workspace-code-ai-change-patch';
import { maskConfigSecrets, maskSensitiveText } from '../ai/workspace-code-ai-mask';
import { FlowRefValidator } from '../ai/workspace-code-flow-ref-validator';
import { sanitizeUiPreviewPlan } from '../ai/workspace-code-flow-sanitize';
import { isContextExcludedDir } from '../ai/workspace-code-context-exclude';
import { compileScss } from '../ai/workspace-code-scss-compiler';
import {
  ComponentMeta,
  childTags,
  extractTsDefaults,
  focusTsForAi,
  parseComponentMeta,
  stripTsForAi,
  templateTokens,
  trimGlobalCss,
  trimTemplateForAi,
  tsMethods,
} from '../ai/workspace-code-ui-component';
import {
  NX_IMAGE_PLACEHOLDER,
  UiPreviewTone,
  UiPreviewVariant,
  applyContentAttr,
  buildSrcdoc,
  encapsulateCss,
  markAndDecorate,
  resolveTemplate,
  reverseFileChange,
  sanitizeCss,
  sanitizeFragmentDom,
  stripInlineAssets,
  uiToneOf,
} from '../ai/workspace-code-ui-preview-render';
import { UiPlanRequest, UiScreenContext, WorkspaceCodeAiFlowService } from './workspace-code-ai-flow.service';

export type UiPreviewTab = UiPreviewVariant;
export type UiScreenStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Tamaños de pantalla de la vista. */
export type UiViewportId = 'desktop' | 'laptop' | 'tablet' | 'mobile';

export interface UiViewportSpec {
  id: UiViewportId;
  width: number;
  height: number;
  /** Clase de Bootstrap Icons. */
  icon: string;
  /** Clave i18n con nombre y medidas. */
  key: string;
}

export const UI_VIEWPORTS: readonly UiViewportSpec[] = [
  { id: 'desktop', width: 1920, height: 1080, icon: 'bi-display', key: 'aiFlow.screen.vp.desktop' },
  { id: 'laptop', width: 1280, height: 800, icon: 'bi-laptop', key: 'aiFlow.screen.vp.laptop' },
  { id: 'tablet', width: 768, height: 1024, icon: 'bi-tablet', key: 'aiFlow.screen.vp.tablet' },
  { id: 'mobile', width: 390, height: 844, icon: 'bi-phone', key: 'aiFlow.screen.vp.mobile' },
];

/** Vista pintada de una pestaña («Ahora» / «Con el cambio»). */
export interface UiScreenView {
  srcdoc: string;
  approximate: boolean;
  caption: string;
  state: UiPreviewState;
  /** Tamaño de pantalla con el que se calculó. */
  viewport: UiViewportId;
  /**
   * Documento al ancho del tamaño elegido: `width` = ancho del viewport, `height` = alto del documento,
   * `viewportHeight` = alto de la ventana simulada; `crop` = encuadre (raíz del plan) en píxeles del documento.
   */
  frame: { width: number; height: number; viewportHeight: number; crop: { x: number; y: number; w: number; h: number } };
}

/** Partes de una variante independientes del tamaño de pantalla (CSS y HTML ya saneados). */
interface ViewParts {
  globalCss: string;
  componentCss: string;
  html: string;
  tone: UiPreviewTone;
  root: string;
  caption: string;
  state: UiPreviewState;
  approximate: boolean;
}

type PartsPair = { now?: ViewParts; after?: ViewParts };
type ViewPair = { now?: UiScreenView; after?: UiScreenView };

interface AssetMapping {
  /** Prefijo de URL servido (`assets/`, `''`) o URL exacta si `exact`. */
  url: string;
  /** Carpeta (o archivo si `exact`) relativa al montaje. */
  dir: string;
  exact: boolean;
}

interface AngularBuildConfig {
  styles: string[];
  assets: AssetMapping[];
}

/** Componente de la pantalla resuelto a partir del paso ancla. */
interface ScreenTarget {
  ts: WorkspaceCodeFile;
  meta: ComponentMeta;
  prefix: string;
}

interface SourceFile {
  path: string;
  text: string;
  /** Archivo real (`null` en plantillas o estilos inline: viven en el `.ts`). */
  file: WorkspaceCodeFile | null;
}

interface ComponentSource {
  /** Etiqueta del host (primer selector de elemento) o `''`. */
  tag: string;
  selector: string;
  name: string;
  ts: SourceFile;
  html: SourceFile;
  css: SourceFile[];
  inlineTemplate: boolean;
  inlineStyles: boolean;
}

interface RenderEnv {
  validator: FlowRefValidator;
  isAllowed: (file: WorkspaceCodeFile) => boolean;
  /** Prefijo del montaje (`ruta/` o vacío). */
  prefix: string;
  assetsTotal: number;
  approximate: boolean;
  /** Assets ya incrustados (ruta → data URI o `null`). */
  assets: Map<string, string | null>;
  /** `angular.json` del montaje (`undefined` = aún no leído; `null` = no existe o no es válido). */
  angular?: AngularBuildConfig | null;
}

interface ScreenBuild {
  env: RenderEnv;
  root: ComponentSource;
  children: ComponentSource[];
  globals: { path: string; css: string }[];
  contextJson: string;
  contextBase64: string;
  planKey: string;
  filesKey: string;
  /** Recorte de la plantilla raíz (mismo para la IA y el render); `null` si cabe entera. */
  htmlTrim: { terms: string[]; secondary: string[]; max: number; blockMax: number } | null;
}

type TsMethod = { name: string; start: number; end: number };

const TERM_NAME = /^[A-Za-z_$][\w$]{2,}$/;
const TERM_EXCLUDED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'typeof', 'await', 'async', 'const', 'let', 'var',
  'this', 'super', 'class', 'constructor', 'void', 'delete', 'instanceof', 'true', 'false', 'null', 'undefined',
  'subscribe', 'then', 'next', 'emit', 'push', 'get', 'post', 'set',
]);

/** Fallo con mensaje ya traducido. */
class ScreenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScreenError';
  }
}

const DEFAULT_VIEWPORT: UiViewportId = 'laptop';
const VIEWPORT_STATE_KEY = 'uiPreviewViewport';
const MAX_DOC_H = 4000;
/** Ancho útil de la miniatura con el popup listo (420 − 22). */
const THUMB_W = 398;
const THUMB_MAX_H = 280;
const CROP_MARGIN = 8;
const MAX_GLOBAL_CSS = 1536 * 1024;
const MAX_COMPONENT_CSS = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_SVG_BYTES = 512 * 1024;
const MAX_FONT_BYTES = 400 * 1024;
/** Hoja global de un paquete (bootstrap.min.css ronda 230 KB). */
const MAX_PACKAGE_CSS_BYTES = 600 * 1024;
const MAX_ASSETS_TOTAL = 8 * 1024 * 1024;
const MAX_SRCDOC = 14 * 1024 * 1024;
const MAX_CACHE = 30;
/** Partes renderizadas (pueden llevar imágenes incrustadas: límite bajo). */
const MAX_RENDER_CACHE = 6;
/** Vistas por tamaño de la carga actual (LRU). */
const MAX_VIEW_CACHE = 2;
/** SVG con contenido activo: se rechaza (placeholder). */
const SVG_UNSAFE = /<script\b|<foreignObject\b|\son[a-z]+\s*=|javascript:|<!ENTITY/i;
const MAX_INDEX_FILES = 200;
const MAX_CHILDREN = 8;
/** Límites del contrato UI_PLAN (los valida también el backend). */
const LIMIT_FILE = 60000;
const LIMIT_SHEETS = 4;
const LIMIT_CHILD_FILE = 30000;
/** CSS global enviado a la IA (el render usa el completo). */
const GLOBAL_CSS_AI_CHARS = 12000;
const LIMIT_SIMULATION = 20000;
const LIMIT_CHANGE = 40000;
const LIMIT_JSON = 300000;
const MAX_CONTEXT_BASE64 = 390000;
/** Recortes por tamaño de la entrada. */
const SOFT_TOKENS = 8000;
const HARD_CHARS = 48000;
const TS_TRUNCATE = 24000;
/** Plantilla raíz > LIMIT_FILE: fragmento de los pasos (IA y render) y bloques máximos. */
const TRIM_HTML_CHARS = 24000;
const TRIM_BLOCK_CHARS = 12000;
/** Hoja del componente recortada a las reglas usadas (solo IA). */
const COMPONENT_CSS_AI_CHARS = 16000;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp']);
const FONT_EXTENSIONS = new Set(['woff2', 'woff', 'ttf', 'otf']);
const ELEMENT_SELECTOR = /^[a-zA-Z][\w-]*$/;

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function normPath(p: string | null | undefined): string {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
}

function extOf(path: string): string {
  const name = basename(path);
  const at = name.lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

function firstElementSelector(selector: string): string {
  for (const part of selector.split(',')) {
    const s = part.trim();
    if (ELEMENT_SELECTOR.test(s)) return s.toLowerCase();
  }
  return '';
}

function remember<K, V>(map: Map<K, V>, key: K, value: V, max = MAX_CACHE): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function isViewportId(value: unknown): value is UiViewportId {
  return typeof value === 'string' && UI_VIEWPORTS.some((v) => v.id === value);
}

function viewportSpec(id: UiViewportId): UiViewportSpec {
  return UI_VIEWPORTS.find((v) => v.id === id) ?? UI_VIEWPORTS.find((v) => v.id === DEFAULT_VIEWPORT)!;
}

/** Recorta CSS por el último cierre de regla antes de `max`. */
function cutCss(css: string, max: number): string {
  if (css.length <= max) return css;
  const at = css.lastIndexOf('}', max - 1);
  return at > 0 ? css.slice(0, at + 1) : css.slice(0, max);
}

/**
 * Vista de pantalla (Nexo IA, fase 2.2). Reúne el componente Angular del paso ancla (ts, html, estilos, hijos de un
 * nivel y estilos globales), pide a la IA solo un `UiPreviewPlan` (< 150 tokens de salida) y pinta en local, con el
 * HTML y el CSS reales, «Ahora» y «Con el cambio» (diff aplicado en memoria). Iframe sin scripts y CSP estricta.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeAiUiPreviewService implements OnDestroy {
  readonly changed$ = new Subject<void>();
  /** Abrir: el diagrama hace scroll hasta el popup. */
  readonly reveal$ = new Subject<void>();

  status: UiScreenStatus = 'idle';
  open = false;
  tab: UiPreviewTab = 'now';
  ctx: UiScreenContext | null = null;
  target: ScreenTarget | null = null;
  /** Paso con «Visualizar pantalla» (-1 = ninguno). */
  screenStep = -1;
  componentName = '';
  /** `nombre.component.ts · .html · .scss`. */
  refLine = '';
  plan: UiPreviewPlan | null = null;
  views: ViewPair = {};
  /** Vista ampliada a tamaño real. */
  zoom = false;
  errorText: string | null = null;
  /** Tamaño de pantalla elegido (persistido en el estado de la webview). */
  viewport: UiViewportId = DEFAULT_VIEWPORT;
  /** Recalculando las vistas para otro tamaño. */
  viewportBusy = false;
  readonly viewports = UI_VIEWPORTS;

  private loadRun = 0;
  private resolveRun = 0;
  private viewportRun = 0;
  private pending: UiPlanRequest | null = null;
  private readonly planCache = new Map<string, UiPreviewPlan>();
  private readonly renderCache = new Map<string, PartsPair>();
  /** Partes de la carga actual (para recalcular otros tamaños sin volver a renderizar). */
  private parts: PartsPair | null = null;
  /** Vistas de la carga actual por tamaño (LRU de `MAX_VIEW_CACHE`). */
  private readonly viewCache = new Map<UiViewportId, ViewPair>();
  /** Índice perezoso `ruta en minúsculas → archivo` (se rehace si cambia la lista de archivos). */
  private ciIndex: { files: readonly WorkspaceCodeFile[]; map: Map<string, WorkspaceCodeFile> } | null = null;
  /** Índice de selectores por montaje (selector → ruta del `.ts`). */
  private readonly selectorIndex = new Map<string, Map<string, string>>();
  /** Hijos resueltos por montaje y etiqueta (ruta del `.ts` o `null`). */
  private readonly childPaths = new Map<string, string | null>();

  constructor(
    private project: NexoProjectService,
    private i18n: WorkspaceCodeI18nService,
    private flowService: WorkspaceCodeAiFlowService,
    private bridge: NexoBridge,
  ) {
    const saved = this.bridge.getUiState(VIEWPORT_STATE_KEY);
    this.viewport = isViewportId(saved) ? saved : DEFAULT_VIEWPORT;
  }

  ngOnDestroy(): void {
    this.cancelPlan();
    this.resolveRun++;
    this.clearViewState();
    this.changed$.complete();
    this.reveal$.complete();
  }

  /* ---------------------------- estado ---------------------------- */

  /** Contexto del resultado visible: una identidad nueva cancela y resetea (sin abrir el popup). */
  sync(ctx: UiScreenContext | null): void {
    if (!ctx) {
      if (!this.ctx && this.status === 'idle' && !this.open && this.screenStep < 0) return;
      this.reset();
      this.changed$.next();
      return;
    }
    const prev = this.ctx;
    if (prev && prev.key === ctx.key) {
      this.ctx = ctx;
      if (prev.initialTab !== ctx.initialTab) {
        const tab: UiPreviewTab = ctx.initialTab === 'after' && ctx.proposal ? 'after' : 'now';
        if (this.status === 'ready') this.setTab(tab);
        else this.tab = tab;
      }
      return;
    }
    this.reset();
    this.ctx = ctx;
    this.tab = ctx.initialTab === 'after' && ctx.proposal ? 'after' : 'now';
    this.changed$.next();
    const run = ++this.resolveRun;
    void this.resolveTarget(ctx, run);
  }

  /** «Visualizar pantalla»: abre el popup y, si no está listo ni cargando, reúne el contexto y pide el plan. */
  show(tab?: UiPreviewTab): void {
    const ctx = this.ctx;
    if (!ctx || !this.target) return;
    this.open = true;
    if (tab === 'now' || (tab === 'after' && ctx.proposal)) this.tab = tab;
    this.changed$.next();
    this.reveal$.next();
    if (this.status === 'ready' || this.status === 'loading') return;
    void this.load();
  }

  retry(): void {
    if (this.status === 'loading') return;
    this.status = 'idle';
    this.show();
  }

  setTab(tab: UiPreviewTab): void {
    if (this.tab === tab) return;
    if (tab === 'after' && !this.ctx?.proposal) return;
    this.tab = tab;
    this.changed$.next();
  }

  close(): void {
    if (!this.open && this.status !== 'loading') return;
    if (this.status === 'loading') {
      this.cancelPlan();
      this.status = 'idle';
    }
    this.open = false;
    this.zoom = false;
    this.changed$.next();
  }

  openZoom(): void {
    if (this.status !== 'ready' || this.zoom) return;
    this.zoom = true;
    this.changed$.next();
  }

  closeZoom(): void {
    if (!this.zoom) return;
    this.zoom = false;
    this.changed$.next();
  }

  /**
   * Cambia el tamaño de pantalla: con la vista lista recalcula srcdoc y medida sobre las partes ya renderizadas
   * (sin IA ni DOM nuevo) y los cachea por tamaño; si no, solo lo guarda para la próxima carga.
   */
  async setViewport(id: UiViewportId): Promise<void> {
    if (!isViewportId(id) || id === this.viewport || this.viewportBusy) return;
    const previous = this.viewport;
    this.viewport = id;
    this.bridge.setUiState(VIEWPORT_STATE_KEY, id);
    const parts = this.parts;
    if (this.status !== 'ready' || !parts) {
      this.changed$.next();
      return;
    }
    const cached = this.viewCache.get(id);
    if (cached) {
      remember(this.viewCache, id, cached, MAX_VIEW_CACHE);
      this.assignViews(cached);
      this.changed$.next();
      return;
    }
    const run = ++this.viewportRun;
    this.viewportBusy = true;
    this.changed$.next();
    try {
      const views = await this.finishViews(parts, viewportSpec(id));
      if (run !== this.viewportRun) return;
      remember(this.viewCache, id, views, MAX_VIEW_CACHE);
      this.assignViews(views);
    } catch (error: unknown) {
      if (run !== this.viewportRun) return;
      console.warn('[Nexo IA] No se pudo cambiar el tamaño de la vista.', error instanceof Error ? error.name : '');
      this.viewport = previous;
      this.bridge.setUiState(VIEWPORT_STATE_KEY, previous);
    } finally {
      if (run === this.viewportRun) {
        this.viewportBusy = false;
        this.changed$.next();
      }
    }
  }

  get view(): UiScreenView | null {
    return this.views[this.tab] ?? this.views.now ?? null;
  }

  private assignViews(views: ViewPair): void {
    this.views = views;
    if (this.tab === 'after' && !views.after) this.tab = 'now';
  }

  /** Descarta las vistas por tamaño y cualquier recálculo en curso. */
  private clearViewState(): void {
    this.viewportRun++;
    this.viewportBusy = false;
    this.parts = null;
    this.viewCache.clear();
  }

  private reset(): void {
    this.cancelPlan();
    this.resolveRun++;
    this.clearViewState();
    this.ctx = null;
    this.status = 'idle';
    this.open = false;
    this.zoom = false;
    this.tab = 'now';
    this.target = null;
    this.screenStep = -1;
    this.componentName = '';
    this.refLine = '';
    this.plan = null;
    this.views = {};
    this.errorText = null;
  }

  /** Cancela la petición del plan en curso (HTTP o tarea de Claude). */
  private cancelPlan(): void {
    this.loadRun++;
    const pending = this.pending;
    this.pending = null;
    if (pending) pending.cancel();
  }

  /* ---------------------------- componente del paso ancla ---------------------------- */

  private async resolveTarget(ctx: UiScreenContext, run: number): Promise<void> {
    const flow = this.flowService.flow;
    if (!flow) return;
    try {
      const isAllowed = await this.project.fileFilter();
      const validator = new FlowRefValidator(this.project, isAllowed);
      for (let i = Math.min(ctx.anchor, flow.steps.length - 1); i >= 0; i--) {
        const step = flow.steps[i];
        const refs = [step.ref, step.snippet?.ref ?? null].filter((r): r is CodeRef => !!r && r.verification !== 'unverified');
        for (const ref of refs) {
          const target = await this.componentForRef(ref, validator, isAllowed);
          if (run !== this.resolveRun) return;
          if (!target) continue;
          this.target = target;
          this.screenStep = ctx.anchor;
          this.componentName = target.meta.className;
          this.refLine = this.refLineOf(target);
          this.changed$.next();
          return;
        }
      }
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudo localizar el componente de la pantalla.', error instanceof Error ? error.name : '');
    }
  }

  private refLineOf(target: ScreenTarget): string {
    const htmlExt = target.meta.templateUrl ? extOf(target.meta.templateUrl) || 'html' : 'html';
    const styleUrl = target.meta.styleUrls[0];
    const styleExt = styleUrl ? extOf(styleUrl) || 'css' : target.meta.styles.length ? 'css' : '';
    return [basename(target.ts.path), `.${htmlExt}`, styleExt ? `.${styleExt}` : ''].filter(Boolean).join(' · ');
  }

  /** `.ts` con `@Component`; `.html` → `.ts` hermano cuyo `templateUrl` apunta a él; hoja → `.ts` hermano. */
  private async componentForRef(ref: CodeRef, validator: FlowRefValidator, isAllowed: (f: WorkspaceCodeFile) => boolean): Promise<ScreenTarget | null> {
    if (!safeRelativePath(ref.file)) return null;
    const file = validator.resolveFile(ref);
    if (!validator.usable(file)) return null;
    const prefix = this.mountPrefix(file);
    const ext = extOf(file.path);
    if (ext === 'ts') return this.asComponent(file, validator, prefix);
    if (ext !== 'html' && ext !== 'htm' && ext !== 'scss' && ext !== 'css' && ext !== 'sass') return null;
    const dir = dirname(file.path);
    const siblings = this.project.project.files.filter((f) => dirname(f.path) === dir && f.extension === 'ts' && !/\.spec\.ts$/i.test(f.name) && isAllowed(f));
    const stem = file.name.replace(/\.[^.]+$/, '');
    siblings.sort((a, b) => Number(b.name === `${stem}.ts`) - Number(a.name === `${stem}.ts`));
    for (const ts of siblings) {
      const target = await this.asComponent(ts, validator, prefix);
      if (!target) continue;
      const meta = target.meta;
      if (ext === 'html' || ext === 'htm') {
        if (meta.templateUrl && resolveCodeReference(ts.path, meta.templateUrl) === file.path) return target;
      } else if (meta.styleUrls.some((u) => resolveCodeReference(ts.path, u) === file.path) || ts.name === `${stem}.ts`) {
        return target;
      }
    }
    return null;
  }

  private async asComponent(file: WorkspaceCodeFile, validator: FlowRefValidator, prefix: string): Promise<ScreenTarget | null> {
    const lines = await validator.linesOf(file);
    if (!lines) return null;
    const meta = parseComponentMeta(lines.join('\n'));
    if (!meta) return null;
    if (!meta.templateUrl && meta.template === undefined) return null;
    return { ts: file, meta, prefix };
  }

  /* ---------------------------- carga ---------------------------- */

  private async load(): Promise<void> {
    const ctx = this.ctx;
    const target = this.target;
    if (!ctx || !target) return;
    this.cancelPlan();
    const run = this.loadRun;
    this.clearViewState();
    this.status = 'loading';
    this.errorText = null;
    this.zoom = false;
    this.changed$.next();
    try {
      const build = await this.buildContext(ctx, target);
      if (run !== this.loadRun) return;
      let plan = this.planCache.get(build.planKey) ?? null;
      if (!plan) {
        const request = this.flowService.requestUiPlan(build.contextBase64);
        this.pending = request;
        const outcome = await request.promise;
        if (this.pending === request) this.pending = null;
        if (run !== this.loadRun || outcome.status === 'cancelled') return;
        if (outcome.status === 'error') throw new ScreenError(outcome.message);
        plan = sanitizeUiPreviewPlan(outcome.plan);
        const tokensIn = Math.round(build.contextJson.length / 4);
        const tokensOut = plan ? Math.round(JSON.stringify(plan).length / 4) : 0;
        console.info(`[Nexo IA] Vista de pantalla: tokens entrada≈${tokensIn} salida≈${tokensOut}`);
        if (tokensIn > SOFT_TOKENS) console.warn(`[Nexo IA] Vista de pantalla: la entrada supera ${SOFT_TOKENS} tokens (≈${tokensIn}).`);
        if (!plan) throw new ScreenError(this.i18n.t('aiFlow.screen.failed'));
        remember(this.planCache, build.planKey, plan);
      }
      const parts = await this.renderViews(plan, build, ctx);
      if (run !== this.loadRun) return;
      const vp = this.viewport;
      const views = await this.finishViews(parts, viewportSpec(vp));
      if (run !== this.loadRun) return;
      this.plan = plan;
      this.parts = parts;
      this.viewCache.clear();
      remember(this.viewCache, vp, views, MAX_VIEW_CACHE);
      this.assignViews(views);
      this.status = 'ready';
      this.changed$.next();
    } catch (error: unknown) {
      if (run !== this.loadRun) return;
      if (!(error instanceof ScreenError)) console.warn('[Nexo IA] Vista de pantalla no disponible.', error instanceof Error ? error.name : '');
      this.status = 'error';
      this.errorText = error instanceof ScreenError ? error.message : this.i18n.t('aiFlow.screen.failed');
      this.changed$.next();
    }
  }

  /* ---------------------------- contexto ---------------------------- */

  private envFor(prefix: string, validator: FlowRefValidator, isAllowed: (f: WorkspaceCodeFile) => boolean): RenderEnv {
    return { validator, isAllowed, prefix, assetsTotal: 0, approximate: false, assets: new Map() };
  }

  private async buildContext(ctx: UiScreenContext, target: ScreenTarget): Promise<ScreenBuild> {
    const flow = this.flowService.flow;
    if (!flow) throw new ScreenError(this.i18n.t('aiFlow.screen.failed'));
    const isAllowed = await this.project.fileFilter();
    const validator = new FlowRefValidator(this.project, isAllowed);
    const env = this.envFor(target.prefix, validator, isAllowed);
    const root = await this.componentSource(target.ts, env);
    if (!root) throw new ScreenError(this.i18n.t('aiFlow.screen.failed'));
    // Componentes grandes: plantilla recortada a la región de los pasos (la misma para la IA y para el render).
    const tsStripped = stripTsForAi(root.ts.text);
    const needHtml = root.html.text.length > LIMIT_FILE;
    const needTs = tsStripped.length > TS_TRUNCATE;
    let methods: TsMethod[] = [];
    let terms: { primary: string[]; callers: string[]; callees: string[]; secondary: string[] } = { primary: [], callers: [], callees: [], secondary: [] };
    if (needHtml || needTs) {
      try {
        methods = tsMethods(tsStripped);
      } catch (error: unknown) {
        console.warn('[Nexo IA] No se pudieron leer los métodos del componente.', error instanceof Error ? error.name : '');
        methods = [];
      }
      terms = this.screenTerms(flow.steps, ctx.anchor, methods, tsStripped);
    }
    let htmlTrim: ScreenBuild['htmlTrim'] = null;
    let viewHtml = root.html.text;
    if (needHtml) {
      htmlTrim = {
        terms: [...new Set([...terms.primary, ...terms.callers])],
        secondary: terms.secondary,
        max: TRIM_HTML_CHARS,
        blockMax: TRIM_BLOCK_CHARS,
      };
      viewHtml = trimTemplateForAi(root.html.text, htmlTrim.terms, htmlTrim.max, htmlTrim.blockMax, htmlTrim.secondary).html;
      env.approximate = true;
    }
    const children: ComponentSource[] = [];
    for (const tag of childTags(viewHtml).slice(0, MAX_CHILDREN)) {
      const file = await this.findChild(tag, env);
      const child = file ? await this.componentSource(file, env) : null;
      if (child) children.push({ ...child, tag });
      else env.approximate = true;
    }
    const globals = await this.globalSheets(env);

    // Contexto para la IA (todo enmascarado; límites del contrato).
    const mask = (path: string, text: string): string => maskConfigSecrets(path, maskSensitiveText(text));
    const fileOf = (f: SourceFile, max: number): UiPlanFile => ({ path: f.path, content: mask(f.path, f.text).slice(0, max) });
    const step = flow.steps[ctx.anchor];
    const before = ctx.before;
    const simulation: UiPlanContext['simulation'] = {
      mode: ctx.mode,
      step: { index: ctx.anchor + 1, id: step?.id ?? '', title: step?.title ?? '', label: step?.label ?? '' },
      kind: before.kind,
      badge: before.badge,
      title: before.title,
      userImpact: before.userImpact,
      fix: before.fix,
      input: ctx.input,
    };
    if (before.httpStatus !== undefined) simulation.httpStatus = before.httpStatus;
    if (before.field) simulation.field = before.field;
    if (ctx.afterResult) {
      simulation.after = { kind: ctx.afterResult.kind, badge: ctx.afterResult.badge, title: ctx.afterResult.title, userImpact: ctx.afterResult.userImpact };
    }
    if (JSON.stringify(simulation).length > LIMIT_SIMULATION) {
      let raw = '';
      try {
        raw = JSON.stringify(ctx.input) ?? '';
      } catch (error: unknown) {
        console.warn('[Nexo IA] Datos de entrada no serializables.', error instanceof Error ? error.name : '');
      }
      simulation.input = raw.slice(0, 8000);
      if (JSON.stringify(simulation).length > LIMIT_SIMULATION) simulation.input = null;
    }
    const change = this.changeContext(ctx.proposal);

    // Solo para la IA: TS sin comentarios/imports/console, hijos sin CSS y CSS global recortado a las reglas usadas.
    // El render local sigue usando root/children/globals completos.
    let tsText = tsStripped;
    let kids = children.filter((c) => c.html.text.length <= LIMIT_CHILD_FILE);
    const used = templateTokens([viewHtml, ...kids.map((c) => c.html.text)]);
    const globalCss = cutCss(
      globals.map((g) => trimGlobalCss(g.css, used)).filter((s) => s.trim()).join('\n'),
      GLOBAL_CSS_AI_CHARS,
    );
    // CSS del componente para la IA: hojas grandes (o todas si la plantilla se recortó) → reglas usadas.
    const cssForAi: SourceFile[] = root.css.map((c) => {
      if (!needHtml && c.text.length <= LIMIT_FILE) return c;
      let text: string;
      try {
        text = cutCss(trimGlobalCss(c.text, used), COMPONENT_CSS_AI_CHARS);
      } catch (error: unknown) {
        console.warn('[Nexo IA] No se pudo recortar el CSS del componente.', error instanceof Error ? error.name : '');
        text = cutCss(c.text, COMPONENT_CSS_AI_CHARS);
      }
      if (text !== c.text) env.approximate = true;
      return { ...c, text };
    });
    if (needTs) {
      try {
        const hints = new Set<string>([...used, ...(viewHtml.match(/[A-Za-z_$][\w$]*/g) ?? []), ...terms.secondary]);
        tsText = focusTsForAi(tsStripped, methods, [...terms.primary, ...terms.callees, ...terms.callers], hints, TS_TRUNCATE);
      } catch (error: unknown) {
        console.warn('[Nexo IA] No se pudo enfocar el TS del componente.', error instanceof Error ? error.name : '');
        tsText = tsStripped.slice(0, TS_TRUNCATE);
      }
      env.approximate = true;
    }
    const make = (): UiPlanContext => ({
      flowId: flow.id,
      component: {
        name: root.name,
        selector: root.selector,
        ts: { path: root.ts.path, content: mask(root.ts.path, tsText).slice(0, LIMIT_FILE) },
        html: fileOf({ ...root.html, text: viewHtml }, LIMIT_FILE),
        css: cssForAi.slice(0, LIMIT_SHEETS).map((c) => fileOf(c, LIMIT_FILE)),
      },
      children: kids.map((c) => ({ selector: c.selector, name: c.name, html: fileOf(c.html, LIMIT_CHILD_FILE), css: [] })),
      globalCss: mask('styles.css', globalCss),
      simulation,
      change,
    });
    let json = JSON.stringify(make());
    if (json.length > HARD_CHARS && kids.length > 3) {
      kids = kids.slice(0, 3);
      json = JSON.stringify(make());
    }
    if (json.length > HARD_CHARS && tsText.length > TS_TRUNCATE) {
      tsText = tsText.slice(0, TS_TRUNCATE);
      json = JSON.stringify(make());
    }
    let contextBase64 = encodeUtf8Base64(json);
    // Solo si de otro modo no cabría: menos hijos antes de fallar.
    while ((json.length > LIMIT_JSON || contextBase64.length > MAX_CONTEXT_BASE64) && kids.length) {
      kids = kids.slice(0, -1);
      json = JSON.stringify(make());
      contextBase64 = encodeUtf8Base64(json);
    }
    if (json.length > LIMIT_JSON || contextBase64.length > MAX_CONTEXT_BASE64) throw new ScreenError(this.i18n.t('aiFlow.screen.failed'));
    const planKey = await sha256Hex(`ui-plan\u0000${json}`);
    const filesKey = await sha256Hex(JSON.stringify([
      root.ts.text, root.html.text, root.css.map((c) => c.text), children.map((c) => [c.tag, c.ts.text, c.html.text, c.css.map((s) => s.text)]),
      globals.map((g) => g.css), ctx.proposal ? [ctx.proposal.id, ctx.proposal.status] : null, ctx.mode,
    ]));
    return { env, root, children, globals, contextJson: json, contextBase64, planKey, filesKey, htmlTrim };
  }

  /**
   * Términos de la pantalla: métodos de los pasos hasta el ancla (`primary`), métodos del TS que los llaman
   * (`callers`) y los `this.x(` que llaman ellos (`callees`).
   */
  private screenTerms(steps: FlowStep[], anchor: number, methods: TsMethod[], tsStripped: string):
    { primary: string[]; callers: string[]; callees: string[]; secondary: string[] } {
    const primary: string[] = [];
    const add = (raw: string | null | undefined): void => {
      const name = String(raw ?? '').split('.').pop()?.trim() ?? '';
      if (!TERM_NAME.test(name) || TERM_EXCLUDED.has(name) || primary.includes(name)) return;
      primary.push(name);
    };
    for (let i = Math.min(anchor, steps.length - 1); i >= 0; i--) {
      const step = steps[i];
      if (!step) continue;
      add(step.ref?.functionName);
      add(step.snippet?.ref?.functionName);
      for (const m of String(step.label ?? '').matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
    }
    const callers: string[] = [];
    const callees: string[] = [];
    const secondary: string[] = [];
    if (!methods.length) return { primary, callers, callees, secondary };
    const names = new Set(methods.map((m) => m.name));
    // Sin métodos de los pasos solo se calculan los términos del paso ancla.
    if (primary.length) try {
      const primarySet = new Set(primary);
      const callRe = new RegExp(`(?<![\\w$])(?:${primary.map((t) => t.replace(/[$]/g, '\\$')).join('|')})\\s*\\(`);
      for (const m of methods) {
        if (primarySet.has(m.name) || callers.includes(m.name)) continue;
        // El cuerpo empieza tras la declaración para no contar el propio nombre.
        const body = tsStripped.slice(m.start, m.end);
        const open = body.indexOf('{');
        if (open >= 0 && callRe.test(body.slice(open))) callers.push(m.name);
      }
      for (const m of methods) {
        if (!primarySet.has(m.name)) continue;
        for (const c of tsStripped.slice(m.start, m.end).matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
          const name = c[1];
          if (names.has(name) && !primarySet.has(name) && !callees.includes(name)) callees.push(name);
        }
      }
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudieron relacionar los métodos de los pasos.', error instanceof Error ? error.name : '');
    }
    // Términos secundarios: campos que mutan los métodos de los pasos y campos del TS nombrados en el paso ancla.
    try {
      const taken = new Set<string>([...primary, ...callers, ...callees, ...names]);
      const addSecondary = (name: string): boolean => {
        if (!TERM_NAME.test(name) || TERM_EXCLUDED.has(name) || taken.has(name) || secondary.includes(name)) return false;
        secondary.push(name);
        return true;
      };
      if (primary.length) {
        const byName = new Map(methods.map((m) => [m.name, m] as const));
        const mutRe = /this\.([A-Za-z_$][\w$]*)\s*(?:(?:[-+*/%|&?]{1,2})?=(?![=>])|\.(?:push|unshift|splice|set|next|update)\s*\()/g;
        let mutated = 0;
        for (const name of [...primary, ...callees]) {
          if (mutated >= 12) break;
          const m = byName.get(name);
          if (!m) continue;
          for (const c of tsStripped.slice(m.start, m.end).matchAll(mutRe)) {
            if (mutated >= 12) break;
            if (c[1] && addSecondary(c[1])) mutated++;
          }
        }
      }
      const step = steps[Math.min(anchor, steps.length - 1)];
      if (step) {
        const text = [step.title, step.label, step.explanation, step.codeSnapshot?.lines.join('\n')]
          .filter((s): s is string => typeof s === 'string' && !!s)
          .join('\n')
          .slice(0, 4000);
        const fields = new Map<string, string>();
        for (const f of tsStripped.matchAll(/this\.([A-Za-z_$][\w$]*)/g)) {
          const name = f[1];
          if (name && !names.has(name) && !fields.has(name.toLowerCase())) fields.set(name.toLowerCase(), name);
        }
        let named = 0;
        for (const w of text.match(/[A-Za-z_$][\w$]{3,}/g) ?? []) {
          if (named >= 6) break;
          const lw = w.toLowerCase();
          const hit = fields.get(lw) ?? fields.get(`${lw}s`) ?? (lw.endsWith('s') && lw.length > 1 ? fields.get(lw.slice(0, -1)) : undefined);
          if (hit && addSecondary(hit)) named++;
        }
      }
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudieron calcular los términos secundarios.', error instanceof Error ? error.name : '');
      secondary.length = 0;
    }
    return { primary, callers, callees, secondary };
  }

  private changeContext(proposal: ChangeProposal | null): UiPlanContext['change'] {
    if (!proposal) return null;
    const files = proposal.files.map((f) => ({
      path: f.path,
      status: f.status,
      hunks: f.hunks.map((h) => ({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines.map((l) => ({ kind: l.kind, text: maskConfigSecrets(f.path, maskSensitiveText(l.text)) })),
      })),
    }));
    const change = { title: proposal.title, summary: proposal.summary, files };
    while (JSON.stringify(change).length > LIMIT_CHANGE && change.files.length) change.files.pop();
    return change;
  }

  /** ts + plantilla (archivo o inline) + estilos (archivos o inline) de un componente. */
  private async componentSource(ts: WorkspaceCodeFile, env: RenderEnv): Promise<ComponentSource | null> {
    const tsText = await this.readText(ts, env);
    if (tsText === null) return null;
    const meta = parseComponentMeta(tsText);
    if (!meta) return null;
    const tsSource: SourceFile = { path: ts.path, text: tsText, file: ts };
    let html: SourceFile;
    let inlineTemplate = false;
    if (meta.templateUrl) {
      const file = this.fileInMount(resolveCodeReference(ts.path, meta.templateUrl), env);
      const text = await this.readText(file, env);
      if (text === null || !file) return null;
      html = { path: file.path, text, file };
    } else if (meta.template !== undefined) {
      html = { path: ts.path, text: meta.template, file: null };
      inlineTemplate = true;
    } else {
      return null;
    }
    const css: SourceFile[] = [];
    for (const url of meta.styleUrls) {
      const file = this.fileInMount(resolveCodeReference(ts.path, url), env);
      const text = await this.readText(file, env);
      if (text === null || !file) {
        env.approximate = true;
        continue;
      }
      css.push({ path: file.path, text, file });
    }
    if (meta.styles.length) css.push({ path: ts.path, text: meta.styles.join('\n'), file: null });
    return {
      tag: firstElementSelector(meta.selector),
      selector: meta.selector,
      name: meta.className,
      ts: tsSource,
      html,
      css,
      inlineTemplate,
      inlineStyles: meta.styles.length > 0,
    };
  }

  /** `.ts` del componente con esa etiqueta: `<stem>.component.ts` / `<tag>.component.ts`; si no, índice de selectores. */
  private async findChild(tag: string, env: RenderEnv): Promise<WorkspaceCodeFile | null> {
    const cacheKey = `${env.prefix}|${tag}`;
    if (this.childPaths.has(cacheKey)) {
      const path = this.childPaths.get(cacheKey) ?? null;
      return path ? this.fileInMount(path, env) : null;
    }
    const stem = tag.includes('-') ? tag.slice(tag.indexOf('-') + 1) : tag;
    const names = new Set([`${stem}.component.ts`, `${tag}.component.ts`]);
    const files = this.project.project.files.filter((f) => (!env.prefix || f.path.startsWith(env.prefix)) && names.has(f.name.toLowerCase()) && env.isAllowed(f));
    for (const file of files) {
      const text = await this.readText(file, env);
      const meta = text ? parseComponentMeta(text) : null;
      if (meta && meta.selector.split(',').map((s) => s.trim().toLowerCase()).includes(tag)) {
        this.childPaths.set(cacheKey, file.path);
        return file;
      }
    }
    const index = await this.selectorIndexFor(env);
    const path = index.get(tag) ?? null;
    this.childPaths.set(cacheKey, path);
    return path ? this.fileInMount(path, env) : null;
  }

  private async selectorIndexFor(env: RenderEnv): Promise<Map<string, string>> {
    const cached = this.selectorIndex.get(env.prefix);
    if (cached) return cached;
    const index = new Map<string, string>();
    const files = this.project.project.files
      .filter((f) => (!env.prefix || f.path.startsWith(env.prefix)) && /\.component\.ts$/i.test(f.name) && !f.path.includes('node_modules/') && env.isAllowed(f))
      .slice(0, MAX_INDEX_FILES);
    for (const file of files) {
      const text = await this.readText(file, env);
      if (!text) continue;
      const m = /selector\s*:\s*(['"`])([^'"`]+)\1/.exec(text);
      if (!m) continue;
      for (const sel of m[2].split(',')) {
        const s = sel.trim().toLowerCase();
        if (ELEMENT_SELECTOR.test(s) && !index.has(s)) index.set(s, file.path);
      }
    }
    this.selectorIndex.set(env.prefix, index);
    return index;
  }

  /* ---------------------------- render ---------------------------- */

  /** Partes de «Ahora» / «Con el cambio» (independientes del tamaño de pantalla; cacheadas por plan y archivos). */
  private async renderViews(plan: UiPreviewPlan, build: ScreenBuild, ctx: UiScreenContext): Promise<PartsPair> {
    const key = await sha256Hex(JSON.stringify(plan) + '\u0000' + build.filesKey);
    const cached = this.renderCache.get(key);
    if (cached) return cached;
    const env = build.env;
    let globalCss = '';
    let bytes = 0;
    for (const sheet of build.globals) {
      const css = await this.inlineCssAssets(sheet.css, sheet.path, env);
      if (bytes + css.length > MAX_GLOBAL_CSS) {
        env.approximate = true;
        continue;
      }
      bytes += css.length;
      globalCss += `${css}\n`;
    }
    globalCss = sanitizeCss(globalCss);
    const proposal = ctx.proposal;
    const baseApprox = env.approximate;
    const views: PartsPair = {};
    for (const variant of (proposal ? ['now', 'after'] : ['now']) as UiPreviewVariant[]) {
      env.approximate = baseApprox;
      let sources = { root: build.root, children: build.children };
      let patchApprox = false;
      if (proposal) {
        const reverse = proposal.status === 'applied' && variant === 'now' && ctx.mode === 'changes';
        const forward = proposal.status !== 'applied' && variant === 'after';
        if (reverse || forward) {
          const patched = this.patchSources(sources, proposal, reverse);
          sources = patched.sources;
          patchApprox = patched.approximate;
        }
      }
      // Mismo fragmento que vio la IA, recortado después del parche (CSS y TS siguen completos).
      const trim = build.htmlTrim;
      if (trim) {
        const root = sources.root;
        sources = { ...sources, root: { ...root, html: { ...root.html, text: trimTemplateForAi(root.html.text, trim.terms, trim.max, trim.blockMax, trim.secondary).html } } };
      }
      const body = variant === 'after' ? plan.after ?? null : plan;
      const planBody = body ?? plan;
      const parts = await this.renderParts(planBody, sources.root, sources.children, globalCss, variant, env);
      if (patchApprox || (variant === 'after' && !plan.after)) parts.approximate = true;
      views[variant] = parts;
    }
    remember(this.renderCache, key, views, MAX_RENDER_CACHE);
    return views;
  }

  /** srcdoc + medida de cada variante para un tamaño de pantalla. */
  private async finishViews(parts: PartsPair, vp: UiViewportSpec): Promise<ViewPair> {
    const out: ViewPair = {};
    for (const variant of ['now', 'after'] as UiPreviewVariant[]) {
      const p = parts[variant];
      if (!p) continue;
      let approximate = p.approximate;
      let srcdoc = buildSrcdoc({
        globalCss: p.globalCss,
        componentCss: p.componentCss,
        html: p.html,
        tone: p.tone,
        viewport: { width: vp.width, height: vp.height },
      });
      if (srcdoc.length > MAX_SRCDOC) {
        srcdoc = stripInlineAssets(srcdoc);
        approximate = true;
      }
      const frame = await this.measureFrame(srcdoc, p.root, vp);
      out[variant] = { srcdoc, approximate, caption: p.caption, state: p.state, viewport: vp.id, frame };
    }
    return out;
  }

  /** Aplica (o invierte) el diff en memoria sobre los archivos leídos. */
  private patchSources(sources: { root: ComponentSource; children: ComponentSource[] }, proposal: ChangeProposal, reverse: boolean):
    { sources: { root: ComponentSource; children: ComponentSource[] }; approximate: boolean } {
    let approximate = false;
    const patchFile = (f: SourceFile): SourceFile => {
      if (!f.file) return f;
      const change = this.changeFor(proposal, f.file);
      if (!change) return f;
      const r = applyFileChange(f.text, reverse ? reverseFileChange(change) : change);
      if (!r.ok || r.content === null) {
        approximate = true;
        return f;
      }
      return { ...f, text: r.content };
    };
    const patchComponent = (c: ComponentSource): ComponentSource => {
      const ts = patchFile(c.ts);
      const meta = ts.text !== c.ts.text ? parseComponentMeta(ts.text) : null;
      let html = c.inlineTemplate ? c.html : patchFile(c.html);
      if (c.inlineTemplate && meta?.template !== undefined) html = { ...c.html, text: meta.template };
      const css = c.css.map((s) => {
        if (s.file) return patchFile(s);
        return meta && c.inlineStyles ? { ...s, text: meta.styles.join('\n') } : s;
      });
      return { ...c, ts, html, css };
    };
    return { sources: { root: patchComponent(sources.root), children: sources.children.map(patchComponent) }, approximate };
  }

  private async renderParts(plan: Omit<UiPreviewPlan, 'after'>, root: ComponentSource, children: ComponentSource[], globalCss: string,
    variant: UiPreviewVariant, env: RenderEnv): Promise<ViewParts> {
    let approximate = false;
    // 1. Plantilla del componente (valores por defecto del .ts + bindings del plan).
    const resolved = resolveTemplate(root.html.text, {
      bindings: { ...extractTsDefaults(root.ts.text), ...plan.bindings },
      state: plan.state,
      markSelector: plan.mark.selector,
      variant,
    });
    if (resolved.approximate) approximate = true;
    const doc = resolved.doc;
    await this.inlineImages(doc.body, root.html.path, env);
    applyContentAttr(doc.body, 'nx-c0');

    // 2. Hijos (un nivel) y 3. inject.
    const ids = new Map<string, number>();
    const used: { source: ComponentSource; id: string }[] = [];
    const idFor = (child: ComponentSource): string => {
      let k = ids.get(child.tag);
      if (k === undefined) {
        k = ids.size + 1;
        ids.set(child.tag, k);
        used.push({ source: child, id: `nx-c${k}` });
      }
      return `nx-c${k}`;
    };
    const fillHost = async (host: Element, child: ComponentSource, bindings: Record<string, unknown>): Promise<void> => {
      const id = idFor(child);
      const r = resolveTemplate(child.html.text, { bindings: { ...extractTsDefaults(child.ts.text), ...bindings }, state: plan.state, markSelector: plan.mark.selector, variant });
      if (r.approximate) approximate = true;
      await this.inlineImages(r.doc.body, child.html.path, env);
      applyContentAttr(r.doc.body, id);
      const projected = Array.from(host.childNodes);
      const nodes = Array.from(r.doc.body.childNodes).map((n) => doc.importNode(n, true));
      host.replaceChildren(...nodes);
      const slots = Array.from(host.querySelectorAll('ng-content'));
      if (slots.length) {
        slots[0].replaceWith(...projected);
        for (const extra of slots.slice(1)) extra.remove();
      }
      host.setAttribute(`_nghost-${id}`, '');
    };
    const byTag = new Map(children.map((c) => [c.tag, c]));
    for (const tag of childTags(root.html.text)) {
      const hosts = Array.from(doc.body.querySelectorAll(tag));
      if (!hosts.length) continue;
      const child = byTag.get(tag);
      for (const host of hosts) {
        if (child) await fillHost(host, child, plan.bindings);
        else {
          host.replaceChildren();
          approximate = true;
        }
      }
    }
    if (plan.inject) {
      let anchor: Element | null = null;
      try {
        anchor = doc.body.querySelector(plan.inject.after);
      } catch {
        anchor = null;
      }
      const wanted = plan.inject.component.toLowerCase();
      let child = children.find((c) => c.tag === wanted || c.name.toLowerCase() === wanted) ?? null;
      if (!child && ELEMENT_SELECTOR.test(wanted) && wanted.includes('-')) {
        const file = await this.findChild(wanted, env);
        const source = file ? await this.componentSource(file, env) : null;
        if (source) child = { ...source, tag: wanted };
      }
      if (anchor && child && child.tag) {
        const host = doc.createElement(child.tag);
        host.setAttribute('_ngcontent-nx-c0', '');
        anchor.after(host);
        await fillHost(host, child, plan.inject.inputs ?? {});
      } else {
        approximate = true;
      }
    }

    // 4. Host del componente.
    const hostTag = root.tag || 'div';
    const host = doc.createElement(hostTag);
    host.setAttribute('_nghost-nx-c0', '');
    while (doc.body.firstChild) host.appendChild(doc.body.firstChild);
    doc.body.appendChild(host);

    // 5. Marca y saneado.
    const marked = markAndDecorate(doc, plan, variant);
    if (marked.approximate) approximate = true;
    sanitizeFragmentDom(doc);

    // 6. CSS del componente (encapsulado) y de los hijos.
    let componentCss = '';
    let cssBytes = 0;
    const addCss = async (source: ComponentSource, id: string): Promise<void> => {
      let css = '';
      for (const sheet of source.css) css += `${await this.compileSheet(sheet, env)}\n`;
      const enc = encapsulateCss(css, id);
      if (enc.approximate) approximate = true;
      if (cssBytes + enc.css.length > MAX_COMPONENT_CSS) {
        approximate = true;
        return;
      }
      cssBytes += enc.css.length;
      componentCss += `${enc.css}\n`;
    };
    await addCss(root, 'nx-c0');
    for (const { source, id } of used) await addCss(source, id);

    return {
      globalCss,
      componentCss: sanitizeCss(componentCss),
      html: doc.body.innerHTML,
      tone: uiToneOf(plan.state),
      root: plan.root,
      caption: plan.caption,
      state: plan.state,
      approximate: approximate || env.approximate,
    };
  }

  private async compileSheet(sheet: SourceFile, env: RenderEnv): Promise<string> {
    const isScss = /\.s[ac]ss$/i.test(sheet.path) && !!sheet.file;
    if (!isScss) return this.inlineCssAssets(sheet.text, sheet.path, env);
    const r = await compileScss(sheet.text, sheet.path, (spec, from) => this.loadScssPartial(spec, from, env));
    if (r.approximate) env.approximate = true;
    return this.inlineCssAssets(r.css, sheet.path, env);
  }

  /**
   * Imágenes locales como data URI: `src`, `ngSrc` o la primera URL de `srcset` de cada `<img>` (las remotas o no
   * resueltas usan un placeholder y marcan la vista aproximada) y los `url()` de los `style` inline.
   */
  private async inlineImages(root: Element, fromPath: string, env: RenderEnv): Promise<void> {
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const srcset = img.getAttribute('srcset') ?? '';
      const raw = (img.getAttribute('src') || img.getAttribute('ngsrc') || srcset.split(',')[0].trim().split(/\s+/)[0] || '').trim();
      const data = raw ? await this.loadAsset(raw, fromPath, env, 'image', 'template') : null;
      if (data) {
        img.setAttribute('src', data);
      } else {
        img.setAttribute('src', NX_IMAGE_PLACEHOLDER);
        env.approximate = true;
      }
      img.removeAttribute('srcset');
      img.removeAttribute('ngsrc');
    }
    for (const el of Array.from(root.querySelectorAll('[style]'))) {
      const style = el.getAttribute('style') ?? '';
      if (!/url\(/i.test(style)) continue;
      el.setAttribute('style', await this.inlineCssAssets(style, fromPath, env, 'template'));
    }
  }

  /**
   * Mide el documento en un iframe oculto del tamaño elegido, del mismo origen (sin scripts): alto real (≤ 4000) y
   * encuadre en la raíz del plan (margen 8) si existe y es más estrecha que la pantalla; si la marca `.nx` queda fuera
   * de la parte visible de la miniatura, se centra en vertical.
   */
  private async measureFrame(html: string, rootSelector: string, vp: UiViewportSpec): Promise<UiScreenView['frame']> {
    const W = vp.width;
    const H = vp.height;
    const fallback = { width: W, height: H, viewportHeight: H, crop: { x: 0, y: 0, w: W, h: H } };
    if (typeof document === 'undefined' || !document.body) return fallback;
    const iframe = document.createElement('iframe');
    try {
      iframe.setAttribute('sandbox', 'allow-same-origin');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.setAttribute('tabindex', '-1');
      iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${W}px;height:${H}px;visibility:hidden;pointer-events:none;border:0`;
      const loaded = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 2500);
        iframe.addEventListener('load', () => {
          clearTimeout(timer);
          resolve(true);
        }, { once: true });
      });
      iframe.srcdoc = html;
      document.body.appendChild(iframe);
      if (!(await loaded)) return fallback;
      const doc = iframe.contentDocument;
      if (!doc || !doc.documentElement) return fallback;
      const rootEl = doc.documentElement;
      const height = Math.max(1, Math.min(MAX_DOC_H, Math.max(rootEl.scrollHeight, doc.body?.scrollHeight ?? 0)));
      let crop = { x: 0, y: 0, w: W, h: height };
      let target: Element | null = null;
      try {
        target = doc.querySelector(rootSelector);
      } catch {
        target = null;
      }
      if (target) {
        const r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < W) {
          const x = Math.max(0, Math.floor(r.left - CROP_MARGIN));
          const y = Math.max(0, Math.floor(r.top - CROP_MARGIN));
          crop = {
            x,
            y,
            w: Math.min(W - x, Math.ceil(r.width + CROP_MARGIN * 2)),
            h: Math.min(height - y, Math.ceil(r.height + CROP_MARGIN * 2)),
          };
        }
      }
      const mark = doc.querySelector('.nx');
      if (mark && crop.w > 0) {
        const s = Math.min(1, THUMB_W / crop.w);
        const visible = THUMB_MAX_H / s;
        const m = mark.getBoundingClientRect();
        if (m.top < crop.y || m.bottom + 22 > crop.y + visible) {
          const center = m.top + m.height / 2;
          const y = Math.round(Math.min(Math.max(0, center - visible / 2), Math.max(0, height - visible)));
          crop = { ...crop, y, h: Math.max(crop.h, Math.min(height - y, visible)) };
        }
      }
      return { width: W, height, viewportHeight: H, crop };
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudo medir la vista de pantalla.', error instanceof Error ? error.name : '');
      return fallback;
    } finally {
      iframe.remove();
    }
  }

  /* ---------------------------- diff ---------------------------- */

  /** Cambio de la propuesta que toca ese archivo (misma ruta resuelta en el montaje). */
  private changeFor(proposal: ChangeProposal, file: WorkspaceCodeFile): FileChange | null {
    const mounts = this.project.project.mounts;
    return proposal.files.find((f) => {
      const p = normPath(f.path);
      if (p === file.path) return true;
      const target = resolveChangeTarget(mounts, (path) => this.project.fileByPath(path), f);
      return !!target && target.path === file.path;
    }) ?? null;
  }

  /* ---------------------------- archivos ---------------------------- */

  /** Archivo de `node_modules` del montaje de `env`, leído del disco (no está en el índice del proyecto). */
  private readPackageFile(rel: string, env: RenderEnv, maxBytes: number, as: 'text' | 'base64'): Promise<string | null> {
    const mount = this.project.project.mounts.find((m) => m.path && `${m.path}/` === env.prefix);
    if (!mount || !/^node_modules\//.test(rel)) return Promise.resolve(null);
    return this.project.readMountDisk(mount.id, rel, maxBytes, as);
  }

  private mountPrefix(file: WorkspaceCodeFile): string {
    const hit = this.project.project.mounts
      .filter((m) => m.path && file.path.startsWith(`${m.path}/`))
      .sort((x, y) => y.path.length - x.path.length)[0];
    return hit ? `${hit.path}/` : '';
  }

  /** Archivo del proyecto dentro del montaje resuelto (nunca fuera ni con `..`). */
  private fileInMount(path: string | null, env: RenderEnv): WorkspaceCodeFile | null {
    if (!path) return null;
    const rel = safeRelativePath(path);
    if (!rel) return null;
    const norm = normalizeCodePath(rel);
    if (!norm || (env.prefix && !norm.startsWith(env.prefix))) return null;
    return this.project.fileByPath(norm);
  }

  private async readText(file: WorkspaceCodeFile | null, env: RenderEnv): Promise<string | null> {
    if (!file || !env.validator.usable(file)) return null;
    const lines = await env.validator.linesOf(file);
    return lines ? lines.join('\n') : null;
  }

  private async loadScssPartial(spec: string, fromPath: string, env: RenderEnv): Promise<{ path: string; text: string } | null> {
    const resolved = resolveCodeReference(fromPath, spec);
    if (!resolved) return null;
    const dir = resolved.includes('/') ? resolved.slice(0, resolved.lastIndexOf('/') + 1) : '';
    const name = basename(resolved);
    const stem = name.replace(/\.(scss|sass|css)$/i, '');
    const candidates = [
      `${dir}_${stem}.scss`, `${dir}${stem}.scss`, `${dir}_${stem}.sass`, `${dir}${stem}.sass`,
      `${dir}${stem}/_index.scss`, `${dir}${stem}/index.scss`, `${dir}_${stem}.css`, `${dir}${stem}.css`,
    ];
    for (const candidate of candidates) {
      const file = this.fileInMount(candidate, env);
      const text = await this.readText(file, env);
      if (text !== null && file) return { path: file.path, text };
    }
    return null;
  }

  /**
   * `angular.json` del montaje, leído una vez por carga: estilos globales (primer proyecto con `styles`) y carpetas de
   * assets (del mismo proyecto o, si no tiene, del primero con `assets`) como prefijo de URL → carpeta.
   */
  private async angularConfig(env: RenderEnv): Promise<AngularBuildConfig | null> {
    if (env.angular !== undefined) return env.angular;
    env.angular = null;
    const text = await this.readText(this.fileInMount(`${env.prefix}angular.json`, env), env);
    if (!text) return null;
    type Project = { root?: unknown; sourceRoot?: unknown; architect?: { build?: { options?: { styles?: unknown; assets?: unknown } } } };
    try {
      const parsed = JSON.parse(text) as { projects?: Record<string, Project> };
      const projects = Object.values(parsed?.projects ?? {}).filter((p): p is Project => !!p && typeof p === 'object');
      const stylesOf = (p: Project): string[] => {
        const styles = p.architect?.build?.options?.styles;
        const out: string[] = [];
        if (!Array.isArray(styles)) return out;
        for (const entry of styles) {
          const input = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as { input?: unknown }).input : null;
          if (typeof input === 'string' && input.trim() && !out.includes(input)) out.push(input);
        }
        return out;
      };
      let styles: string[] = [];
      let owner: Project | null = null;
      for (const p of projects) {
        styles = stylesOf(p);
        if (styles.length) {
          owner = p;
          break;
        }
      }
      const hasAssets = (p: Project | null): p is Project => !!p && Array.isArray(p.architect?.build?.options?.assets);
      const assetProject = hasAssets(owner) ? owner : projects.find((p) => hasAssets(p)) ?? null;
      const assets: AssetMapping[] = [];
      if (assetProject) {
        const projRoot = normPath(typeof assetProject.root === 'string' ? assetProject.root : '').replace(/\/+$/, '');
        const sourceRoot = normPath(typeof assetProject.sourceRoot === 'string' ? assetProject.sourceRoot : (projRoot ? `${projRoot}/src` : 'src')).replace(/\/+$/, '');
        for (const entry of assetProject.architect?.build?.options?.assets as unknown[]) {
          if (typeof entry === 'string') {
            const e = normPath(entry.trim()).replace(/^\/+/, '').replace(/\/+$/, '');
            if (!e) continue;
            let url: string;
            if (sourceRoot && e.startsWith(`${sourceRoot}/`)) url = e.slice(sourceRoot.length + 1);
            else if (projRoot && e.startsWith(`${projRoot}/`)) url = e.slice(projRoot.length + 1);
            else url = basename(e);
            const exact = extOf(e) !== '';
            assets.push(exact ? { url, dir: e, exact } : { url: `${url}/`, dir: `${e}/`, exact });
          } else if (entry && typeof entry === 'object') {
            const input = (entry as { input?: unknown }).input;
            const output = (entry as { output?: unknown }).output;
            if (typeof input !== 'string') continue;
            const dir = normPath(input.trim()).replace(/^\/+/, '').replace(/\/+$/, '');
            const out = normPath(typeof output === 'string' ? output : '').replace(/^\/+|\/+$/g, '');
            assets.push({ url: out ? `${out}/` : '', dir: dir ? `${dir}/` : '', exact: false });
          }
        }
        assets.sort((a, b) => b.url.length - a.url.length);
      }
      env.angular = { styles, assets };
    } catch (error: unknown) {
      console.warn('[Nexo IA] angular.json no válido.', error instanceof Error ? error.name : '');
      env.angular = null;
    }
    return env.angular;
  }

  /**
   * Estilos globales compilados (sin incrustar assets): todas las entradas de `angular.json` en orden (las `.scss`
   * con el CSS de `dist/` si existe; si no, compiladas) y las hojas locales y `<style>` de `src/index.html`. Lo que
   * no se puede leer (externo, `node_modules` ausente) marca la vista aproximada.
   */
  private async globalSheets(env: RenderEnv): Promise<{ path: string; css: string }[]> {
    const specs: string[] = [...(await this.angularConfig(env))?.styles ?? []];
    if (!specs.length) {
      if (this.fileInMount(`${env.prefix}src/styles.css`, env)) specs.push('src/styles.css');
      else if (this.fileInMount(`${env.prefix}src/styles.scss`, env)) specs.push('src/styles.scss');
    }
    const out: { path: string; css: string }[] = [];
    let distUsed = false;
    for (const spec of specs) {
      const clean = normPath(spec).replace(/^~/, 'node_modules/').replace(/^\/+/, '');
      const file = this.fileInMount(`${env.prefix}${clean}`, env);
      if (!file && /^node_modules\/.+\.css$/i.test(clean)) {
        // Las hojas de paquetes (bootstrap, iconos…) no están en el índice: se leen de la carpeta vinculada.
        const css = await this.readPackageFile(clean, env, MAX_PACKAGE_CSS_BYTES, 'text');
        if (css !== null) out.push({ path: `${env.prefix}${clean}`, css });
        else env.approximate = true;
        continue;
      }
      if (!file || !env.validator.usable(file)) {
        env.approximate = true;
        continue;
      }
      if (/\.s[ac]ss$/i.test(file.path)) {
        if (distUsed) continue;
        const dist = await this.distStyles(env);
        if (dist !== null) {
          distUsed = true;
          out.push(dist);
          continue;
        }
        const text = await this.readText(file, env);
        if (text === null) {
          env.approximate = true;
          continue;
        }
        const r = await compileScss(text, file.path, (s, from) => this.loadScssPartial(s, from, env));
        if (r.approximate) env.approximate = true;
        out.push({ path: file.path, css: r.css });
        continue;
      }
      const text = await this.readText(file, env);
      if (text !== null) out.push({ path: file.path, css: text });
      else env.approximate = true;
    }
    out.push(...await this.indexHtmlStyles(env));
    return out;
  }

  /** `<link rel="stylesheet">` locales y `<style>` de `src/index.html`; los externos se omiten (vista aproximada). */
  private async indexHtmlStyles(env: RenderEnv): Promise<{ path: string; css: string }[]> {
    const indexFile = this.fileInMount(`${env.prefix}src/index.html`, env);
    const html = await this.readText(indexFile, env);
    if (html === null || !indexFile) return [];
    const out: { path: string; css: string }[] = [];
    const text = html.replace(/<!--[\s\S]*?-->/g, '');
    for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      if (!/\brel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
      const href = /\bhref\s*=\s*(["'])([^"']+)\1/i.exec(tag)?.[2] ?? '';
      if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        env.approximate = true;
        continue;
      }
      const clean = normPath(href.split('?')[0].split('#')[0]).replace(/^\/+/, '');
      const file = this.fileInMount(resolveCodeReference(indexFile.path, href), env) ?? this.fileInMount(`${env.prefix}src/${clean}`, env);
      const css = await this.readText(file, env);
      if (css !== null && file) out.push({ path: file.path, css });
      else env.approximate = true;
    }
    for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      if (m[1].trim()) out.push({ path: indexFile.path, css: m[1] });
    }
    return out;
  }

  private async distStyles(env: RenderEnv): Promise<{ path: string; css: string } | null> {
    const prefix = `${env.prefix}dist/`;
    const candidates = this.project.project.files.filter((f) => f.path.startsWith(prefix) && /\/styles[^/]*\.css$/i.test(f.path));
    for (const file of candidates) {
      const text = await this.readText(file, env);
      if (text !== null) return { path: file.path, css: text };
    }
    return null;
  }

  /** Sustituye los `url()` de imágenes y fuentes locales por data URI (relativas a la hoja); el resto lo anula `sanitizeCss`. */
  private async inlineCssAssets(css: string, fromPath: string, env: RenderEnv, context: 'template' | 'css' = 'css'): Promise<string> {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const url = m[2].trim();
      if (!/^data:/i.test(url)) found.add(url);
    }
    if (!found.size) return css;
    const resolved = new Map<string, string | null>();
    for (const url of found) {
      const ext = extOf(url.split('#')[0].split('?')[0]);
      resolved.set(url, await this.loadAsset(url, fromPath, env, FONT_EXTENSIONS.has(ext) ? 'font' : 'image', context));
    }
    return css.replace(re, (match, _q: string, url: string) => {
      const data = resolved.get(url.trim());
      return data ? `url("${data}")` : match;
    });
  }

  /**
   * Imagen o fuente local como data URI (`null` si es remota, no existe, no está permitida, no es del tipo o supera los
   * límites). Resuelve con las carpetas de assets de `angular.json`, rutas relativas, `src/`, la raíz, `public/`,
   * `node_modules` (carpeta vinculada) y, en último lugar, sin distinguir mayúsculas. Los SVG con contenido activo se
   * rechazan.
   */
  private async loadAsset(spec: string, fromPath: string, env: RenderEnv, kind: 'image' | 'font',
    context: 'template' | 'css' = 'css'): Promise<string | null> {
    const raw = String(spec ?? '').trim();
    if (/^data:image\//i.test(raw) || (kind === 'font' && /^data:font\//i.test(raw))) return raw;
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw) || raw.includes('{{')) return null;
    let clean = raw.split('#')[0].split('?')[0];
    try {
      clean = decodeURIComponent(clean);
    } catch (error: unknown) {
      console.warn('[Nexo IA] Ruta de asset mal codificada.', error instanceof Error ? error.name : '');
    }
    clean = normPath(clean).replace(/^\/+/, '');
    if (!clean) return null;
    const prefix = env.prefix;
    const relative = context === 'css' || /^\.\.?\//.test(raw);
    const list: (string | null)[] = [];
    if (relative) list.push(resolveCodeReference(fromPath, raw));
    for (const m of (await this.angularConfig(env))?.assets ?? []) {
      if (m.exact) {
        if (clean === m.url) list.push(`${prefix}${m.dir}`);
      } else if (m.url === '' || clean.startsWith(m.url)) {
        list.push(`${prefix}${m.dir}${clean.slice(m.url.length)}`);
      }
    }
    if (!relative) list.push(resolveCodeReference(fromPath, raw));
    list.push(`${prefix}src/${clean}`, `${prefix}${clean}`, `${prefix}public/${clean}`);
    const candidates = [...new Set(list.filter((c): c is string => !!c))];
    let pkg: string | null = null;
    for (const candidate of candidates) {
      const file = this.fileInMount(candidate, env) ?? this.fileByPathCi(candidate, env);
      if (!file) {
        const safe = safeRelativePath(candidate);
        if (!pkg && safe && prefix && safe.startsWith(`${prefix}node_modules/`)) pkg = safe;
        continue;
      }
      if (!this.assetAllowed(file)) continue;
      if (env.assets.has(file.path)) return env.assets.get(file.path) ?? null;
      const ext = file.extension || extOf(file.name);
      const mime = codeMimeFor(file.name);
      const ok = kind === 'font'
        ? FONT_EXTENSIONS.has(ext) && mime.startsWith('font/')
        : IMAGE_EXTENSIONS.has(ext) && mime.startsWith('image/');
      if (!ok) continue;
      const svg = ext === 'svg';
      const max = kind === 'font' ? MAX_FONT_BYTES : svg ? MAX_SVG_BYTES : MAX_IMAGE_BYTES;
      let base64: string | null = null;
      if (isCodeFileReady(file) && file.content) {
        base64 = file.binary ? file.content : encodeUtf8Base64(file.content);
      } else if (this.project.canRead(file)) {
        base64 = await this.project.readLocalBase64(file, max);
      }
      if (!base64) continue;
      const bytes = Math.floor((base64.length * 3) / 4);
      if (bytes > max || env.assetsTotal + bytes > MAX_ASSETS_TOTAL || (svg && !this.svgSafe(base64))) {
        env.approximate = true;
        env.assets.set(file.path, null);
        return null;
      }
      env.assetsTotal += bytes;
      const data = `data:${svg ? 'image/svg+xml' : mime};base64,${base64}`;
      env.assets.set(file.path, data);
      return data;
    }
    // Fuentes e imágenes de paquetes (p. ej. bootstrap-icons): no están en el índice, se leen de la carpeta vinculada.
    if (!pkg) return null;
    const rel = pkg.slice(prefix.length);
    if (env.assets.has(pkg)) return env.assets.get(pkg) ?? null;
    const name = rel.split('/').pop() ?? '';
    const ext = extOf(name);
    const mime = codeMimeFor(name);
    const ok = kind === 'font' ? FONT_EXTENSIONS.has(ext) && mime.startsWith('font/') : IMAGE_EXTENSIONS.has(ext) && mime.startsWith('image/');
    if (!ok || isSensitiveCodeFile(name)) return null;
    const svg = ext === 'svg';
    const max = kind === 'font' ? MAX_FONT_BYTES : svg ? MAX_SVG_BYTES : MAX_IMAGE_BYTES;
    const base64 = await this.readPackageFile(rel, env, max, 'base64');
    const bytes = base64 ? Math.floor((base64.length * 3) / 4) : 0;
    if (!base64 || bytes > max || env.assetsTotal + bytes > MAX_ASSETS_TOTAL || (svg && !this.svgSafe(base64))) {
      env.approximate = true;
      env.assets.set(pkg, null);
      return null;
    }
    env.assetsTotal += bytes;
    const data = `data:${svg ? 'image/svg+xml' : mime};base64,${base64}`;
    env.assets.set(pkg, data);
    return data;
  }

  /** SVG sin scripts, `foreignObject`, manejadores, `javascript:` ni entidades (solo se usa como imagen). */
  private svgSafe(base64: string): boolean {
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return !SVG_UNSAFE.test(new TextDecoder().decode(bytes));
    } catch (error: unknown) {
      console.warn('[Nexo IA] SVG no legible.', error instanceof Error ? error.name : '');
      return false;
    }
  }

  /** Filtro propio del render (los assets no entran en el contexto de la IA): ni sensibles ni en carpetas excluidas. */
  private assetAllowed(file: WorkspaceCodeFile): boolean {
    return !isSensitiveCodeFile(file.name) && !isContextExcludedDir(file.path);
  }

  /** Último recurso: misma ruta sin distinguir mayúsculas (dentro del montaje). */
  private fileByPathCi(path: string, env: RenderEnv): WorkspaceCodeFile | null {
    const rel = safeRelativePath(path);
    const norm = rel ? normalizeCodePath(rel) : '';
    if (!norm) return null;
    const files = this.project.project.files;
    if (!this.ciIndex || this.ciIndex.files !== files) {
      const map = new Map<string, WorkspaceCodeFile>();
      for (const f of files) {
        const key = f.path.toLowerCase();
        if (!map.has(key)) map.set(key, f);
      }
      this.ciIndex = { files, map };
    }
    const file = this.ciIndex.map.get(norm.toLowerCase()) ?? null;
    if (!file || (env.prefix && !file.path.startsWith(env.prefix))) return null;
    return file;
  }
}
