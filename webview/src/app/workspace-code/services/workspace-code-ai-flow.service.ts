import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { NexoBridge } from '../../bridge/nexo-bridge';
import { DbConnectionInfo, FlowDiagnosisResponse, FlowKind } from '../../bridge/protocol';
import { NexoConfigService } from '../../project/nexo-config.service';
import { NexoProjectService } from '../../project/nexo-project.service';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { WorkspaceCodeFile, encodeUtf8Base64 } from '../workspace-code.types';
import {
  CodeRef,
  FlowDbAccess,
  FlowDbMapContext,
  FlowDbMapStored,
  FlowDiagnosis,
  FlowDiagram,
  FlowMode,
  FlowResultSource,
  FlowRowState,
  FlowUiState,
  LogAnalysisResult,
  SimulationPreset,
  SimulationResult,
  SnippetView,
} from '../ai/nexo-ia.types';
import { CaseComparison, ChangeCompareResponse, ChangeProposal, DiffHunk, FileChange } from '../ai/nexo-ia.changes.types';
import { applyFileChange, caseTouchedByChange, compareTag, resolveChangeTarget, sortCases } from '../ai/workspace-code-ai-change-patch';
import { maskConfigSecrets, maskSensitiveJson } from '../ai/workspace-code-ai-mask';
import { FlowRefValidator, isDecoratorFunctionName, refKey } from '../ai/workspace-code-flow-ref-validator';
import { WorkspaceCodeFlowPlayer } from '../ai/workspace-code-flow-player';
import { sanitizeDiagnosis, sanitizeFlowDbMap, sanitizeFlowDiagram } from '../ai/workspace-code-flow-sanitize';
import { buildFlowDbSchema, buildFlowDbScript, candidateTableNames, dbStepIndexes, flowHasDb, isDbStep, repositoryEntities } from '../ai/workspace-code-flow-db';
import { DbExplainScript } from '../workspace-code-db/workspace-code-db-explain';
import { shortType } from '../workspace-code-db/workspace-code-db.util';
import { analyzeLogs } from '../ai/workspace-code-log-analyzer';
import { WorkspaceCodeNotifyService } from './workspace-code-notify.service';
import { WorkspaceCodeDatabaseMetadata, WorkspaceCodeDbTable } from './workspace-code-runtime.types';

/*
 * Copia de chatFront `services/workspace-code-ai-flow.service.ts` para la extensión de VS Code, sin Claude. Las
 * peticiones al backend (flujo, comparación de cambios) y la metadata de la base de datos las hace el host a través de
 * `NexoBridge`.
 */

const MAX_INPUT_CHARS = 20000;
const MAX_LOG_CHARS = 60000;
const MAX_LOG_LINES = 2000;
const WINDOW_RADIUS = 40;
const MAX_WINDOWS = 24;
const MAX_WINDOW_CHARS = 8000;
const MAX_CODE_CHARS = 120000;
const MAX_CONTEXT_BASE64 = 390000;
/** Simular cambios: radios (líneas) alrededor de cada bloque del diff, del mayor al menor si la ventana no cabe. */
const CHANGE_RADII = [15, 10, 5];
const MAX_COMPARE_CASES = 7;
/** Pausa entre el final de «Antes» y el inicio de «Después». */
const BEFORE_AFTER_GAP_MS = 1100;
/** Modo «Base de datos» (DB_MAP): contexto barato, sin volver a investigar. */
const DB_MAP_RADIUS = 20;
const DB_ENTITY_LINES = 120;
const DB_ENTITY_CHARS = 2500;
const DB_MAX_ENTITY_FILES = 4;
const DB_SCHEMA_MAX_TABLES = 12;
const DB_SCHEMA_MAX_COLUMNS = 30;
const DB_SCHEMA_OTHER_TABLES = 150;
const DB_CACHE_LIMIT = 20;

interface CodeWindow { path: string; startLine: number; endLine: number; content: string }
/** Rangos que deben ir enteros en una ventana (bloques del diff), por archivo. */
type PinnedSpans = Map<string, { file: WorkspaceCodeFile; spans: [number, number][] }>;

/** Una ventana con un bloque del diff no cabe en el límite de caracteres. */
class WindowTooLargeError extends Error {
  constructor() {
    super('window-too-large');
    this.name = 'WindowTooLargeError';
  }
}

export type CompareOutcome = { status: 'ok' } | { status: 'error'; message: string } | { status: 'cancelled' };

/** Resultado de la petición del plan de la vista de pantalla. */
export type UiPlanOutcome =
  | { status: 'ok'; plan: unknown; source: FlowResultSource }
  | { status: 'error'; message: string }
  | { status: 'cancelled' };

/** Petición cancelable del plan de la vista de pantalla. */
export interface UiPlanRequest {
  promise: Promise<UiPlanOutcome>;
  cancel(): void;
}

/** Petición cancelable de un resultado de flujo (plan de pantalla o mapa de datos). */
interface FlowResultRequest {
  promise: Promise<UiPlanOutcome>;
  cancel(escape?: boolean): void;
}

/** Vista del modo «Base de datos»: mapa guardado, esquema del diagrama y guion conducido por el reproductor. */
export interface FlowDbView {
  map: FlowDbMapStored;
  schema: WorkspaceCodeDatabaseMetadata;
  script: DbExplainScript;
  /** Índice en el flujo de cada paso del guion (`script.steps[k]` ↔ `flow.steps[indexes[k]]`). */
  indexes: number[];
  accesses: Map<string, FlowDbAccess>;
  connectionKey: string;
  schemaKey: string;
}

/** Conexión de base de datos configurada en VS Code con su metadata cargada (solo lectura, por el host). */
interface FlowDbConnection {
  key: string;
  meta: WorkspaceCodeDatabaseMetadata;
}

/** Error de contexto de la comparación con un mensaje ya traducido. */
class ChangeContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChangeContextError';
  }
}

/**
 * Contexto de la vista de pantalla del resultado visible (lo calcula `screenContext`). Si cambia `key`, la vista se
 * cancela y se reinicia.
 */
export interface UiScreenContext {
  /** Identidad: el resultado en simular/logs; el caso en Simular cambios. */
  key: object;
  mode: 'sim' | 'logs' | 'changes';
  flowId: string;
  /** Índice del paso ancla (fallo, último o último visto). */
  anchor: number;
  tone: 'warning' | 'danger' | 'success' | 'accent';
  /** Resultado de «Ahora». */
  before: SimulationResult | LogAnalysisResult;
  /** Resultado de «Con el cambio» (solo Simular cambios). */
  afterResult: SimulationResult | null;
  proposal: ChangeProposal | null;
  initialTab: 'now' | 'after';
  /** Datos de entrada ya enmascarados. */
  input: unknown;
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 1) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

/** Quita de `spans` los rangos `blocked` (las ventanas de los bloques del diff ya incluyen esas líneas). */
function subtractSpans(spans: [number, number][], blocked: [number, number][]): [number, number][] {
  let out = spans.map((s) => [s[0], s[1]] as [number, number]);
  for (const [bs, be] of blocked) {
    const next: [number, number][] = [];
    for (const [s, e] of out) {
      if (be < s || bs > e) {
        next.push([s, e]);
        continue;
      }
      if (s < bs) next.push([s, bs - 1]);
      if (e > be) next.push([be + 1, e]);
    }
    out = next;
  }
  return out;
}

export interface FlowStatusPill {
  tone: 'accent' | 'danger' | 'warning' | 'success';
  key: string;
  params: Record<string, string | number>;
  /** Simular cambios: «Antes ·» / «Después ·». */
  prefix?: string;
}

/** Vista de un resultado de Simular datos / Analizar logs, guardada en memoria al salir de su pestaña. */
interface SavedDiagnosisView {
  result: SimulationResult | LogAnalysisResult;
  source: FlowResultSource | null;
  snippet: SnippetView | null;
  revealedFor: string | null;
  labHeight: number | null;
  labFrozen: boolean;
}

export interface SavedResultPill {
  mode: 'sim' | 'logs';
  pill: FlowStatusPill;
}

function emptyUi(): FlowUiState {
  return {
    mode: 'walk', step: 0, playing: false, speed: 1, labHeight: null, labPane: 'data',
    simInput: '', simPreset: null, simError: null, simResult: null,
    logsInput: '', logsResult: null, pre: null,
    busy: false, error: null, resultVisible: false, revealedFor: null,
    changeSide: 'before', changeCase: null, comparison: null, changeBusy: false, changeError: null,
    claudeRun: null, errorAction: null, changeErrorAction: null, resultSource: null,
    dbStatus: 'idle', dbError: null, dbErrorAction: null, dbClaude: false,
  };
}


