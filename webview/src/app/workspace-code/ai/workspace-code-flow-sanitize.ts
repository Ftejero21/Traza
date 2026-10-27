import {
  CodeRef,
  CodeSnippet,
  Confidence,
  FlowDiagnosis,
  FlowCodeSnapshot,
  FlowDbAccess,
  FlowDbColumn,
  FlowDbMap,
  FlowDbMapStored,
  FlowDbOp,
  FlowDbRelation,
  FlowDbTable,
  FlowDiagram,
  FlowErrorExit,
  FlowLane,
  FlowLaneKind,
  FlowScenario,
  FlowStep,
  FlowStepKind,
  FlowStepUiKind,
  LogAnalysisResult,
  LogEvidence,
  LogTone,
  ResultKind,
  SimulationPreset,
  SimulationResult,
  UiPreviewPlan,
  UiPreviewState,
} from './nexo-ia.types';

/**
 * Saneado defensivo de lo que devuelve la IA (el backend ya lo valida contra el esquema). Los datos de la IA no son
 * confiables: se truncan los textos a los límites del esquema, se descartan elementos inválidos y los ids de carriles
 * y pasos deben existir. Solo se renderiza por interpolación.
 */

const LANE_KINDS: readonly FlowLaneKind[] = ['ui', 'component', 'service', 'api', 'db', 'queue', 'external', 'other'];
const STEP_KINDS: readonly FlowStepKind[] = ['code', 'sql', 'http', 'event', 'generated'];
const UI_KINDS: readonly FlowStepUiKind[] = ['screen', 'toast', 'list', 'warning', 'modal', 'error', 'message'];
const RESULT_KINDS: readonly ResultKind[] = ['error', 'stop', 'ok', 'none'];
const CONFIDENCE: readonly Confidence[] = ['alta', 'media', 'baja'];
const TONES: readonly LogTone[] = ['info', 'error', 'trace'];
const VERIFICATIONS: readonly NonNullable<CodeRef['verification']>[] = ['exact', 'corrected', 'unverified'];
/** Límites de `FlowStep.codeSnapshot`. */
export const SNAPSHOT_MAX_LINES = 8;
export const SNAPSHOT_MAX_LINE_CHARS = 400;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

function int(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null;
}

function oneOf<T extends string>(value: unknown, list: readonly T[]): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * `keepLocal`: conserva `verification` (solo para flujos ya validados por el frontend, p. ej. del historial). Lo que
 * llega de la IA nunca la trae.
 */