/**
 * Estado del flujo de Nexo IA abierto en el panel: diagrama validado, fragmentos releídos del archivo real, modo,
 * reproductor y validador (simular datos / analizar logs).
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeAiFlowService implements OnDestroy {
  readonly changed$ = new Subject<void>();

  flow: FlowDiagram | null = null;
  snippets = new Map<string, SnippetView>();
  fileIds = new Map<string, string>();
  ui: FlowUiState = emptyUi();
  /** Fragmento de la línea que falla en el diagnóstico visible. */
  resultSnippet: SnippetView | null = null;
  /** Aviso de logs recortados. */
  logsNotice: string | null = null;
  readonly player = new WorkspaceCodeFlowPlayer(() => this.syncPlayer());
  /** Lo registra el componente: altura actual del validador para congelarla al mostrar el resultado. */
  labMeasure: (() => number | null) | null = null;
  /** Lo registra `WorkspaceCodeAiChangeService`: última propuesta `pending`/`applied` de un flujo. */
  changeLookup: ((flowId: string) => { messageId: string; proposal: ChangeProposal } | null) | null = null;
  /** Modo «Base de datos»: esquema y guion listos para pintar. */
  dbView: FlowDbView | null = null;

  /** Resultado de cada modo guardado al cambiar de pestaña (solo en memoria; se vacía en `open()`). */
  private savedViews: { sim?: SavedDiagnosisView; logs?: SavedDiagnosisView } = {};
  private lastOperation: 'sim' | 'logs' | null = null;
  /** La altura del validador la fijó la llegada del resultado (no el usuario con el separador). */
  private labFrozen = false;
  private runId = 0;
  /** Petición en curso al host (id del puente). */
  private pendingId: string | null = null;
  private validateRunId = 0;
  /** Comparación antes/después: petición propia (no la cancelan los cambios de datos de Simular datos). */
  private compareRunId = 0;
  private comparePendingId: string | null = null;
  private compareResolve: ((outcome: CompareOutcome) => void) | null = null;
  /** Secuencia «Simular antes y después» en curso. */
  private sequence = false;
  private sequenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Mapa de datos: petición propia, caché en memoria (`flowId|language|nexo`). */
  private dbRunId = 0;
  private dbCancel: ((escape?: boolean) => void) | null = null;
  private readonly dbCache = new Map<string, FlowDbMapStored>();
  /** Metadata de las conexiones de base de datos configuradas (se limpia en «Regenerar»). */
  private readonly dbMetaCache = new Map<string, WorkspaceCodeDatabaseMetadata>();

  constructor(
    private project: NexoProjectService,
    private config: NexoConfigService,
    private i18n: WorkspaceCodeI18nService,
    private bridge: NexoBridge,
    private notify: WorkspaceCodeNotifyService,
  ) {}

  ngOnDestroy(): void {
    this.runId++;
    this.cancelPending();
    this.cancelSequence();
    this.cancelCompare();
    this.stopDbRequest();
    this.changeLookup = null;
    this.player.dispose();
    this.changed$.complete();
  }

  /* ---------------------------- abrir ---------------------------- */

  /**
   * Abre un flujo: revalida las referencias contra el código actual. Devuelve `false` si el JSON no es un flujo
   * válido (`sanitizeFlowDiagram`).
   */
  async open(input: unknown, step = 0, mode: FlowMode = 'walk'): Promise<boolean> {
    // Flujos ya validados: conserva la verificación y el código guardado (`codeSnapshot`).
    const sanitized = sanitizeFlowDiagram(input, true);
    if (!sanitized) return false;
    this.cancelRequest();
    this.cancelSequence();
    this.player.reset();
    const sameFlow = this.flow?.id === sanitized.id;
    if (!sameFlow) this.cancelCompare();
    // Mapa de datos: se cancela la carga al cambiar de flujo o de modo; con el mismo flujo se conservan la vista y la caché.
    if (!sameFlow || mode !== 'db') this.stopDbRequest();
    if (sameFlow && !sanitized.dbMap && this.flow?.dbMap) sanitized.dbMap = this.flow.dbMap;
    this.flow = sanitized;
    if (!sameFlow) {
      this.snippets = new Map();
      this.fileIds = new Map();
      this.dbView = null;
    }
    const keep = sameFlow ? this.ui : null;
    this.ui = {
      ...emptyUi(),
      speed: this.player.speed,
      mode: (mode === 'changes' && !this.activeChangeFor(sanitized.id)) || (mode === 'db' && !flowHasDb(sanitized)) ? 'walk' : mode,
      dbStatus: keep && keep.dbStatus !== 'loading' ? keep.dbStatus : 'idle',
      dbError: keep?.dbError ?? null,
      dbErrorAction: keep?.dbErrorAction ?? null,
      simInput: this.json(sanitized.inputExample),
      logsInput: keep?.logsInput ?? '',
      comparison: keep?.comparison ?? null,
      changeCase: keep?.changeCase ?? null,
      changeSide: keep?.changeSide ?? 'before',
      changeBusy: keep?.changeBusy ?? false,
    };
    this.resultSnippet = null;
    this.savedViews = {};
    this.logsNotice = null;
    this.player.runWalk(sanitized.steps.length);
    this.player.select(step);
    this.emit();
    if (this.ui.mode === 'db') void this.loadDbMap();
    // Revalidación (el código puede haber cambiado desde que se generó el flujo).
    await this.revalidate();
    return true;
  }

  /**
   * Abre un flujo cuyo FLOW ya trae el escenario de la pregunta simulado: modo «Simular datos» con esos datos y el
   * resultado reproducido (validado como cualquier diagnóstico). Sin escenario, abre el recorrido normal.
   */
  async openScenario(input: FlowDiagram, source: FlowResultSource): Promise<boolean> {
    if (!input.scenario) return this.open(input, 0, 'walk');
    const ok = await this.open(input, 0, 'sim');
    const flow = this.flow;
    // Otra apertura o una acción del usuario durante la revalidación tiene prioridad.
    if (!ok || !flow || flow.id !== input.id || !flow.scenario || this.ui.mode !== 'sim' || this.ui.busy || this.ui.simResult) return ok;
    const scenario = flow.scenario;
    this.cancelRequest();
    const runId = ++this.runId;
    this.lastOperation = 'sim';
    this.ui = {
      ...this.ui,
      simInput: this.json(this.withScenario(scenario.label, scenario.input)),
      simPreset: null,
      simError: null,
      error: null,
      errorAction: null,
    };
    await this.presentDiagnosis(scenario.result, 'sim', flow, runId, undefined, source);
    return true;
  }

  /** Revalida las referencias del flujo abierto contra el código actual (p. ej. tras guardar o renombrar archivos). */
  async revalidate(): Promise<void> {
    const flow = this.flow;
    if (!flow) return;
    const runId = ++this.validateRunId;
    try {
      const validator = await this.validator();
      const result = await validator.validateFlow(flow);
      if (runId !== this.validateRunId || this.flow?.id !== flow.id) return;
      // El mapa de datos puede haber llegado durante la revalidación: se conserva el más reciente.
      const dbMap = this.flow.dbMap;
      this.flow = dbMap ? { ...result.flow, dbMap } : result.flow;
      this.snippets = result.snippets;
      this.fileIds = result.fileIds;
      this.emit();
    } catch (error: unknown) {
      // El flujo se muestra sin fragmentos.
      console.warn('[Nexo IA] No se pudo revalidar el flujo.', error instanceof Error ? error.name : '');
    }
  }

  close(): void {
    this.cancelRequest();
    this.cancelSequence();
    this.player.pause();
  }

  /** Selección manual de un paso: pausa la reproducción y cancela la secuencia antes/después. */
  selectStep(index: number): void {
    this.cancelSequence();
    this.player.select(index);
  }

  /* ---------------------------- modos y datos ---------------------------- */

  setMode(mode: FlowMode): void {
    if (this.ui.mode === mode) return;
    if (mode === 'changes' && !this.activeChange) return;
    if (mode === 'db' && !this.hasDb) return;
    // Salir del modo «Base de datos» cancela la carga del mapa.
    if (this.ui.mode === 'db') this.stopDbRequest();
    this.cancelSequence();
    // Cada modo conserva su resultado: se guarda su vista antes de limpiar los campos compartidos.
    const previous = this.ui.mode;
    if (previous === 'sim' || previous === 'logs') {
      const current = this.result;
      if (current) {
        this.savedViews[previous] = {
          result: current,
          source: this.ui.resultSource,
          snippet: this.resultSnippet,
          revealedFor: this.ui.revealedFor,
          labHeight: this.ui.labHeight,
          labFrozen: this.labFrozen,
        };
      }
    }
    this.detachResult();
    // La comparación de Simular cambios se conserva entre modos.
    this.ui = { ...this.ui, mode, labPane: 'data', labHeight: null, error: null, errorAction: null };
    this.player.runWalk(this.flow?.steps.length ?? 0);
    if (mode === 'sim' || mode === 'logs') this.restoreResult(mode);
    if (mode === 'changes' && this.ui.changeCase && this.caseData(this.ui.changeCase)) this.selectCase(this.ui.changeCase);
    this.emit();
    if (mode === 'db') void this.loadDbMap();
  }

  setSimInput(text: string): void {
    this.clearResult();
    this.ui = { ...this.ui, simInput: text, simPreset: null, simError: null, error: null, errorAction: null };
    this.emit();
  }

  applyPreset(id: string): void {
    const preset = this.flow?.simulationPresets.find((p) => p.id === id);
    if (!preset) return;
    this.clearResult();
    const input = this.presetInput(preset);
    this.ui = { ...this.ui, simInput: this.json(input), simPreset: id, simError: null, error: null, errorAction: null };
    this.emit();
  }

  /** Entrada de un preset. El nombre del caso viaja con los datos: «Publicación inexistente» es una condición aunque el JSON solo lleve un id. */
  presetInput(preset: SimulationPreset): Record<string, unknown> {
    return this.withScenario(preset.label, preset.input);
  }

  private withScenario(label: string, input: unknown): Record<string, unknown> {
    return input && typeof input === 'object' && !Array.isArray(input)
      ? { escenario: label, ...(input as Record<string, unknown>) }
      : { escenario: label, datos: input };
  }

  /** Tras aplicar o deshacer un cambio, los resultados de Simular datos ya no corresponden al código. */
  clearSimResults(): void {
    if (this.ui.mode === 'sim') this.clearResult();
    delete this.savedViews.sim;
    this.ui = { ...this.ui, simResult: null };
    this.emit();
  }

  resetInput(): void {
    this.clearResult();
    if (this.ui.mode === 'logs') this.ui = { ...this.ui, logsInput: '', error: null, errorAction: null };
    else this.ui = { ...this.ui, simInput: this.json(this.flow?.inputExample ?? {}), simPreset: null, simError: null, error: null, errorAction: null };
    this.logsNotice = null;
    this.emit();
  }

  setLogsInput(text: string): void {
    this.clearResult();
    this.ui = { ...this.ui, logsInput: text, error: null, errorAction: null };
    this.logsNotice = null;
    this.emit();
  }

  setLabHeight(height: number | null): void {
    this.labFrozen = false;
    this.ui = { ...this.ui, labHeight: height };
    this.emit();
  }

  setLabPane(pane: 'data' | 'result'): void {
    this.ui = { ...this.ui, labPane: pane };
    this.emit();
  }

  /**
   * Cambiar los datos o aplicar un preset borra el resultado del modo actual (el de Simular datos o el de Analizar
   * logs; en otros modos, ambos) y para el reproductor. El resultado del otro modo se conserva.
   */
  private clearResult(): void {
    this.detachResult();
    const mode = this.ui.mode;
    if (mode === 'sim') {
      this.ui = { ...this.ui, simResult: null };
      delete this.savedViews.sim;
    } else if (mode === 'logs') {
      this.ui = { ...this.ui, logsResult: null, pre: null };
      delete this.savedViews.logs;
    } else {
      this.ui = { ...this.ui, simResult: null, logsResult: null, pre: null };
      this.savedViews = {};
    }
  }

  /** Quita de la vista el resultado visible (cancela la petición y para el reproductor) sin borrar los resultados de cada modo. */
  private detachResult(): void {
    this.cancelRequest();
    this.ui = { ...this.ui, resultVisible: false, busy: false, error: null, errorAction: null, revealedFor: null, resultSource: null };
    if (this.labFrozen) {
      this.labFrozen = false;
      this.ui = { ...this.ui, labHeight: null };
    }
    this.resultSnippet = null;
    this.player.reset();
  }

  /** Vuelve a un modo con resultado guardado: lo muestra tal cual, al final del recorrido, sin animación ni petición. */
  private restoreResult(kind: 'sim' | 'logs'): void {
    const r = kind === 'sim' ? this.ui.simResult : this.ui.logsResult;
    if (!r || !this.flow) return;
    const saved = this.savedViews[kind];
    const view = saved && saved.result === r ? saved : null;
    this.resultSnippet = view?.snippet ?? null;
    this.labFrozen = view?.labFrozen ?? false;
    this.ui = { ...this.ui, resultSource: view?.source ?? null, revealedFor: view?.revealedFor ?? null, labHeight: view?.labHeight ?? null };
    this.player.showResultNow(() => {
      this.ui = { ...this.ui, resultVisible: true, labPane: 'result' };
    });
    this.player.select(this.targetOf(r, kind) ?? 0);
  }

  /** Un chip por resultado guardado de Simular datos / Analizar logs; solo se muestran en el modo Recorrido. */
  savedResultPills(): SavedResultPill[] {
    if (this.ui.mode !== 'walk' || !this.flow) return [];
    const total = this.flow.steps.length;
    const out: SavedResultPill[] = [];
    const build = (mode: 'sim' | 'logs', r: FlowDiagnosis | null): void => {
      if (!r) return;
      const fail = this.failIndexOf(r);
      let pill: FlowStatusPill;
      if (fail >= 0) {
        pill = r.kind === 'stop'
          ? { tone: 'warning', key: 'aiFlow.pill.stop', params: { n: fail + 1 } }
          : { tone: 'danger', key: 'aiFlow.pill.fail', params: { n: fail + 1 } };
      } else if (r.kind === 'ok') pill = { tone: 'success', key: 'aiFlow.pill.ok', params: { n: total, total } };
      else pill = { tone: 'accent', key: 'aiFlow.pill.none', params: {} };
      out.push({ mode, pill });
    };
    build('sim', this.ui.simResult);
    build('logs', this.ui.logsResult);
    return out;
  }

  /** Marca del número de paso en el Recorrido: el que falla o se detiene según el resultado guardado (simulación; si no, logs). */
  savedFailMark(i: number): 'danger' | 'warning' | null {
    if (this.ui.mode !== 'walk') return null;
    const r = this.ui.simResult ?? this.ui.logsResult;
    if (!r || this.failIndexOf(r) !== i) return null;
    return r.kind === 'stop' ? 'warning' : 'danger';
  }

  /* ---------------------------- simular ---------------------------- */

  async simulate(): Promise<void> {
    const flow = this.flow;
    if (!flow || this.ui.busy) return;
    const text = this.ui.simInput.replace(/^﻿/, '');
    if (!text.trim()) return this.setSimError(this.i18n.t('aiFlow.jsonEmpty'));
    if (text.length > MAX_INPUT_CHARS) return this.setSimError(this.i18n.t('aiFlow.jsonTooLong', { max: MAX_INPUT_CHARS }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      return this.setSimError(this.i18n.t('aiFlow.jsonError', { message: error instanceof Error ? error.message : '' }));
    }
    const input = maskSensitiveJson(parsed);
    this.lastOperation = 'sim';
    await this.runDiagnosis('simulate', flow, { input });
  }

  private setSimError(message: string): void {
    this.ui = { ...this.ui, simError: message };
    this.emit();
  }

  /* ---------------------------- logs ---------------------------- */

  async analyze(): Promise<void> {
    const flow = this.flow;
    if (!flow || this.ui.busy) return;
    let raw = this.ui.logsInput;
    if (!raw.trim()) return;
    let lines = raw.split(/\r?\n/);
    this.logsNotice = null;
    if (lines.length > MAX_LOG_LINES || raw.length > MAX_LOG_CHARS) {
      lines = lines.slice(-MAX_LOG_LINES);
      raw = lines.join('\n');
      if (raw.length > MAX_LOG_CHARS) raw = raw.slice(raw.length - MAX_LOG_CHARS);
      this.logsNotice = this.i18n.t('aiFlow.logsTrimmed', { lines: MAX_LOG_LINES, chars: MAX_LOG_CHARS });
    }
    const { masked, pre } = analyzeLogs(raw, flow, (file) => this.projectFileExists(file));
    this.ui = { ...this.ui, pre };
    this.lastOperation = 'logs';
    await this.runDiagnosis('logs', flow, { logs: masked, pre }, masked);
  }

  /** El archivo de un marco de pila existe en algún montaje (por sufijo de ruta y nombre). */
  private projectFileExists(file: string): boolean {
    const clean = file.replace(/\\/g, '/').replace(/^.*?(?:webpack:\/\/\/?|file:\/\/\/?)/, '').replace(/^\.?\//, '').replace(/[?#].*$/, '');
    if (!clean) return false;
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    return this.project.project.files.some((f) => f.path === clean || f.path.endsWith(`/${clean}`) || (clean === name && f.name === name));
  }

  retry(): void {
    if (this.lastOperation === 'logs' || (this.ui.mode === 'logs' && !this.lastOperation)) void this.analyze();
    else void this.simulate();
  }

  /* ---------------------------- petición común ---------------------------- */

  private async runDiagnosis(kind: 'simulate' | 'logs', flow: FlowDiagram, extra: Record<string, unknown>, maskedLogs?: string): Promise<void> {
    this.cancelRequest();
    const runId = ++this.runId;
    this.player.reset();
    if (this.labFrozen) {
      this.labFrozen = false;
      this.ui = { ...this.ui, labHeight: null };
    }
    // Solo se borra el resultado de su tipo: el del otro modo se conserva.
    if (kind === 'simulate') {
      this.ui = { ...this.ui, simResult: null };
      delete this.savedViews.sim;
    } else {
      this.ui = { ...this.ui, logsResult: null };
      delete this.savedViews.logs;
    }
    this.ui = { ...this.ui, busy: true, error: null, errorAction: null, simError: null, resultVisible: false, resultSource: null };
    this.resultSnippet = null;
    this.emit();

    let contextBase64: string;
    try {
      const code = await this.codeWindows(flow);
      if (runId !== this.runId) return;
      const logLines = maskedLogs !== undefined ? maskedLogs.split(/\r?\n/).length : undefined;
      contextBase64 = this.encode({ flowId: flow.id, flow: this.flowForBackend(flow), code, ...extra, ...(logLines !== undefined ? { logLines } : {}) });
    } catch (error: unknown) {
      if (runId !== this.runId) return;
      console.warn('[Nexo IA] No se pudo preparar el contexto.', error instanceof Error ? error.name : '');
      this.fail(this.i18n.t('ai.error.generic'));
      return;
    }
    const body = { language: this.i18n.language, contextBase64 };
    const id = this.bridge.newId();
    this.pendingId = id;
    this.bridge.request<FlowDiagnosisResponse>({ op: 'flow', kind, body }, id).then(
      (response) => {
        if (runId !== this.runId) return;
        this.pendingId = null;
        const source: FlowResultSource = { provider: 'lm', model: response?.model || this.config.modelName || this.i18n.t('ai.model.unknown') };
        void this.onDiagnosis(response, kind === 'simulate' ? 'sim' : 'logs', flow, runId, maskedLogs, source);
      },
      (error: unknown) => {
        if (runId !== this.runId) return;
        this.pendingId = null;
        this.fail((error instanceof Error && error.message) || this.i18n.t('ai.error.generic'));
      },
    );
  }

  /** Procesa el resultado de un diagnóstico. Devuelve `true` si quedó mostrado. */
  private async onDiagnosis(response: FlowDiagnosisResponse | null, kind: 'sim' | 'logs', flow: FlowDiagram, runId: number,
    maskedLogs: string | undefined, source: FlowResultSource): Promise<boolean> {
    if (!response || !response.success) {
      this.fail(response?.mensaje || this.i18n.t('ai.error.generic'));
      return false;
    }
    return this.presentDiagnosis(response.result, kind, flow, runId, maskedLogs, source);
  }

  /** Sanea, revalida (`where`/`snippet`) y reproduce un diagnóstico. Devuelve `true` si quedó mostrado. */
  private async presentDiagnosis(raw: unknown, kind: 'sim' | 'logs', flow: FlowDiagram, runId: number,
    maskedLogs: string | undefined, source: FlowResultSource): Promise<boolean> {
    let diagnosis: SimulationResult | LogAnalysisResult | null = kind === 'sim'
      ? sanitizeDiagnosis(raw, flow, 'sim')
      : sanitizeDiagnosis(raw, flow, 'logs');
    if (!diagnosis) {
      this.fail(this.i18n.t('ai.error.schema'));
      return false;
    }
    if (kind === 'logs' && maskedLogs !== undefined) {
      // La evidencia se muestra con el texto enmascarado local (nunca el que devuelve la IA).
      const lines = maskedLogs.split(/\r?\n/);
      const logs = diagnosis as LogAnalysisResult;
      const evidence = logs.evidence.filter((e) => e.index < lines.length).map((e) => ({ ...e, text: lines[e.index] }));
      const pre = this.ui.pre;
      const seen = logs.seenStepIds.length ? logs.seenStepIds : pre?.seenStepIds ?? [];
      diagnosis = { ...logs, evidence: evidence.length ? evidence : (pre?.evidence ?? []), seenStepIds: seen };
    }
    let snippet: SnippetView | null = null;
    try {
      const validator = await this.validator();
      const checked = await validator.validateDiagnosis(diagnosis);
      diagnosis = checked.diagnosis;
      snippet = checked.snippet;
    } catch (error: unknown) {
      // Sin fragmento.
      console.warn('[Nexo IA] No se pudo validar el diagnóstico.', error instanceof Error ? error.name : '');
    }
    if (runId !== this.runId || this.flow?.id !== flow.id) return false;
    this.resultSnippet = snippet;
    this.ui = kind === 'sim'
      ? { ...this.ui, busy: false, claudeRun: null, resultSource: source, simResult: diagnosis as SimulationResult }
      : { ...this.ui, busy: false, claudeRun: null, resultSource: source, logsResult: diagnosis as LogAnalysisResult };
    this.play(diagnosis, kind);
    return true;
  }

  /** Reproduce hasta el paso que falla (o el último / último visto) y muestra el resultado solo al llegar. */
  private play(d: FlowDiagnosis, kind: 'sim' | 'logs'): void {
    const flow = this.flow;
    if (!flow) return;
    const target = this.targetOf(d, kind);
    const onArrive = () => this.arrive();
    if (target === null) this.player.showResultNow(onArrive);
    else this.player.runTo(target, onArrive, flow.steps.length);
    this.emit();
  }

  /** Paso objetivo de la reproducción: el que falla, el último (ok) o el último visto; `null` si no hay ninguno. */
  private targetOf(d: FlowDiagnosis, kind: 'sim' | 'logs'): number | null {
    const flow = this.flow;
    if (!flow) return null;
    const total = flow.steps.length;
    const failIndex = d.failStepId ? flow.steps.findIndex((s) => s.id === d.failStepId) : -1;
    if ((d.kind === 'error' || d.kind === 'stop') && failIndex >= 0) return failIndex;
    if (d.kind === 'ok') return total - 1;
    const seen = kind === 'logs' ? (d as LogAnalysisResult).seenStepIds : (d as SimulationResult).executedStepIds;
    const indexes = seen.map((id) => flow.steps.findIndex((s) => s.id === id)).filter((i) => i >= 0);
    return indexes.length ? Math.max(...indexes) : null;
  }

  private arrive(): void {
    const height = this.ui.labHeight ?? this.labMeasure?.() ?? null;
    if (this.ui.labHeight === null && height !== null) this.labFrozen = true;
    this.ui = { ...this.ui, resultVisible: true, labPane: 'result', labHeight: height };
    this.emit();
  }

  private fail(message: string): void {
    this.ui = { ...this.ui, busy: false, error: message, errorAction: null };
    this.emit();
  }

  private cancelRequest(): void {
    this.runId++;
    this.cancelPending();
    if (this.ui.busy) this.ui = { ...this.ui, busy: false };
  }

  private cancelPending(): void {
    const id = this.pendingId;
    this.pendingId = null;
    if (id) this.bridge.cancel(id);
  }

  /* ---------------------------- código para el backend ---------------------------- */

  /** Ventanas de ±40 líneas alrededor de cada referencia verificada, fusionadas por archivo (solo archivos permitidos). */
  private async codeWindows(flow: FlowDiagram): Promise<CodeWindow[]> {
    return (await this.codeWindowsWith(flow)).windows;
  }

  /**
   * Como `codeWindows`, pero las ventanas de `pinned` van primero, enteras (nunca se cortan por caracteres; si no
   * caben, `WindowTooLargeError`) y las de las referencias no las repiten. `extra` son rangos adicionales tratados como
   * referencias. Devuelve también cuántas ventanas fijas hay al principio.
   */
  private async codeWindowsWith(flow: FlowDiagram, pinned: PinnedSpans = new Map(), extra: PinnedSpans = new Map(),
    radius = WINDOW_RADIUS): Promise<{ windows: CodeWindow[]; pinned: number }> {
    const validator = await this.validator();
    const out: CodeWindow[] = [];
    let total = 0;
    const blocked = new Map<string, [number, number][]>();
    for (const { file, spans } of pinned.values()) {
      const lines = await validator.linesOf(file);
      if (!lines) throw new Error(this.i18n.t('ai.error.generic'));
      const merged = mergeSpans(spans.map(([a, b]) => [Math.max(1, a), Math.min(lines.length, b)] as [number, number]));
      for (const [start, end] of merged) {
        if (start > end) continue;
        const content = lines.slice(start - 1, end).join('\n');
        if (content.length > MAX_WINDOW_CHARS || out.length >= MAX_WINDOWS || total + content.length > MAX_CODE_CHARS) throw new WindowTooLargeError();
        total += content.length;
        out.push({ path: file.path, startLine: start, endLine: end, content });
      }
      blocked.set(file.id, merged);
    }
    const pinnedCount = out.length;
    const refs: CodeRef[] = [
      ...flow.steps.map((s) => s.ref).filter((r): r is CodeRef => !!r),
      ...flow.steps.map((s) => s.snippet?.ref).filter((r): r is CodeRef => !!r),
      ...flow.files,
    ].filter((r) => r.verification !== 'unverified');
    const ranges = new Map<string, { file: WorkspaceCodeFile; spans: [number, number][] }>();
    for (const { file, spans } of extra.values()) {
      if (!validator.usable(file)) continue;
      ranges.set(file.id, { file, spans: [...spans] });
    }
    for (const ref of refs) {
      const file = validator.resolveFile(ref);
      if (!validator.usable(file)) continue;
      const entry = ranges.get(file.id) ?? { file, spans: [] };
      entry.spans.push([Math.max(1, ref.line - radius), ref.line + radius]);
      ranges.set(file.id, entry);
    }
    for (const { file, spans } of ranges.values()) {
      const lines = await validator.linesOf(file);
      if (!lines) continue;
      let merged = mergeSpans(spans);
      const skip = blocked.get(file.id);
      if (skip) merged = subtractSpans(merged, skip);
      for (const [start, rawEnd] of merged) {
        if (out.length >= MAX_WINDOWS) return { windows: out, pinned: pinnedCount };
        const end = Math.min(lines.length, rawEnd);
        if (start > end) continue;
        let content = lines.slice(start - 1, end).join('\n');
        if (content.length > MAX_WINDOW_CHARS) content = content.slice(0, MAX_WINDOW_CHARS);
        const realEnd = start + content.split('\n').length - 1;
        if (total + content.length > MAX_CODE_CHARS) return { windows: out, pinned: pinnedCount };
        total += content.length;
        out.push({ path: file.path, startLine: start, endLine: realEnd, content });
      }
    }
    return { windows: out, pinned: pinnedCount };
  }

  /** El flujo tal cual se validó (sin fragmentos resueltos ni marcas de verificación). */
  private flowForBackend(flow: FlowDiagram): FlowDiagram {
    const strip = (r: CodeRef | null): CodeRef | null => {
      if (!r) return r;
      const copy = { ...r };
      delete copy.verification;
      return copy;
    };
    const out: FlowDiagram = {
      ...flow,
      steps: flow.steps.map((s) => {
        // `codeSnapshot` es solo del frontend: no viaja al backend.
        const rest = { ...s };
        delete rest.codeSnapshot;
        return { ...rest, ref: strip(s.ref), snippet: s.snippet ? { ...s.snippet, ref: strip(s.snippet.ref) as CodeRef } : null };
      }),
      files: flow.files.map((f) => strip(f) as CodeRef),
    };
    // El escenario ya simulado solo se usa al abrir la vista: no sube el coste ni el límite del flujo en el backend.
    delete out.scenario;
    // El mapa de datos es solo del frontend.
    delete out.dbMap;
    return out;
  }

  /** `keep`: ventanas iniciales que no se pueden quitar; si aun así no cabe, `WindowTooLargeError`. */
  private encode(payload: { code: CodeWindow[] } & Record<string, unknown>, keep = 0): string {
    const ctx = { ...payload, code: payload.code.map((w) => ({ ...w, content: maskConfigSecrets(w.path, w.content) })) };
    let base64 = encodeUtf8Base64(JSON.stringify(ctx));
    while (base64.length > MAX_CONTEXT_BASE64 && ctx.code.length > keep) {
      ctx.code.pop();
      base64 = encodeUtf8Base64(JSON.stringify(ctx));
    }
    if (keep > 0 && base64.length > MAX_CONTEXT_BASE64) throw new WindowTooLargeError();
    return base64;
  }

  private async validator(): Promise<FlowRefValidator> {
    return new FlowRefValidator(this.project, await this.project.fileFilter());
  }

  /* ---------------------------- editor ---------------------------- */

  /**
   * «Abrir en el editor»: abre el archivo de la referencia en su línea. Una referencia no verificada se abre si su
   * archivo se resuelve en el proyecto (línea aproximada); si no existe o no está permitido, no hace nada.
   */
  async openInEditor(ref: CodeRef | null, fileId?: string | null): Promise<void> {
    if (!ref) return;
    let id = fileId ?? (ref.verification !== 'unverified' ? this.fileIds.get(refKey(ref)) : null) ?? null;
    let line = ref.line;
    if (!id) {
      const validator = await this.validator();
      const checked = await validator.verify(ref);
      if (!checked.file) return;
      id = checked.file.id;
      line = checked.ref.line;
    }
    this.postOpenRef(id, line);
  }

  /** Abre un fragmento mostrado (`SnippetView`) en el editor; los generados o sin archivo del proyecto no se abren. */
  openSnippetView(view: SnippetView | null): void {
    if (!view || view.generated || !view.fileId) return;
    const fileId = view.fileId;
    if (!this.project.project.files.some((f) => f.id === fileId)) return;
    this.postOpenRef(fileId, view.highlightLine);
  }

  private postOpenRef(id: string, line: number): void {
    const safeLine = Number.isFinite(line) ? Math.max(1, Math.floor(line)) : 1;
    this.ui = { ...this.ui, revealedFor: `${id}:${safeLine}` };
    const file = this.project.sample ? this.project.project.files.find((f) => f.id === id) ?? null : null;
    this.bridge.post({
      type: 'openRef',
      fileId: id,
      line: safeLine,
      ...(file ? { sample: { path: file.path, content: file.content, language: file.language } } : {}),
    });
  }

  /**
   * Código del método de la función del paso `scriptIndex` del modo «Base de datos» (`Clase.método`), releído de los
   * archivos reales; `null` si no se localiza.
   */
  async dbFnSnippet(scriptIndex: number): Promise<SnippetView | null> {
    const flow = this.flow;
    const view = this.dbView;
    if (!flow || !view) return null;
    const step = flow.steps[view.indexes[scriptIndex]];
    const access = step ? view.accesses.get(step.id) : null;
    if (!step || !access || !access.fn) return null;
    const parts = access.fn.trim().replace(/\(\)\s*$/, '').split('.').filter(Boolean);
    const method = parts[parts.length - 1] ?? '';
    const className = parts.length > 1 ? parts[parts.length - 2] : '';
    if (!method) return null;
    const matches = (r: CodeRef | null | undefined): r is CodeRef =>
      !!r && r.functionName === method && (!className || r.className === className);
    let hint: CodeRef | null = null;
    let hintStepId: string | null = null;
    const pool: { ref: CodeRef | null | undefined; stepId: string }[] = [
      { ref: step.ref, stepId: step.id },
      { ref: step.snippet?.ref, stepId: step.id },
      ...flow.steps.filter((s) => s !== step).flatMap((s) => [{ ref: s.ref, stepId: s.id }, { ref: s.snippet?.ref, stepId: s.id }]),
    ];
    for (const p of pool) {
      if (matches(p.ref)) {
        hint = p.ref;
        hintStepId = p.stepId;
        break;
      }
    }
    if (!hint) hint = step.ref ?? null;
    const found = await (await this.validator()).methodSnippet(className, method, hint);
    if (found) return found;
    if (hint && hintStepId && hint.functionName === method) {
      const fallback = this.snippets.get(hintStepId);
      if (fallback && fallback.lines.length && fallback.fileId) return fallback;
    }
    return null;
  }

  /* ---------------------------- Simular cambios ---------------------------- */

  /** Propuesta `pending`/`applied` del flujo abierto (habilita el modo «Simular cambios»). */
  get activeChange(): { messageId: string; proposal: ChangeProposal } | null {
    return this.flow ? this.activeChangeFor(this.flow.id) : null;
  }

  private activeChangeFor(flowId: string): { messageId: string; proposal: ChangeProposal } | null {
    const found = this.changeLookup?.(flowId) ?? null;
    if (!found) return null;
    const status = found.proposal.status;
    return (status === 'pending' || status === 'applied') && found.proposal.flowId === flowId ? found : null;
  }

  /** Lo llama el servicio de cambios al cambiar el estado de una propuesta. */
  refreshChange(): void {
    const active = this.activeChange;
    // La comparación es de una propuesta concreta: si ya no es la activa (descartada, otra más reciente), se quita.
    if (this.ui.comparison && this.ui.comparison.proposalId !== active?.proposal.id) {
      this.cancelSequence();
      this.ui = { ...this.ui, comparison: null, changeCase: null, changeSide: 'before', changeError: null };
    }
    if (this.ui.mode === 'changes' && !active) {
      this.setMode('walk');
      return;
    }
    this.emit();
  }

  caseData(id: string | null): Required<CaseComparison> | null {
    const comparison = this.ui.comparison;
    if (!comparison || !id) return null;
    return comparison.cases.find((c) => c.preset.id === id) ?? null;
  }

  get currentCase(): Required<CaseComparison> | null {
    return this.caseData(this.ui.changeCase);
  }

  /**
   * Compara la propuesta con los presets del flujo: el backend simula cada caso con el código actual y con el diff
   * aplicado en memoria. La etiqueta (arreglado, regresión…) la calcula el frontend.
   */
  async compareChange(proposal: ChangeProposal): Promise<CompareOutcome> {
    const flow = this.flow;
    if (!flow || proposal.flowId !== flow.id) return { status: 'error', message: this.i18n.t('aiChange.noFlow') };
    this.cancelCompare();
    this.cancelSequence();
    const runId = ++this.compareRunId;
    this.player.reset();
    this.ui = { ...this.ui, changeBusy: true, changeError: null, changeErrorAction: null, comparison: null, changeCase: null, changeSide: 'before', resultVisible: false };
    this.emit();
    const fail = (message: string): CompareOutcome => {
      if (runId !== this.compareRunId) return { status: 'cancelled' };
      this.ui = { ...this.ui, changeBusy: false, changeError: message, changeErrorAction: null };
      this.emit();
      return { status: 'error', message };
    };

    let contextBase64: string;
    try {
      contextBase64 = await this.compareContext(flow, proposal);
    } catch (error: unknown) {
      if (runId !== this.compareRunId) return { status: 'cancelled' };
      if (error instanceof WindowTooLargeError) return fail(this.i18n.t('aiChange.tooLarge'));
      if (error instanceof ChangeContextError) return fail(error.message);
      console.warn('[Nexo IA] No se pudo preparar la comparación.', error instanceof Error ? error.name : '');
      return fail(this.i18n.t('aiChange.compareFailed'));
    }
    if (runId !== this.compareRunId) return { status: 'cancelled' };

    const body = { flowId: flow.id, language: this.i18n.language, contextBase64 };
    const id = this.bridge.newId();
    return new Promise<CompareOutcome>((resolve) => {
      this.compareResolve = resolve;
      this.comparePendingId = id;
      this.bridge.request<ChangeCompareResponse>({ op: 'compareChange', proposalId: proposal.id, body }, id).then(
        (response) => {
          if (runId !== this.compareRunId) return;
          this.comparePendingId = null;
          this.compareResolve = null;
          const source: FlowResultSource = { provider: 'lm', model: response?.model || this.config.modelName || this.i18n.t('ai.model.unknown') };
          resolve(this.onComparison(response, proposal, flow.id, fail, source));
        },
        (error: unknown) => {
          if (runId !== this.compareRunId) return;
          this.comparePendingId = null;
          this.compareResolve = null;
          resolve(fail((error instanceof Error && error.message) || this.i18n.t('aiChange.compareFailed')));
        },
      );
    });
  }

  private onComparison(response: ChangeCompareResponse | null, proposal: ChangeProposal, flowId: string,
    fail: (message: string) => CompareOutcome, source: FlowResultSource): CompareOutcome {
    const flow = this.flow;
    if (!flow || flow.id !== flowId) return { status: 'cancelled' };
    if (!response || !response.success || !response.comparison) return fail(response?.mensaje || this.i18n.t('aiChange.compareFailed'));
    const presets = new Map(flow.simulationPresets.map((p) => [p.id, p]));
    const cases: Required<CaseComparison>[] = [];
    for (const item of Array.isArray(response.comparison.cases) ? response.comparison.cases : []) {
      const preset = presets.get(String(item?.presetId ?? ''));
      // Los resultados de «después» apuntan al código parcheado: se sanean pero no se validan sus referencias.
      const before = sanitizeDiagnosis(item?.before, flow, 'sim');
      const after = sanitizeDiagnosis(item?.after, flow, 'sim');
      if (!preset || !before || !after) return fail(this.i18n.t('ai.error.schema'));
      cases.push({ preset, before, after, tag: compareTag(before, after, caseTouchedByChange(flow, proposal.files, before, after)) });
    }
    if (!cases.length) return fail(this.i18n.t('ai.error.schema'));
    const sorted = sortCases(cases, flow.simulationPresets);
    const initial = sorted.find((c) => c.tag === 'regression') ?? sorted.find((c) => c.tag === 'fixed') ?? sorted[0];
    this.ui = {
      ...this.ui,
      changeBusy: false,
      changeError: null,
      changeErrorAction: null,
      claudeRun: null,
      comparison: { proposalId: proposal.id, flowId: flow.id, cases: sorted, source },
      changeSide: 'before',
      changeCase: initial.preset.id,
    };
    if (this.ui.mode === 'changes') this.selectCase(initial.preset.id);
    else this.emit();
    return { status: 'ok' };
  }

  /** Contexto de la comparación: flujo, ventanas de código (las de los bloques, enteras), bloques corregidos y casos. */
  private async compareContext(flow: FlowDiagram, proposal: ChangeProposal): Promise<string> {
    const validator = await this.validator();
    const mounts = this.project.project.mounts;
    const targets: { file: WorkspaceCodeFile | null; change: FileChange; path: string; hunks: DiffHunk[] }[] = [];
    for (const change of proposal.files) {
      const target = resolveChangeTarget(mounts, (path) => this.project.fileByPath(path), change);
      if (!target) throw new ChangeContextError(this.i18n.t('aiChange.notAllowed'));
      const file = this.project.fileByPath(target.path) ?? null;
      let hunks = change.hunks;
      if (change.status !== 'added') {
        if (!validator.usable(file)) throw new ChangeContextError(this.i18n.t('aiChange.notAllowed'));
        const lines = await validator.linesOf(file);
        if (!lines) throw new ChangeContextError(this.i18n.t('aiChange.notAllowed'));
        // Los bloques se vuelven a encajar contra el código actual (el backend exige `oldStart` exacto).
        const applied = applyFileChange(lines.join('\n'), change);
        if (!applied.ok) throw new ChangeContextError(this.i18n.t('aiChange.invalidDiff'));
        hunks = applied.hunks;
      }
      targets.push({ file, change, path: target.path, hunks });
    }
    const cases = flow.simulationPresets.slice(0, MAX_COMPARE_CASES)
      .map((p) => ({ presetId: p.id, input: maskSensitiveJson(this.presetInput(p)) }));
    if (!cases.length) throw new ChangeContextError(this.i18n.t('aiChange.compareFailed'));
    const files = targets.map((t) => ({
      path: t.path,
      status: t.change.status,
      hunks: t.hunks.map((h) => ({
        oldStart: h.oldStart,
        newStart: h.newStart,
        lines: h.lines.map((l) => ({ kind: l.kind, text: maskConfigSecrets(t.path, l.text) })),
      })),
    }));
    for (const radius of CHANGE_RADII) {
      const pinned: PinnedSpans = new Map();
      const extra: PinnedSpans = new Map();
      for (const t of targets) {
        if (!t.file || t.change.status === 'added') continue;
        const spans = t.hunks.map((h) => {
          const oldCount = h.lines.filter((l) => l.kind !== 'add').length;
          const oldEnd = oldCount ? h.oldStart + oldCount - 1 : h.oldStart;
          return [Math.max(1, h.oldStart - radius), oldEnd + radius] as [number, number];
        });
        const bucket = t.change.status === 'modified' ? pinned : extra;
        const entry = bucket.get(t.file.id) ?? { file: t.file, spans: [] };
        entry.spans.push(...spans);
        bucket.set(t.file.id, entry);
      }
      try {
        const { windows, pinned: keep } = await this.codeWindowsWith(flow, pinned, extra);
        return this.encode({ flowId: flow.id, flow: this.flowForBackend(flow), code: windows, files, cases, title: proposal.title, summary: proposal.summary }, keep);
      } catch (error: unknown) {
        if (!(error instanceof WindowTooLargeError)) throw error;
      }
    }
    throw new WindowTooLargeError();
  }

  /** Selecciona un caso de la tabla: cancela la secuencia y deja el lado actual pausado en su paso final. */
  selectCase(id: string): void {
    this.cancelSequence();
    const data = this.caseData(id);
    if (!data || !this.flow) return;
    this.ui = { ...this.ui, changeCase: id };
    const target = this.targetOf(data[this.ui.changeSide], 'sim');
    this.player.showResultNow(() => this.onSideArrive());
    this.player.select(target ?? 0);
    this.emit();
  }

  /** Selector Antes | Después: reproduce ese lado para el caso seleccionado. */
  setSide(side: 'before' | 'after'): void {
    this.cancelSequence();
    if (!this.currentCase) {
      this.ui = { ...this.ui, changeSide: side };
      this.emit();
      return;
    }
    this.playSide(side);
  }

  /** «Simular antes y después»: Antes hasta su paso final o de error, pausa de 1,1 s y Después. */
  playBeforeAfter(): void {
    this.cancelSequence();
    if (!this.currentCase) return;
    this.sequence = true;
    this.playSide('before', () => {
      if (!this.sequence) return;
      this.sequenceTimer = setTimeout(() => {
        this.sequenceTimer = null;
        if (!this.sequence) return;
        this.sequence = false;
        this.playSide('after');
      }, BEFORE_AFTER_GAP_MS);
    });
  }

  private playSide(side: 'before' | 'after', then?: () => void): void {
    const data = this.currentCase;
    const flow = this.flow;
    if (!data || !flow) return;
    this.ui = { ...this.ui, changeSide: side, resultVisible: false };
    const target = this.targetOf(data[side], 'sim');
    const onArrive = () => {
      this.onSideArrive();
      if (then) then();
    };
    if (target === null) this.player.showResultNow(onArrive);
    else this.player.runTo(target, onArrive, flow.steps.length);
    this.emit();
  }

  /** Al llegar solo se muestra el resultado (no se congela la altura de la sección de abajo). */
  private onSideArrive(): void {
    this.ui = { ...this.ui, resultVisible: true };
    this.emit();
  }

  private cancelSequence(): void {
    this.sequence = false;
    if (this.sequenceTimer) clearTimeout(this.sequenceTimer);
    this.sequenceTimer = null;
  }

  private cancelCompare(): void {
    this.compareRunId++;
    const id = this.comparePendingId;
    this.comparePendingId = null;
    if (id) this.bridge.cancel(id);
    if (this.ui.changeBusy) this.ui = { ...this.ui, changeBusy: false };
    const resolve = this.compareResolve;
    this.compareResolve = null;
    if (resolve) resolve({ status: 'cancelled' });
  }

  /* ---------------------------- estados de la vista ---------------------------- */

  get result(): SimulationResult | LogAnalysisResult | null {
    if (this.ui.mode === 'sim') return this.ui.simResult;
    if (this.ui.mode === 'logs') return this.ui.logsResult;
    if (this.ui.mode === 'changes') {
      const current = this.currentCase;
      return current ? current[this.ui.changeSide] : null;
    }
    return null;
  }

  /**
   * Contexto de la vista de pantalla del resultado visible (`null` = sin opción «Visualizar pantalla»). No toca el
   * reproductor ni emite cambios.
   */
  screenContext(): UiScreenContext | null {
    const ui = this.ui;
    const flow = this.flow;
    if (!flow || ui.mode === 'walk' || ui.mode === 'db' || !ui.resultVisible) return null;
    const result = this.result;
    if (!result) return null;
    const anchor = this.targetOf(result, ui.mode === 'logs' ? 'logs' : 'sim');
    if (anchor === null) return null;
    const kind = result.kind;
    const tone = kind === 'stop' ? 'warning' : kind === 'error' ? 'danger' : kind === 'ok' ? 'success' : 'accent';
    if (ui.mode === 'changes') {
      const current = this.currentCase;
      if (!current) return null;
      return {
        key: current,
        mode: 'changes',
        flowId: flow.id,
        anchor,
        tone,
        before: current.before,
        afterResult: current.after ?? null,
        proposal: this.activeChange?.proposal ?? null,
        initialTab: ui.changeSide === 'after' ? 'after' : 'now',
        input: maskSensitiveJson(this.presetInput(current.preset)),
      };
    }
    let input: unknown = null;
    if (ui.mode === 'sim') {
      try {
        input = maskSensitiveJson(JSON.parse(ui.simInput.replace(/^﻿/, '')));
      } catch (error: unknown) {
        console.warn('[Nexo IA] Datos de entrada no válidos para la vista de pantalla.', error instanceof Error ? error.name : '');
        input = null;
      }
    } else {
      const pre = ui.pre;
      input = { exception: pre?.exception ?? null, httpStatuses: pre?.httpStatuses ?? [] };
    }
    return {
      key: result,
      mode: ui.mode,
      flowId: flow.id,
      anchor,
      tone,
      before: result,
      afterResult: null,
      proposal: ui.mode === 'sim' ? this.activeChange?.proposal ?? null : null,
      initialTab: 'now',
      input,
    };
  }

  /** Plan de la vista de pantalla (`UiPreviewPlan`) con Nexo IA (`POST …/flow/ui-plan` desde el host). Cancelable. */
  requestUiPlan(contextBase64: string): UiPlanRequest {
    return this.requestFlowResult('ui-plan', contextBase64, this.i18n.t('aiFlow.screen.failed'));
  }

  /** Petición cancelable de un resultado de flujo al host (`POST …/flow/{kind}`). No toca el laboratorio. */
  private requestFlowResult(kind: FlowKind, contextBase64: string, failMessage: string): FlowResultRequest {
    let settled = false;
    let resolveOuter!: (outcome: UiPlanOutcome) => void;
    const promise = new Promise<UiPlanOutcome>((resolve) => {
      resolveOuter = resolve;
    });
    const finish = (outcome: UiPlanOutcome): void => {
      if (settled) return;
      settled = true;
      resolveOuter(outcome);
    };
    if (!this.flow) {
      finish({ status: 'error', message: failMessage });
      return { promise, cancel: () => finish({ status: 'cancelled' }) };
    }
    const body = { language: this.i18n.language, contextBase64 };
    const id = this.bridge.newId();
    this.bridge.request<FlowDiagnosisResponse>({ op: 'flow', kind, body }, id).then(
      (response) => {
        if (!response || !response.success) {
          finish({ status: 'error', message: response?.mensaje || failMessage });
          return;
        }
        finish({ status: 'ok', plan: response.result, source: { provider: 'lm', model: response.model || this.config.modelName || this.i18n.t('ai.model.unknown') } });
      },
      (error: unknown) => {
        if (settled) return;
        finish({ status: 'error', message: (error instanceof Error && error.message) || failMessage });
      },
    );
    return {
      promise,
      cancel: () => {
        if (!settled) this.bridge.cancel(id);
        finish({ status: 'cancelled' });
      },
    };
  }

  /* ---------------------------- modo «Base de datos» ---------------------------- */

  /** El flujo toca la base de datos (habilita la pestaña «Base de datos»). */
  get hasDb(): boolean {
    return flowHasDb(this.flow);
  }

  /** Acceso a datos del paso `index` (detalle del modo «Base de datos»); `null` si no accede. */
  dbAccess(index: number): FlowDbAccess | null {
    const id = this.flow?.steps[index]?.id;
    return id ? this.dbView?.accesses.get(id) ?? null : null;
  }

  /**
   * Mapa de datos del flujo: el guardado en el flujo, el de la caché o, si no hay, una petición barata a Nexo IA.
   * `force` («Regenerar») ignora lo guardado y vuelve a leer el esquema de la conexión.
   */
  async loadDbMap(force = false): Promise<void> {
    const flow = this.flow;
    if (!flow || !this.hasDb) return;
    this.stopDbRequest();
    const runId = ++this.dbRunId;
    if (force) this.dbMetaCache.clear();
    const language = this.i18n.language === 'en' ? 'en' : 'es';
    const cacheKey = `${flow.id}|${language}|nexo`;
    const known = force ? null : flow.dbMap ?? this.dbCache.get(cacheKey) ?? null;
    if (known) {
      let conn: FlowDbConnection | null = null;
      try {
        conn = await this.dbConnectionFor(flow, await this.validator(), false);
      } catch (error: unknown) {
        console.warn('[Nexo IA] No se pudo resolver la conexión del mapa de datos.', error instanceof Error ? error.name : '');
      }
      if (runId !== this.dbRunId || this.flow?.id !== flow.id) return;
      this.presentDbMap(known, conn);
      return;
    }

    this.dbView = null;
    this.player.setStops(null);
    this.ui = { ...this.ui, dbStatus: 'loading', dbError: null, dbErrorAction: null, dbClaude: false };
    this.emit();
    let prepared: { contextBase64: string; conn: FlowDbConnection | null };
    try {
      prepared = await this.dbMapContext(flow, force);
    } catch (error: unknown) {
      if (runId !== this.dbRunId) return;
      console.warn('[Nexo IA] No se pudo preparar el contexto del mapa de datos.', error instanceof Error ? error.name : '');
      this.dbFail(this.i18n.t('aiFlow.db.failed'));
      return;
    }
    if (runId !== this.dbRunId) return;
    const request = this.requestFlowResult('db-map', prepared.contextBase64, this.i18n.t('aiFlow.db.failed'));
    this.dbCancel = (escape?: boolean) => request.cancel(escape);
    const outcome = await request.promise;
    if (runId !== this.dbRunId) return;
    this.dbCancel = null;
    if (outcome.status === 'cancelled') {
      this.ui = { ...this.ui, dbStatus: 'idle', dbClaude: false };
      this.emit();
      return;
    }
    if (outcome.status === 'error') {
      this.dbFail(outcome.message);
      return;
    }
    const current = this.flow;
    if (!current || current.id !== flow.id) return;
    const map = sanitizeFlowDbMap(outcome.plan, current);
    if (!map) {
      this.dbFail(this.i18n.t('ai.error.schema'));
      return;
    }
    const stored: FlowDbMapStored = {
      ...map,
      source: outcome.source,
      language,
      generatedAt: new Date().toISOString(),
      schema: prepared.conn ? 'real' : 'code',
      database: prepared.conn?.meta.database ?? null,
    };
    this.flow = { ...current, dbMap: stored };
    this.dbCache.delete(cacheKey);
    this.dbCache.set(cacheKey, stored);
    while (this.dbCache.size > DB_CACHE_LIMIT) this.dbCache.delete(this.dbCache.keys().next().value as string);
    this.presentDbMap(stored, prepared.conn);
  }

  /** Botón «Cancelar» de la carga. */
  cancelDbMap(): void {
    const cancel = this.dbCancel;
    this.dbCancel = null;
    this.dbRunId++;
    cancel?.(true);
    if (this.ui.dbStatus === 'loading') this.ui = { ...this.ui, dbStatus: this.dbView ? 'ready' : 'idle', dbClaude: false };
    this.emit();
  }

  /** Deja de esperar el mapa de datos (cambio de modo o de flujo). */
  private stopDbRequest(): void {
    this.dbRunId++;
    const cancel = this.dbCancel;
    this.dbCancel = null;
    cancel?.(false);
    if (this.ui.dbStatus === 'loading') this.ui = { ...this.ui, dbStatus: this.dbView ? 'ready' : 'idle', dbClaude: false };
  }

  private dbFail(message: string): void {
    this.dbCancel = null;
    this.ui = { ...this.ui, dbStatus: 'error', dbError: message, dbErrorAction: null, dbClaude: false };
    this.emit();
  }

  /** Construye el esquema (el real manda) y el guion conducido por el reproductor del flujo. */
  private presentDbMap(stored: FlowDbMapStored, conn: FlowDbConnection | null): void {
    const flow = this.flow;
    if (!flow) return;
    const { meta, accesses } = buildFlowDbSchema(stored, conn?.meta ?? null);
    const note = conn
      ? this.i18n.t('aiFlow.db.schemaReal', { db: stored.database || conn.meta.database || conn.meta.provider })
      : this.i18n.t('aiFlow.db.schemaCode');
    const { script, indexes } = buildFlowDbScript(flow, accesses, meta.tables, (k, p) => this.i18n.t(k, p), stored.summary, note);
    this.dbView = {
      map: stored,
      schema: meta,
      script,
      indexes,
      accesses: new Map(accesses.map((a) => [a.stepId, a])),
      connectionKey: conn?.key ?? '',
      schemaKey: `${flow.id}|${stored.generatedAt}|${conn?.key ?? ''}`,
    };
    const empty = !indexes.length || !meta.tables.length;
    if (this.ui.mode === 'db') this.player.setStops(empty ? null : indexes);
    this.ui = { ...this.ui, dbStatus: empty ? 'empty' : 'ready', dbError: null, dbErrorAction: null, dbClaude: false };
    this.emit();
  }

  /**
   * Conexión configurada en VS Code cuya raíz contiene el archivo de algún paso de datos; si ninguna, la primera. Su
   * metadata la lee el host en solo lectura. `null` si no hay ninguna o falla (aviso si `warn`).
   */
  private async dbConnectionFor(flow: FlowDiagram, validator: FlowRefValidator, warn = true): Promise<FlowDbConnection | null> {
    if (this.project.sample && !this.bridge.isMock) return null;
    let connections: DbConnectionInfo[];
    try {
      const list = await this.bridge.request<DbConnectionInfo[]>({ op: 'dbConnections' });
      connections = Array.isArray(list) ? list : [];
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudieron listar las conexiones de base de datos.', error instanceof Error ? error.name : '');
      return null;
    }
    const list = connections
      .filter((c) => c && typeof c.key === 'string')
      .map((c) => ({ key: c.key, root: String(c.root ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') }));
    if (!list.length) return null;
    const paths = flow.steps.filter((s) => isDbStep(flow, s) && s.ref)
      .map((s) => validator.resolveFile(s.ref!)?.path ?? null)
      .filter((p): p is string => !!p);
    const hit = list.find((c) => paths.some((p) => !c.root || p === c.root || p.startsWith(c.root + '/')));
    const chosen = hit ?? list[0];
    const cached = this.dbMetaCache.get(chosen.key);
    if (cached) return { key: chosen.key, meta: cached };
    try {
      const meta = await this.bridge.request<WorkspaceCodeDatabaseMetadata>({ op: 'dbMetadata', key: chosen.key });
      if (!meta || !Array.isArray(meta.tables)) throw new Error(this.i18n.t('aiFlow.db.failed'));
      this.dbMetaCache.set(chosen.key, meta);
      return { key: chosen.key, meta };
    } catch (error: unknown) {
      console.warn('[Nexo IA] No se pudo leer el esquema de la base de datos.', error instanceof Error ? error.name : '');
      if (warn) {
        const message = (error instanceof Error && error.message) || this.i18n.t('ai.error.generic');
        this.notify.show(this.i18n.t('aiFlow.db.schemaFailed', { message }), 'warning');
      }
      return null;
    }
  }

  /**
   * Contexto DB_MAP (`FlowDbMapContext` en base64): flujo compacto, ventanas de ±20 líneas de los pasos de datos y su
   * anterior (o su `codeSnapshot` si el archivo no se puede leer), hasta 4 entidades de los repositorios y, con una
   * conexión, un extracto del esquema real (solo nombres, tipos, PK, nullable y FK; nunca host, usuario, filas ni valores).
   */
  private async dbMapContext(flow: FlowDiagram, _force: boolean): Promise<{ contextBase64: string; conn: FlowDbConnection | null }> {
    const validator = await this.validator();
    const dbSteps = dbStepIndexes(flow).map((i) => flow.steps[i]);
    const { windows } = await this.codeWindowsWith({ ...flow, steps: dbSteps, files: [] }, new Map(), new Map(), DB_MAP_RADIUS);
    const code: CodeWindow[] = [...windows];
    for (const step of dbSteps) {
      const snapshot = step.codeSnapshot;
      if (!snapshot || !snapshot.lines.length) continue;
      const file = step.ref ? validator.resolveFile(step.ref) : null;
      if (await validator.linesOf(file)) continue;
      code.push({
        path: snapshot.file, startLine: snapshot.startLine, endLine: snapshot.startLine + snapshot.lines.length - 1, content: snapshot.lines.join('\n'),
      });
    }

    const texts = code.map((w) => w.content);
    const entities = repositoryEntities(texts);
    const entityTexts: string[] = [];
    for (const entity of entities.slice(0, DB_MAX_ENTITY_FILES)) {
      const file = this.project.project.files.find((f) => f.name === `${entity}.java` || f.name === `${entity}.kt`) ?? null;
      const lines = await validator.linesOf(file);
      if (!file || !lines) continue;
      const content = lines.slice(0, DB_ENTITY_LINES).join('\n').slice(0, DB_ENTITY_CHARS);
      entityTexts.push(content);
      code.push({ path: file.path, startLine: 1, endLine: Math.min(DB_ENTITY_LINES, lines.length), content });
    }

    const conn = await this.dbConnectionFor(flow, validator);
    const schema = conn ? this.dbSchemaExtract(conn.meta, candidateTableNames([...texts, ...entityTexts], entities)) : null;
    const context: FlowDbMapContext = {
      flowId: flow.id,
      flow: {
        id: flow.id,
        title: flow.title,
        lanes: flow.lanes.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
        steps: flow.steps.map((s) => ({
          id: s.id, from: s.from, to: s.to, label: s.label, title: s.title, kind: s.kind,
          ref: s.ref ? { file: s.ref.file, line: s.ref.line, className: s.ref.className, functionName: s.ref.functionName } : null,
        })),
      },
      code: [],
      schema,
    };
    return { contextBase64: this.encode({ ...context, code }), conn };
  }

  /** Extracto del esquema real: tablas candidatas y sus vecinas a un salto por FK (≤ 12, ≤ 30 columnas, PK y FK primero). */
  private dbSchemaExtract(meta: WorkspaceCodeDatabaseMetadata, candidates: Set<string>): NonNullable<FlowDbMapContext['schema']> {
    const byName = new Map(meta.tables.map((t) => [t.name, t]));
    const picked: WorkspaceCodeDbTable[] = [];
    const add = (table: WorkspaceCodeDbTable | undefined) => {
      if (table && picked.length < DB_SCHEMA_MAX_TABLES && !picked.includes(table)) picked.push(table);
    };
    const direct = meta.tables.filter((t) => candidates.has(t.name.toLowerCase()));
    direct.forEach(add);
    for (const table of direct) {
      table.foreignKeys.forEach((fk) => add(byName.get(fk.refTable)));
      table.referencedBy.forEach((ref) => add(byName.get(ref.table)));
    }
    const tables = picked.map((t) => {
      const fkColumns = new Set(t.foreignKeys.flatMap((fk) => fk.columns));
      const rank = (c: WorkspaceCodeDbTable['columns'][number]) => (c.primaryKey ? 0 : fkColumns.has(c.name) ? 1 : 2);
      const columns = [...t.columns].sort((a, b) => rank(a) - rank(b) || a.position - b.position).slice(0, DB_SCHEMA_MAX_COLUMNS);
      return {
        name: t.name,
        columns: columns.map((c) => ({ name: c.name, type: shortType(c), pk: c.primaryKey, nullable: c.nullable })),
        fks: t.foreignKeys.map((fk) => ({ columns: fk.columns, refTable: fk.refTable, refColumns: fk.refColumns })),
      };
    });
    const otherTables = meta.tables.filter((t) => !picked.includes(t)).map((t) => t.name).slice(0, DB_SCHEMA_OTHER_TABLES);
    return { provider: meta.provider, tables, otherTables };
  }

  /** «Preguntar a la IA» del menú de un paso: el host lo envía al chat de VS Code. */
  askAboutStep(index: number): void {
    const step = this.flow?.steps[index];
    if (!step) return;
    const ref = step.ref && step.ref.verification !== 'unverified' ? step.ref : null;
    const n = index + 1;
    const text = ref
      ? this.i18n.t('aiFlow.stepMenu.askPrompt', { n, title: step.title, className: ref.className, functionName: ref.functionName, file: ref.file, line: ref.line })
      : this.i18n.t('aiFlow.stepMenu.askPromptNoRef', { n, title: step.title });
    this.bridge.post({ type: 'ask', text: text.slice(0, 4000) });
  }

  /** «Copiar referencia»: `Clase.función · archivo:línea` (o `n. título` si el paso no tiene referencia). */
  stepReference(index: number): string {
    const step = this.flow?.steps[index];
    if (!step) return '';
    const ref = step.ref;
    if (!ref) return `${index + 1}. ${step.title}`;
    const sym = isDecoratorFunctionName(ref.functionName) ? `${ref.className} ${ref.functionName}` : `${ref.className}.${ref.functionName}`;
    return `${sym} · ${ref.file}:${ref.line}`;
  }

  failIndex(): number {
    return this.failIndexOf(this.result);
  }

  private failIndexOf(r: FlowDiagnosis | null): number {
    if (!r || !this.flow || !r.failStepId || (r.kind !== 'error' && r.kind !== 'stop')) return -1;
    return this.flow.steps.findIndex((s) => s.id === r.failStepId);
  }

  rowState(i: number): FlowRowState {
    const step = this.player.step;
    const fail = this.failIndex();
    const r = this.result;
    if (r && fail >= 0 && step >= fail) {
      if (i === fail) return r.kind === 'stop' ? 'stop' : 'fail';
      if (i > fail) return i === step ? 'current' : 'skipped';
    }
    if (r && (this.ui.mode === 'sim' || this.ui.mode === 'changes') && (r as SimulationResult).skippedStepIds?.includes(this.flow?.steps[i]?.id ?? '') && this.player.resultVisible && i !== step) return 'skipped';
    if (i < step) return 'done';
    if (i === step) return 'current';
    return 'pending';
  }

  /** «● en logs»: el paso aparece en los logs analizados. */
  inLogs(i: number): boolean {
    if (this.ui.mode !== 'logs' || !this.ui.logsResult) return false;
    const id = this.flow?.steps[i]?.id;
    return !!id && this.ui.logsResult.seenStepIds.includes(id);
  }

  segmentState(i: number): FlowRowState {
    return this.rowState(i);
  }

  statusPill(): FlowStatusPill {
    const pill = this.basePill();
    if (this.ui.mode === 'changes' && this.currentCase) return { ...pill, prefix: `aiFlow.pill.prefix.${this.ui.changeSide}` };
    return pill;
  }

  private basePill(): FlowStatusPill {
    const total = this.flow?.steps.length ?? 0;
    const r = this.result;
    const fail = this.failIndex();
    if (r && fail >= 0 && this.player.step >= fail) {
      return r.kind === 'stop'
        ? { tone: 'warning', key: 'aiFlow.pill.stop', params: { n: fail + 1 } }
        : { tone: 'danger', key: 'aiFlow.pill.fail', params: { n: fail + 1 } };
    }
    if (r && r.kind === 'ok' && this.ui.resultVisible) return { tone: 'success', key: 'aiFlow.pill.ok', params: { n: total, total } };
    if (this.player.stops) return { tone: 'accent', key: 'aiFlow.pill.step', params: { x: this.player.position + 1, n: this.player.count } };
    return { tone: 'accent', key: 'aiFlow.pill.step', params: { x: Math.min(total, this.player.step + 1), n: total } };
  }

  /** Resaltado de carril del paso actual (rojo/ámbar si es el paso que falla). */
  laneHighlight(laneId: string): 'accent' | 'danger' | 'warning' | null {
    const current = this.flow?.steps[this.player.step];
    if (!current || (current.from !== laneId && current.to !== laneId)) return null;
    const state = this.rowState(this.player.step);
    return state === 'fail' ? 'danger' : state === 'stop' ? 'warning' : 'accent';
  }

  /* ---------------------------- utilidades ---------------------------- */

  private syncPlayer(): void {
    this.ui = { ...this.ui, step: this.player.step, playing: this.player.playing, speed: this.player.speed };
    this.emit();
  }

  private json(value: unknown): string {
    try {
      return JSON.stringify(value ?? {}, null, 2) ?? '{}';
    } catch (error: unknown) {
      console.warn('[Nexo IA] Datos de ejemplo no serializables.', error instanceof Error ? error.name : '');
      return '{}';
    }
  }

  private emit(): void {
    this.changed$.next();
  }
}