export function sanitizeCodeRef(raw: unknown, keepLocal = false): CodeRef | null {
  const o = obj(raw);
  if (!o) return null;
  const file = str(o['file'], 600).trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  const line = int(o['line'], 1);
  const anchor = str(o['anchor'], 240).trim();
  const className = str(o['className'], 200).trim();
  const functionName = str(o['functionName'], 200).trim().replace(/\(.*$/, '');
  if (!file || line === null || !anchor || !className || !functionName) return null;
  const ref: CodeRef = { mountId: str(o['mountId'], 200), file, line, anchor, className, functionName };
  const verification = keepLocal ? oneOf(o['verification'], VERIFICATIONS) : null;
  if (verification) ref.verification = verification;
  return ref;
}

/** `codeSnapshot` guardado de un paso: `null` si su forma no es válida (tipos y límites). */
export function sanitizeCodeSnapshot(raw: unknown): FlowCodeSnapshot | null {
  const o = obj(raw);
  if (!o) return null;
  const file = o['file'];
  const language = o['language'];
  const lines = o['lines'];
  const startLine = int(o['startLine'], 1);
  const highlightLine = int(o['highlightLine'], 1);
  if (typeof file !== 'string' || !file || file.length > 600 || typeof language !== 'string' || language.length > 40) return null;
  if (startLine === null || highlightLine === null || !Array.isArray(lines) || !lines.length || lines.length > SNAPSHOT_MAX_LINES) return null;
  if (!lines.every((l) => typeof l === 'string' && l.length <= SNAPSHOT_MAX_LINE_CHARS)) return null;
  return { file, startLine, lines: [...lines] as string[], highlightLine, language };
}

function sanitizeSnippet(raw: unknown, keepLocal = false): CodeSnippet | null {
  const o = obj(raw);
  if (!o) return null;
  const ref = sanitizeCodeRef(o['ref'], keepLocal);
  if (!ref) return null;
  const startLine = int(o['startLine'], 1) ?? Math.max(1, ref.line - 2);
  const length = Math.min(12, Math.max(1, int(o['length'], 1) ?? 5));
  const highlightLine = int(o['highlightLine'], 1) ?? ref.line;
  return { ref, startLine, length, highlightLine, language: str(o['language'], 40) };
}

function sanitizeLane(raw: unknown): FlowLane | null {
  const o = obj(raw);
  const id = o ? str(o['id'], 80).trim() : '';
  if (!o || !id) return null;
  const name = str(o['name'], 24).trim() || id.slice(0, 24);
  return {
    id,
    name,
    short: str(o['short'], 12).trim() || name.slice(0, 12),
    sub: str(o['sub'], 20).trim(),
    kind: oneOf(o['kind'], LANE_KINDS) ?? 'other',
  };
}

function sanitizeStep(raw: unknown, lanes: Set<string>, keepLocal: boolean): FlowStep | null {
  const o = obj(raw);
  const id = o ? str(o['id'], 80).trim() : '';
  if (!o || !id) return null;
  const from = str(o['from'], 80).trim();
  const to = str(o['to'], 80).trim();
  if (!lanes.has(from) || !lanes.has(to)) return null;
  const step: FlowStep = {
    id,
    from,
    to,
    label: str(o['label'], 48),
    title: str(o['title'], 70).trim() || str(o['label'], 48),
    explanation: str(o['explanation'], 420),
    kind: oneOf(o['kind'], STEP_KINDS) ?? 'code',
    ref: sanitizeCodeRef(o['ref'], keepLocal),
    snippet: sanitizeSnippet(o['snippet'], keepLocal),
  };
  const ui = obj(o['ui']);
  const uiKind = ui ? oneOf(ui['kind'], UI_KINDS) : null;
  const uiWhat = ui ? str(ui['what'], 120).trim() : '';
  if (ui && uiKind && uiWhat) step.ui = { kind: uiKind, what: uiWhat, ...(ui['focus'] === true ? { focus: true } : {}) };
  const generated = obj(o['generatedCode']);
  if (generated && typeof generated['code'] === 'string') {
    step.generatedCode = {
      title: str(generated['title'], 120),
      language: str(generated['language'], 40),
      code: str(generated['code'], 1200),
      highlightIndex: int(generated['highlightIndex'], 0) ?? 0,
    };
  }
  if (keepLocal) {
    const snapshot = sanitizeCodeSnapshot(o['codeSnapshot']);
    if (snapshot) step.codeSnapshot = snapshot;
  }
  return step;
}

/**
 * `null` si tras descartar lo inválido quedan menos de 2 pasos. `keepLocal`: conserva los datos que solo pone el
 * frontend (`verification` y `codeSnapshot`), para flujos ya validados que vuelven del historial.
 */
export function sanitizeFlowDiagram(raw: unknown, keepLocal = false): FlowDiagram | null {
  const o = obj(raw);
  if (!o) return null;
  const allLanes: FlowLane[] = [];
  const laneIds = new Set<string>();
  for (const item of arr(o['lanes'])) {
    const lane = sanitizeLane(item);
    if (lane && !laneIds.has(lane.id)) {
      laneIds.add(lane.id);
      allLanes.push(lane);
    }
  }
  const steps: FlowStep[] = [];
  const stepIds = new Set<string>();
  for (const item of arr(o['steps'])) {
    if (steps.length >= 20) break;
    const step = sanitizeStep(item, laneIds, keepLocal);
    if (step && !stepIds.has(step.id)) {
      stepIds.add(step.id);
      steps.push(step);
    }
  }
  if (steps.length < 2) return null;
  // Carriles sin pasos: se descartan.
  const used = new Set(steps.flatMap((s) => [s.from, s.to]));
  const lanes = allLanes.filter((lane) => used.has(lane.id)).slice(0, 7);
  const kept = new Set(lanes.map((l) => l.id));
  const finalSteps = steps.filter((s) => kept.has(s.from) && kept.has(s.to));
  if (finalSteps.length < 2) return null;
  const finalIds = new Set(finalSteps.map((s) => s.id));

  const errorExits: FlowErrorExit[] = [];
  for (const item of arr(o['errorExits'])) {
    const e = obj(item);
    const stepId = e ? str(e['stepId'], 80) : '';
    if (!e || !finalIds.has(stepId)) continue;
    const exit: FlowErrorExit = { stepId, condition: str(e['condition'], 300) };
    const status = int(e['httpStatus'], 100);
    if (status !== null) exit.httpStatus = status;
    errorExits.push(exit);
  }

  const presets: SimulationPreset[] = [];
  const presetIds = new Set<string>();
  for (const item of arr(o['simulationPresets'])) {
    if (presets.length >= 8) break;
    const p = obj(item);
    const id = p ? str(p['id'], 80).trim() : '';
    if (!p || !id || presetIds.has(id) || !('input' in p)) continue;
    presetIds.add(id);
    const expected = obj(p['expected']);
    const failStepId = expected && typeof expected['failStepId'] === 'string' && finalIds.has(expected['failStepId']) ? expected['failStepId'] : null;
    const kind = (expected && oneOf(expected['kind'], RESULT_KINDS)) ?? 'none';
    const preset: SimulationPreset = {
      id,
      label: str(p['label'], 28).trim() || id.slice(0, 28),
      input: p['input'],
      expected: { kind, failStepId: kind === 'ok' || kind === 'none' ? null : failStepId },
    };
    const status = expected ? int(expected['httpStatus'], 100) : null;
    if (status !== null) preset.expected.httpStatus = status;
    presets.push(preset);
  }

  const files = arr(o['files']).map((r) => sanitizeCodeRef(r, keepLocal)).filter((r): r is CodeRef => !!r).slice(0, 40);

  const diagram: FlowDiagram = {
    id: str(o['id'], 80) || `flow-${Date.now().toString(36)}`,
    title: str(o['title'], 60).trim() || finalSteps[0].title,
    question: str(o['question'], 4000),
    summary: str(o['summary'], 600),
    errorSummary: str(o['errorSummary'], 500),
    lanes,
    steps: finalSteps,
    errorExits,
    inputExample: 'inputExample' in o ? o['inputExample'] : {},
    simulationPresets: presets,
    files,
    model: str(o['model'], 120),
    generatedAt: str(o['generatedAt'], 40),
  };
  const scenario = sanitizeScenario(o['scenario'], diagram);
  if (scenario) diagram.scenario = scenario;
  if (keepLocal && o['dbMap'] !== undefined) {
    const dbMap = sanitizeStoredFlowDbMap(o['dbMap'], diagram);
    if (dbMap) diagram.dbMap = dbMap;
  }
  return diagram;
}

/** Escenario ya simulado por el FLOW; `null` (se descarta en silencio) si algo no es válido. */
function sanitizeScenario(raw: unknown, flow: FlowDiagram): FlowScenario | null {
  const s = obj(raw);
  if (!s) return null;
  const label = str(s['label'], 28).trim();
  if (!label) return null;
  const input = s['input'];
  if (input === undefined) return null;
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined || serialized.length > 4000) return null;
  } catch {
    // Entrada no serializable (ciclos, BigInt…): se descarta el escenario.
    return null;
  }
  const result = sanitizeDiagnosis(s['result'], flow, 'sim');
  if (!result || result.kind === 'none') return null;
  return { label, input, result };
}

const UI_STATES: readonly UiPreviewState[] = ['blocked', 'silent', 'message', 'success'];

/** Texto obligatorio dentro de [min, max] caracteres; `null` si no cumple. */
function boundedText(value: unknown, max: number, noTags = false): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  if (noTags && text.includes('<')) return null;
  return text;
}

/** Valor JSON plano (primitivos, null, arrays ≤ `maxItems`, objetos planos); `undefined` si no es válido. */
function plainJson(value: unknown, depth = 0, maxItems = 5): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth > 4) return undefined;
  if (Array.isArray(value)) {
    if (value.length > maxItems) return undefined;
    const out: unknown[] = [];
    for (const item of value) {
      const clean = plainJson(item, depth + 1, maxItems);
      if (clean === undefined) return undefined;
      out.push(clean);
    }
    return out;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const clean = plainJson(v, depth + 1, maxItems);
      if (clean === undefined) return undefined;
      out[k] = clean;
    }
    return out;
  }
  return undefined;
}

const UI_COMPONENT_NAME = /^[a-zA-Z][\w-]*$/;
const UI_BINDINGS_MAX_KEYS = 40;
const UI_BINDING_MAX_CHARS = 600;
const UI_BINDINGS_MAX_TOTAL = 4000;

/** Mapa de valores JSON planos (arrays ≤ 12, profundidad ≤ 4, cada valor ≤ 600, total ≤ 4000). */
function uiValueMap(raw: unknown, maxKeys: number): Record<string, unknown> | null {
  if (raw === undefined || raw === null) return {};
  const o = obj(raw);
  if (!o) return null;
  const entries = Object.entries(o);
  if (entries.length > maxKeys) return null;
  const out: Record<string, unknown> = {};
  let total = 0;
  for (const [key, value] of entries) {
    if (!key || key.length > 160) return null;
    const clean = plainJson(value, 0, 12);
    if (clean === undefined) return null;
    const serialized = JSON.stringify(clean);
    if (serialized === undefined || serialized.length > UI_BINDING_MAX_CHARS) return null;
    total += serialized.length + key.length;
    if (total > UI_BINDINGS_MAX_TOTAL) return null;
    out[key] = clean;
  }
  return out;
}

function sanitizePlanBody(o: Obj): Omit<UiPreviewPlan, 'after'> | null {
  const root = boundedText(o['root'], 120, true);
  const state = oneOf(o['state'], UI_STATES);
  const caption = boundedText(o['caption'], 140, true);
  const markObj = obj(o['mark']);
  const markSelector = markObj ? boundedText(markObj['selector'], 120, true) : null;
  const markLabel = markObj ? boundedText(markObj['label'], 40, true) : null;
  if (!root || !state || !caption || !markSelector || !markLabel) return null;
  const bindings = uiValueMap(o['bindings'], UI_BINDINGS_MAX_KEYS);
  if (!bindings) return null;
  const body: Omit<UiPreviewPlan, 'after'> = { root, state, bindings, mark: { selector: markSelector, label: markLabel }, caption };
  if (o['inject'] !== undefined && o['inject'] !== null) {
    const inj = obj(o['inject']);
    if (!inj) return null;
    const after = boundedText(inj['after'], 120, true);
    const component = boundedText(inj['component'], 80, true);
    if (!after || !component || !UI_COMPONENT_NAME.test(component)) return null;
    const inputs = uiValueMap(inj['inputs'], 20);
    if (!inputs) return null;
    body.inject = { after, component };
    if (Object.keys(inputs).length) body.inject.inputs = inputs;
  }
  return body;
}

/**
 * `UiPreviewPlan` devuelto por la IA (nunca HTML/CSS). Estricto: `null` si algo no es válido. Los textos no pueden
 * contener `<`; los valores de `bindings` solo se usan como texto al pintar.
 */
export function sanitizeUiPreviewPlan(raw: unknown): UiPreviewPlan | null {
  const o = obj(raw);
  if (!o) return null;
  const body = sanitizePlanBody(o);
  if (!body) return null;
  const plan: UiPreviewPlan = { ...body };
  if (o['after'] !== undefined && o['after'] !== null) {
    const a = obj(o['after']);
    if (!a) return null;
    const after = sanitizePlanBody(a);
    if (!after) return null;
    plan.after = after;
  }
  return plan;
}

function sanitizeBase(o: Obj, stepIds: Set<string>): FlowDiagnosis {
  const kind = oneOf(o['kind'], RESULT_KINDS) ?? 'none';
  let failStepId = typeof o['failStepId'] === 'string' && stepIds.has(o['failStepId']) ? o['failStepId'] : null;
  // El paso que falla solo se conserva si es un paso del flujo; ok/none nunca llevan paso. El `kind` no se degrada.
  if (kind === 'ok' || kind === 'none') failStepId = null;
  const d: FlowDiagnosis = {
    kind,
    failStepId,
    badge: str(o['badge'], 24),
    title: str(o['title'], 90),
    where: sanitizeCodeRef(o['where']),
    conclusion: str(o['conclusion'], 900),
    userImpact: str(o['userImpact'], 400),
    fix: str(o['fix'], 600),
    snippet: sanitizeSnippet(o['snippet']),
    confidence: oneOf(o['confidence'], CONFIDENCE) ?? 'baja',
    confidenceReason: str(o['confidenceReason'], 160),
  };
  const status = int(o['httpStatus'], 100);
  if (status !== null) d.httpStatus = status;
  const field = str(o['field'], 80);
  if (field) d.field = field;
  return d;
}

function ids(value: unknown, stepIds: Set<string>): string[] {
  return [...new Set(arr(value).filter((v): v is string => typeof v === 'string' && stepIds.has(v)))];
}

function sanitizeEvidence(raw: unknown, stepIds: Set<string>): LogEvidence | null {
  const o = obj(raw);
  const index = o ? int(o['index'], 0) : null;
  if (!o || index === null) return null;
  const e: LogEvidence = {
    index,
    text: str(o['text'], 2000),
    stepId: typeof o['stepId'] === 'string' && stepIds.has(o['stepId']) ? o['stepId'] : null,
    tone: oneOf(o['tone'], TONES) ?? 'info',
  };
  const status = int(o['httpStatus'], 100);
  if (status !== null) e.httpStatus = status;
  return e;
}

export function sanitizeDiagnosis(raw: unknown, flow: FlowDiagram, kind: 'sim'): SimulationResult | null;
export function sanitizeDiagnosis(raw: unknown, flow: FlowDiagram, kind: 'logs'): LogAnalysisResult | null;
export function sanitizeDiagnosis(raw: unknown, flow: FlowDiagram, kind: 'sim' | 'logs'): SimulationResult | LogAnalysisResult | null {
  const o = obj(raw);
  if (!o) return null;
  const stepIds = new Set(flow.steps.map((s) => s.id));
  const base = sanitizeBase(o, stepIds);
  if (kind === 'sim') {
    return { ...base, executedStepIds: ids(o['executedStepIds'], stepIds), skippedStepIds: ids(o['skippedStepIds'], stepIds) };
  }
  const evidence = arr(o['evidence']).map((e) => sanitizeEvidence(e, stepIds)).filter((e): e is LogEvidence => !!e).slice(0, 400);
  return { ...base, evidence, seenStepIds: ids(o['seenStepIds'], stepIds) };
}

/* ============================================================
 *  Mapa de datos del flujo (DB_MAP)
 * ============================================================ */

const DB_OPS: readonly FlowDbOp[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UPSERT'];
const DB_DIRECTIONS: readonly FlowDbAccess['direction'][] = ['toDb', 'fromDb'];
const DB_MAX_TABLES = 8;
const DB_MAX_COLUMNS = 24;
const DB_MAX_RELATIONS = 12;
const DB_MAX_ACCESSES = 20;
const DB_MAX_ACCESS_COLUMNS = 16;
const DB_MAX_VALUES = 16;
const DB_MAX_VALUE_CHARS = 40;
const DB_MAX_ERRORS = 20;

/** Texto opcional truncado; vacío si contiene `<`. */
function plainText(value: unknown, max: number): string {
  const text = str(value, max).trim();
  return text.includes('<') ? '' : text;
}

function dbName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 64 ? text : '';
}

/** Nombre de columna sin mayúsculas ni separadores (fechaCreacion ≡ fecha_creacion). */
function dbNorm(value: string): string {
  return value.replace(/[_\-\s]/g, '').toLowerCase();
}

/**
 * `FlowDbMap` saneado (respuesta de la IA, nunca confiable): trunca a los límites del esquema y descarta tablas sin
 * columnas, relaciones con tablas o columnas desconocidas, accesos con un paso inexistente, tabla desconocida o paso
 * repetido, y columnas o valores no declarados en la tabla. `null` si no es un objeto.
 */
export function sanitizeFlowDbMap(raw: unknown, flow: FlowDiagram): FlowDbMap | null {
  const o = obj(raw);
  if (!o) return null;
  const tables: FlowDbTable[] = [];
  const columnsOf = new Map<string, Set<string>>();
  const tableOf = new Map<string, FlowDbTable>();
  for (const item of arr(o['tables'])) {
    if (tables.length >= DB_MAX_TABLES) break;
    const t = obj(item);
    const name = t ? dbName(t['name']) : '';
    if (!t || !name || columnsOf.has(name)) continue;
    const columns: FlowDbColumn[] = [];
    const seen = new Set<string>();
    for (const c of arr(t['columns'])) {
      if (columns.length >= DB_MAX_COLUMNS) break;
      const co = obj(c);
      const cname = co ? dbName(co['name']) : '';
      if (!co || !cname || seen.has(cname)) continue;
      seen.add(cname);
      const column: FlowDbColumn = { name: cname, type: str(co['type'], 32).trim(), pk: co['pk'] === true };
      if (typeof co['nullable'] === 'boolean') column.nullable = co['nullable'];
      columns.push(column);
    }
    if (!columns.length) continue;
    columnsOf.set(name, seen);
    const entity = str(t['entity'], 80).trim();
    const table: FlowDbTable = { name, entity: entity || null, columns };
    tables.push(table);
    tableOf.set(name, table);
  }

  /**
   * Resuelve una columna citada por un acceso contra la tabla (sin distinguir mayúsculas ni `_`); si no existe y la tabla
   * tiene sitio, la añade (la IA a veces cita columnas que no declara en `tables`). `null` si no cabe.
   */
  const resolveColumn = (tableName: string, raw: unknown): string | null => {
    const table = tableOf.get(tableName);
    const cols = columnsOf.get(tableName);
    const name = dbName(raw);
    if (!table || !cols || !name) return null;
    if (cols.has(name)) return name;
    const key = dbNorm(name);
    const found = table.columns.find((c) => dbNorm(c.name) === key);
    if (found) return found.name;
    if (!key || table.columns.length >= DB_MAX_COLUMNS) return null;
    table.columns.push({ name, type: '', pk: false });
    cols.add(name);
    return name;
  };

  const relations: FlowDbRelation[] = [];
  for (const item of arr(o['relations'])) {
    if (relations.length >= DB_MAX_RELATIONS) break;
    const r = obj(item);
    if (!r) continue;
    const from = dbName(r['from']);
    const to = dbName(r['to']);
    const fromColumn = dbName(r['fromColumn']);
    const toColumn = dbName(r['toColumn']);
    if (!columnsOf.get(from)?.has(fromColumn) || !columnsOf.get(to)?.has(toColumn)) continue;
    relations.push({ from, fromColumn, to, toColumn });
  }

  const stepIds = new Set(flow.steps.map((s) => s.id));
  const accesses: FlowDbAccess[] = [];
  const usedSteps = new Set<string>();
  for (const item of arr(o['accesses'])) {
    if (accesses.length >= DB_MAX_ACCESSES) break;
    const a = obj(item);
    if (!a) continue;
    const stepId = str(a['stepId'], 80).trim();
    const table = dbName(a['table']);
    const op = oneOf(a['op'], DB_OPS);
    const direction = oneOf(a['direction'], DB_DIRECTIONS);
    const cols = columnsOf.get(table);
    if (!stepIds.has(stepId) || usedSteps.has(stepId) || !cols || !op || !direction) continue;
    usedSteps.add(stepId);
    const columns = [...new Set(arr(a['columns']).map((c) => resolveColumn(table, c)).filter((c): c is string => !!c))]
      .slice(0, DB_MAX_ACCESS_COLUMNS);
    const access: FlowDbAccess = { stepId, table, op, direction, columns, fn: plainText(a['fn'], 80) };
    const values = obj(a['values']);
    if (values) {
      const out: Record<string, string> = {};
      let n = 0;
      for (const [key, value] of Object.entries(values)) {
        if (n >= DB_MAX_VALUES) break;
        if (typeof value !== 'string' || value.includes('<')) continue;
        const column = resolveColumn(table, key);
        if (!column || column in out) continue;
        out[column] = value.length > DB_MAX_VALUE_CHARS ? value.slice(0, DB_MAX_VALUE_CHARS) : value;
        n++;
      }
      if (n) access.values = out;
    }
    const via = dbName(a['via']);
    if (via && columnsOf.has(via)) access.via = via;
    const note = plainText(a['note'], 160);
    if (note) access.note = note;
    accesses.push(access);
  }
  return { summary: plainText(o['summary'], 240), tables, relations, accesses };
}

/**
 * Validación ESTRICTA de un `FlowDbMap` (resultado de Claude): límites del esquema y reglas semánticas del contrato. Lista
 * de errores (≤ 20); vacía si es válido. Con errores el resultado se rechaza (`INVALID_SCHEMA`) para que Claude reintente.
 */
export function flowDbMapErrors(raw: unknown, flow: FlowDiagram): string[] {
  const errors: string[] = [];
  const add = (message: string) => { if (errors.length < DB_MAX_ERRORS) errors.push(message); };
  const o = obj(raw);
  if (!o) return ['map: debe ser un objeto'];
  const text = (value: unknown, path: string, min: number, max: number, noTags = false): string => {
    if (typeof value !== 'string') {
      add(`${path}: debe ser texto`);
      return '';
    }
    if (value.length < min || value.length > max) add(`${path}: longitud ${min}-${max}`);
    if (noTags && value.includes('<')) add(`${path}: no puede contener '<'`);
    return value;
  };
  const list = (value: unknown, path: string, max: number): unknown[] => {
    if (!Array.isArray(value)) {
      add(`${path}: debe ser una lista`);
      return [];
    }
    if (value.length > max) add(`${path}: como mucho ${max} elementos`);
    return value;
  };
  const only = (o2: Obj, path: string, keys: string[]) => {
    for (const key of Object.keys(o2)) if (!keys.includes(key)) add(`${path}.${key}: propiedad no permitida`);
  };
  only(o, 'map', ['summary', 'tables', 'relations', 'accesses']);
  text(o['summary'], 'summary', 0, 240, true);

  const tableNames = new Set<string>();
  list(o['tables'], 'tables', DB_MAX_TABLES).forEach((item, i) => {
    const t = obj(item);
    const path = `tables[${i}]`;
    if (!t) {
      add(`${path}: debe ser un objeto`);
      return;
    }
    only(t, path, ['name', 'entity', 'columns']);
    const name = text(t['name'], `${path}.name`, 1, 64);
    if (name) tableNames.add(name);
    if (t['entity'] !== undefined && t['entity'] !== null) text(t['entity'], `${path}.entity`, 0, 80);
    const columns = list(t['columns'], `${path}.columns`, DB_MAX_COLUMNS);
    if (Array.isArray(t['columns']) && !columns.length) add(`${path}.columns: al menos 1 columna`);
    columns.forEach((c, j) => {
      const co = obj(c);
      const cpath = `${path}.columns[${j}]`;
      if (!co) {
        add(`${cpath}: debe ser un objeto`);
        return;
      }
      only(co, cpath, ['name', 'type', 'pk', 'nullable']);
      text(co['name'], `${cpath}.name`, 1, 64);
      text(co['type'], `${cpath}.type`, 0, 32);
      if (typeof co['pk'] !== 'boolean') add(`${cpath}.pk: debe ser booleano`);
      if (co['nullable'] !== undefined && typeof co['nullable'] !== 'boolean') add(`${cpath}.nullable: debe ser booleano`);
    });
  });

  list(o['relations'], 'relations', DB_MAX_RELATIONS).forEach((item, i) => {
    const r = obj(item);
    const path = `relations[${i}]`;
    if (!r) {
      add(`${path}: debe ser un objeto`);
      return;
    }
    only(r, path, ['from', 'fromColumn', 'to', 'toColumn']);
    for (const key of ['from', 'fromColumn', 'to', 'toColumn']) text(r[key], `${path}.${key}`, 1, 64);
    for (const key of ['from', 'to']) {
      const value = r[key];
      if (typeof value === 'string' && !tableNames.has(value)) add(`${path}.${key}: tabla no declarada en tables`);
    }
  });

  const stepIds = new Set(flow.steps.map((s) => s.id));
  const usedSteps = new Set<string>();
  list(o['accesses'], 'accesses', DB_MAX_ACCESSES).forEach((item, i) => {
    const a = obj(item);
    const path = `accesses[${i}]`;
    if (!a) {
      add(`${path}: debe ser un objeto`);
      return;
    }
    only(a, path, ['stepId', 'table', 'op', 'direction', 'columns', 'values', 'via', 'fn', 'note']);
    const stepId = text(a['stepId'], `${path}.stepId`, 1, 80);
    if (stepId && !stepIds.has(stepId)) add(`${path}.stepId: no existe en flow.steps`);
    if (stepId && usedSteps.has(stepId)) add(`${path}.stepId: más de un acceso para el mismo paso`);
    if (stepId) usedSteps.add(stepId);
    const table = text(a['table'], `${path}.table`, 1, 64);
    if (table && !tableNames.has(table)) add(`${path}.table: tabla no declarada en tables`);
    if (!oneOf(a['op'], DB_OPS)) add(`${path}.op: SELECT | INSERT | UPDATE | DELETE | UPSERT`);
    if (!oneOf(a['direction'], DB_DIRECTIONS)) add(`${path}.direction: toDb | fromDb`);
    list(a['columns'], `${path}.columns`, DB_MAX_ACCESS_COLUMNS).forEach((c, j) => text(c, `${path}.columns[${j}]`, 1, 64));
    if (a['values'] !== undefined) {
      const values = obj(a['values']);
      if (!values) add(`${path}.values: debe ser un objeto`);
      else {
        const entries = Object.entries(values);
        if (entries.length > DB_MAX_VALUES) add(`${path}.values: como mucho ${DB_MAX_VALUES} claves`);
        for (const [key, value] of entries) text(value, `${path}.values.${key}`, 0, DB_MAX_VALUE_CHARS, true);
      }
    }
    if (a['via'] !== undefined && a['via'] !== null) {
      const via = text(a['via'], `${path}.via`, 1, 64);
      if (via && !tableNames.has(via)) add(`${path}.via: tabla no declarada en tables`);
    }
    text(a['fn'], `${path}.fn`, 0, 80, true);
    if (a['note'] !== undefined) text(a['note'], `${path}.note`, 0, 160, true);
  });
  return errors;
}

/** `FlowDbMapStored` guardado en el flujo (historial): el mapa saneado más su origen; `null` si no es válido. */
export function sanitizeStoredFlowDbMap(raw: unknown, flow: FlowDiagram): FlowDbMapStored | null {
  const o = obj(raw);
  if (!o) return null;
  const map = sanitizeFlowDbMap(o, flow);
  const source = obj(o['source']);
  // `nexo` (backend antiguo) se guarda como `lm`.
  const rawProvider = source ? oneOf(source['provider'], ['lm', 'nexo', 'claude'] as const) : null;
  const provider = rawProvider === 'nexo' ? 'lm' : rawProvider;
  const language = oneOf(o['language'], ['es', 'en'] as const);
  const schema = oneOf(o['schema'], ['real', 'code'] as const);
  if (!map || !source || !provider || !language || !schema) return null;
  const model = typeof source['model'] === 'string' ? source['model'].slice(0, 120) : null;
  const database = typeof o['database'] === 'string' ? o['database'].slice(0, 120) : null;
  return { ...map, source: { provider, model }, language, generatedAt: str(o['generatedAt'], 40), schema, database };
}
