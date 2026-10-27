/**
 * IA en el host con el modelo de lenguaje que el usuario ya tiene en VS Code (`vscode.lm`: Copilot, Claude, GPT,
 * BYOK…). Sustituye al backend de Traza: arma los prompts portados de tejechat, comprueba solo el FORMATO de la salida
 * (recorte mecánico + esquema; hasta 3 intentos conversacionales) y devuelve las mismas formas que esperan los
 * sanitizadores de la webview. Nunca juzga ni corrige el contenido de la respuesta del modelo.
 * Nunca registra código, prompts, respuestas ni preguntas: solo códigos, tamaños y tiempos.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ChangeCompareBody, FlowDiagnosisResponse, FlowKind, FlowRequestBody, NexoLanguage } from '../webview/src/app/bridge/protocol';
import { maskConfigSecrets, maskSensitiveJson, maskSensitiveText } from '../webview/src/app/workspace-code/ai/workspace-code-ai-mask';
import { afterWindows, PatchError, type ChangeFile, type CodeWindow } from './ai/change-patcher';
import { ANSWER_BUDGET_NOTE, ANSWER_CONTINUE_NOTE, ANSWER_EMPTY_NOTE, ANSWER_SYSTEM, answerNote, systemFor, type PromptOp } from './ai/prompts';
import { clampToSchema, compactSchema, validate } from './ai/schema-validator';
import {
  changeDiff, cut, cutCss, dbMapErrors, dropInvalidScenario, flowSemantics, isObj, numbered, parseModelJson, proposeSemantics,
  repairDbMap, repairDiagnosis, repairUiMock, repairUiPlan, txt, uiMockErrors, uiPlanErrors,
} from './ai/semantics';
import { AGENT_TOOLS, AgentToolSession } from './host-agent-tools';
import { collectFlowContext, type ContextFragment, type FlowContext, type FolderRole, type PinnedRef } from './host-context';
import { readMountFile } from './host-files';

type Obj = Record<string, unknown>;

let validationLog: vscode.LogOutputChannel | null = null;

/** Canal de salida «Traza» (se crea al primer uso). */
export function trazaLog(): vscode.LogOutputChannel {
  validationLog ??= vscode.window.createOutputChannel('Traza', { log: true });
  return validationLog;
}

/** Diagnóstico en el canal «Traza»: operación, modelo, tamaño de la respuesta y errores de esquema (nunca su contenido). */
function logValidation(op: PromptOp, model: vscode.LanguageModelChat, attempt: number, text: string, errors: string[]): void {
  const log = trazaLog();
  const shape = text.trimStart().startsWith('{') ? 'json' : text.includes('{') ? 'texto+json' : 'sin json';
  log.warn(`${op} · ${model.name} (${model.vendor}/${model.family}) · intento ${attempt} · ${text.length} caracteres (${shape})`);
  for (const error of errors.slice(0, 20)) log.warn(`  ${cut(error, 300)}`);
}

/** Nombre visible del modelo: «Auto · claude-fable-5.1» cuando la familia añade información al nombre. */
function modelLabel(model: vscode.LanguageModelChat): string {
  const family = model.family?.trim();
  return family && family.toLowerCase() !== model.name.trim().toLowerCase() ? `${model.name} · ${family}` : model.name;
}

/** Diagnóstico: modelos que VS Code expone a la extensión (nombre, proveedor y familia). */
function logModels(models: readonly vscode.LanguageModelChat[]): void {
  trazaLog().info(`Modelos disponibles: ${models.map((m) => `${m.name} (${m.vendor}/${m.family || '-'})`).join(', ') || 'ninguno'}`);
}

const NOTICE_KEY = 'traza.aiNoticeShown';
const CALL_TIMEOUT_MS = 180_000;
const GENERATION_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_CHARS = 300_000;
const MAX_RETRY_ASSISTANT_CHARS = 40_000;
const DEFAULT_MAX_INPUT_TOKENS = 64_000;
const TOKEN_BUDGET_RATIO = 0.8;
const CHARS_PER_TOKEN = 3;
const MAX_ANSWER_CHARS = 12_000;
/** Fase de respuesta con herramientas: rondas, llamadas, tiempo de investigación (la ronda final sin herramientas va aparte) y texto retenido antes de mostrarlo. */
const ANSWER_MAX_ROUNDS = 6;
const ANSWER_MAX_CALLS = 20;
const ANSWER_TIME_MS = 60_000;
const ANSWER_HOLD_CHARS = 400;
const ANSWER_SEED_MAX = 2;
const ANSWER_SEED_TTL_MS = 10 * 60_000;
const ANSWER_DATA_CHARS = 40_000;
const CACHE_MAX = 50;
const CACHE_TTL_MS = 15 * 60_000;
const COMPARE_CONCURRENCY = 3;
const AGENT_MAX_ROUNDS = 14;
const AGENT_MAX_CALLS = 40;
const AGENT_MAX_CALLS_PER_ROUND = 8;
const AGENT_TIME_MS = 150_000;
const AGENT_SEED_CHARS = 45_000;
const AGENT_TOOL_RESULT_CHARS = 16_000;
const AGENT_RESERVE_CHARS = 12_000;
const AGENT_MIN_RESULT_CHARS = 1500;
/** Intentos máximos por formato no legible (1 inicial + 2 correcciones), en `runJson` y en el agente. */
const MAX_FORMAT_ATTEMPTS = 3;
const AGENT_MAX_FIXES = MAX_FORMAT_ATTEMPTS - 1;
const AGENT_MAX_HINT_FILES = 12;
const AGENT_EMPTY_NOTE = 'Tu respuesta llegó vacía: usa traza_search/traza_read/traza_list o responde con el JSON final.';
const AGENT_CONTINUE_NOTE = 'Resultados de las herramientas arriba: sigue investigando con traza_search/traza_read/traza_list o responde con el JSON final.';
const AGENT_BUDGET_NOTE ='Presupuesto de investigación agotado: responde ya solo con el JSON final usando el código leído.';

const MAX_STEPS = 20;
const MAX_RECENT_FLOWS = 10;
const MAX_WINDOWS = 24;
const MAX_WINDOW_CHARS = 8000;
const MAX_INPUT_CHARS = 20_000;
const MAX_LOG_CHARS = 60_000;
const MAX_PRE_CHARS = 120_000;
const MAX_DB_SCHEMA_CHARS = 40_000;
const MAX_FLOW_JSON = 120_000;
const MAX_FLOW_ID = 200;
const MAX_PATH = 400;
const MAX_UI_INPUT_CHARS = 300_000;
const MAX_UI_PROMPT_CHARS = 240_000;
const MAX_UI_FILE = 60_000;
const MAX_UI_SHEETS = 4;
const MAX_UI_CHILDREN = 8;
const MAX_UI_CHILD_FILE = 30_000;
const MAX_UI_CHILD_SHEETS = 2;
const MAX_UI_GLOBAL_CSS = 60_000;
const MAX_UI_SIMULATION_JSON = 20_000;
const MAX_UI_CHANGE_JSON = 40_000;
const MAX_UI_NAME = 200;
const UI_PLAN_GLOBAL_CSS_AI_CHARS = 12_000;
const MAX_UI_MOCK_INPUT_CHARS = 80_000;
const MAX_UI_MOCK_SEEDS = 4;
const MAX_UI_MOCK_STEPS = 30;
const UI_MOCK_SEED_FILE_CHARS = 20_000;
const UI_MOCK_SEED_LINES = 400;
const MAX_DB_SQL_SEEDS = 8;
const DB_SQL_SEED_LINES = 300;
const DB_SQL_SEED_FILE_CHARS = 8_000;
const DB_SQL_SCHEMA_CHARS = 12_000;
const MAX_DB_SQL_INPUT_CHARS = 60_000;
const FLOW_MAX_CONTEXT_CHARS = 110_000;
const MAX_ACTIVE_FLOW_CHARS = 8000;
const MAX_QUESTION_CHARS = 4000;
const MAX_MOUNTS = 16;
const MAX_COMPARE_CASES = 7;
const MAX_CHANGE_FILES = 12;
const MAX_CHANGE_HUNKS = 40;
const MAX_CHANGE_LINES = 400;
const MAX_CHANGE_TEXT = 2000;
const MAX_CHANGE_TITLE = 70;
const MAX_CHANGE_SUMMARY = 500;
const MAX_DB_EXPLAIN_CONTEXT = 60_000;
const MAX_DB_EXPLAIN_STEPS = 8;
const MAX_FILE_READ_BYTES = 3 * 1024 * 1024;
const TRUNC = '\n…[truncado]';
/** Listas estructurales del FLOW: no se recortan (se perderían carriles o pasos); si se pasan del límite, se vuelve a preguntar. */
const FLOW_KEEP_ARRAYS: ReadonlySet<string> = new Set(['$.lanes', '$.steps']);
const PROPOSE_KEEP_ARRAYS: ReadonlySet<string> = new Set(['$.files']);
const UNAPPLIED_NOTE = '## NOTA\nEl CODIGO de esta petición es el ORIGINAL (el cambio no se pudo aplicar a las ventanas): razona el después aplicando tú el CAMBIO PROPUESTO.\n\n';
const JSON_TAIL = '\n\nResponde con un único objeto json.';
const CHANGE_STATUSES = new Set(['modified', 'added', 'deleted']);
const CHANGE_KINDS = new Set(['context', 'add', 'del']);
const DB_EXPLAIN_KINDS = new Set(['actor', 'request', 'flow', 'insert', 'fill', 'note']);
const ENDPOINT_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/[\w\-/{}.:]{0,120}$/;

const MESSAGES = {
  es: {
    noModels: 'No hay modelos de lenguaje disponibles en VS Code. Instala o inicia sesión en GitHub Copilot u otro proveedor.',
    modelMissing: 'El modelo configurado no está disponible. Usa «Traza: Elegir modelo».',
    noPermissions: 'No has dado permiso a Traza para usar el modelo. Vuelve a intentarlo y acepta el permiso.',
    blocked: 'El proveedor ha bloqueado la petición (límite o política). Inténtalo más tarde.',
    failed: 'El modelo no pudo completar la petición.',
    timeout: 'El modelo no respondió a tiempo.',
    schema: 'La respuesta del modelo no tiene el formato esperado.',
    empty: 'El modelo «{model}» no ha devuelto ninguna respuesta. Comprueba que tienes la sesión iniciada en su proveedor o elige otro con «Traza: Elegir modelo».',
    tooLarge: 'La respuesta del modelo es demasiado grande.',
    invalid: 'El contexto de la petición no es válido.',
    uiTooLarge: 'El contexto de la pantalla es demasiado grande.',
    question: `La pregunta es obligatoria y no puede superar ${MAX_QUESTION_CHARS} caracteres.`,
    noFolders: 'Abre una carpeta del proyecto para generar el flujo.',
    dbTooLong: 'El contexto de la tabla es demasiado largo para generar la explicación.',
    dbInvalid: 'El contexto de la tabla no es válido.',
    dbBadOutput: 'La IA no devolvió pasos válidos.',
    justification: 'Traza deja que este modelo busque y lea, en solo lectura, el código del proyecto (sin archivos sensibles y con secretos enmascarados) para generar y simular el flujo.',
    notice: 'Traza usa el modelo de lenguaje que elijas en VS Code: el código que el modelo busca y lee del proyecto, en solo lectura (sin archivos sensibles y con secretos enmascarados), se envía al proveedor de ese modelo.',
    pickTitle: 'Traza: Elegir modelo',
    pickPlaceholder: 'Modelo de VS Code que usará Traza',
    auto: 'Automático',
    autoDetail: 'Elegir el modelo la próxima vez que se use',
  },
  en: {
    noModels: 'No language models are available in VS Code. Install or sign in to GitHub Copilot or another provider.',
    modelMissing: 'The configured model is not available. Use "Traza: Elegir modelo".',
    noPermissions: 'You have not allowed Traza to use the model. Try again and accept the permission.',
    blocked: 'The provider blocked the request (quota or policy). Please try again later.',
    failed: 'The model could not complete the request.',
    timeout: 'The model did not respond in time.',
    schema: 'The model response does not have the expected format.',
    empty: 'The model "{model}" returned no response. Make sure you are signed in to its provider or pick another one with "Traza: Elegir modelo".',
    tooLarge: 'The model response is too large.',
    invalid: 'The request context is not valid.',
    uiTooLarge: 'The screen context is too large.',
    question: `The question is required and cannot exceed ${MAX_QUESTION_CHARS} characters.`,
    noFolders: 'Open a project folder to generate the flow.',
    dbTooLong: 'The table context is too long to generate the explanation.',
    dbInvalid: 'The table context is not valid.',
    dbBadOutput: 'The AI did not return valid steps.',
    justification: 'Traza lets this model search and read, read-only, the project code (without sensitive files and with masked secrets) to generate and simulate the flow.',
    notice: 'Traza uses the language model you choose in VS Code: the project code the model searches and reads, read-only (without sensitive files and with masked secrets), is sent to that model\'s provider.',
    pickTitle: 'Traza: Elegir modelo',
    pickPlaceholder: 'VS Code model that Traza will use',
    auto: 'Automatic',
    autoDetail: 'Choose the model the next time it is used',
  },
} as const;

type MessageKey = keyof typeof MESSAGES.es;

interface Validation {
  errors: string[];
  value?: unknown;
}

/** Definición del esquema que se enseña al modelo cuando su respuesta no se puede dibujar (sin definición: solo errores). */
const FORMAT_DEFINITION: Partial<Record<PromptOp, string>> = {
  FLOW: 'FlowDiagram',
  SIMULATE: 'SimulationResult',
  SIMULATE_BEFORE: 'SimulationResult',
  SIMULATE_AFTER: 'SimulationResult',
  LOGS: 'LogAnalysisResult',
  PROPOSE: 'ChangeProposal',
  UI_PLAN: 'UiPreviewPlan',
  UI_MOCK: 'UiMock',
  DB_MAP: 'FlowDbMap',
  DB_MAP_SQL: 'FlowDbMap',
};

/** Mensaje de reintento por FORMATO: intento, rutas JSON con problema, formato esperado y petición de corregir solo eso. */
function formatFeedback(definition: string | null, errors: string[], attempt: number, max: number): string {
  let sb = `## FORMATO NO LEGIBLE (intento ${attempt} de ${max})\nTraza no ha podido dibujar tu respuesta anterior. Partes que no se pudieron leer (ruta JSON: problema):\n`;
  sb += errors.slice(0, 20).map((e) => `- ${e}`).join('\n');
  if (definition) sb += `\nFormato esperado (definicion ${definition}):\n${compactSchema(definition)}`;
  return `${sb}\nDevuelve de nuevo el JSON completo con el mismo contenido, corrigiendo solo estas partes. Solo JSON.`;
}

/** Recibe la conversación que produjo una respuesta válida (para la respuesta en texto del chat). */
type KeepFn = (messages: vscode.LanguageModelChatMessage[], chars: number) => void;

/** Conversación (o datos) de un flujo/propuesta recién generado, para redactar la respuesta en texto del chat. Solo en memoria. */
interface AnswerSeed {
  kind: 'FLOW' | 'PROPOSE';
  messages: vscode.LanguageModelChatMessage[] | null;
  chars: number;
  data: Obj;
  /** Pregunta ya enmascarada. */
  question: string;
  lang: NexoLanguage;
  expires: number;
}

interface RunOptions {
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  language: NexoLanguage;
  keep?: KeepFn;
  /** Tope propio de la operación (caracteres del texto de usuario), además del presupuesto de tokens. */
  maxChars?: number;
}

/** Texto de usuario que cabe en `maxChars` (cada operación recorta con su estrategia). */
type UserBuilder = (maxChars: number) => string;

interface DiagnosisCtx {
  flowId: string;
  flow: Obj;
  code: CodeWindow[];
}

export interface GeneratedFlow {
  flow: Obj;
  title: string;
  model: string;
  /** La pregunta planteaba un escenario («qué pasa si…»), lo devuelva o no el modelo. */
  scenarioAsked?: boolean;
  /** Carpeta del workspace a la que se limitó el contexto (multi-root). */
  folder?: string;
}

export interface GenerateFlowOptions {
  question: string;
  /** Nombre de carpeta del workspace a la que limitar el contexto (multi-root). */
  folder?: string;
  /** La pregunta plantea un escenario concreto: se pide a la IA el campo `scenario`. */
  scenario?: boolean;
  model?: vscode.LanguageModelChat;
  pinned: PinnedRef[];
  useActiveEditor: boolean;
  token: vscode.CancellationToken;
  progress?: (message: string) => void;
  /** Guarda en memoria la conversación para que `streamAnswer` redacte la respuesta en texto (solo `@traza`). */
  keepAnswerSeed?: boolean;
}

export interface ProposeChangeOptions {
  question: string;
  flow: unknown;
  model?: vscode.LanguageModelChat;
  pinned?: PinnedRef[];
  token: vscode.CancellationToken;
  progress?: (message: string) => void;
  keepAnswerSeed?: boolean;
}

export type ProposeResult = { answer: string } | { proposal: Obj; model: string };

/** Error con mensaje apto para el usuario (nunca contiene código ni prompts). */
class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiError';
  }
}

function language(): NexoLanguage {
  return vscode.workspace.getConfiguration('traza').get<string>('language') === 'en' ? 'en' : 'es';
}

function t(key: MessageKey, lang: NexoLanguage = language()): string {
  return MESSAGES[lang][key];
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value) ?? 'null';
  } catch {
    return 'null';
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function str(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && !!path.trim() && path.length <= MAX_PATH;
}

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

/** Une un token externo con un `CancellationTokenSource` propio. */
function linked(token: vscode.CancellationToken | undefined, cts: vscode.CancellationTokenSource): vscode.Disposable {
  if (!token) return { dispose: () => undefined };
  if (token.isCancellationRequested) cts.cancel();
  return token.onCancellationRequested(() => cts.cancel());
}

/** Mensaje de error apto para el log: sin secretos, sin rutas absolutas, en una línea y de 200 caracteres como máximo. */
function logSafe(message: string): string {
  const text = maskSensitiveText(message)
    .replace(/[A-Za-z]:[\\/][^\s'"`)<>]*/g, '<ruta>')
    .replace(/(^|[^\w:/<])\/[\w.@-]+(?:\/[\w.@-]*)+/g, '$1<ruta>')
    .replace(/\s+/g, ' ')
    .trim();
  return cut(text, 200);
}

function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled';
}

/* ------------------------------ decodificación ------------------------------ */

function decodeContext(contextBase64: string): Obj {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(contextBase64.trim(), 'base64').toString('utf8'));
  } catch {
    throw new AiError(t('invalid'));
  }
  if (!isObj(raw)) throw new AiError(t('invalid'));
  return raw;
}

function validFlowId(raw: unknown): string {
  const flowId = typeof raw === 'string' ? raw.trim() : '';
  if (flowId.length > MAX_FLOW_ID) throw new AiError(t('invalid'));
  return flowId;
}

function validFlow(flow: unknown): Obj {
  if (!isObj(flow) || !Array.isArray(flow['steps']) || !flow['steps'].length || flow['steps'].length > MAX_STEPS
    || json(flow).length > MAX_FLOW_JSON) throw new AiError(t('invalid'));
  return flow;
}

/** Ventanas de código (≤ 24, contenido ≤ 8000) enmascaradas de nuevo (`maskConfigSecrets`, defensa en profundidad). */
function validCode(raw: unknown): CodeWindow[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_WINDOWS) throw new AiError(t('invalid'));
  const out: CodeWindow[] = [];
  for (const item of raw) {
    if (item === null || item === undefined) continue;
    if (!isObj(item) || !validPath(item['path']) || !str(item['content'], MAX_WINDOW_CHARS)) throw new AiError(t('invalid'));
    const path = item['path'] as string;
    out.push({
      path,
      startLine: intOrNull(item['startLine']),
      endLine: intOrNull(item['endLine']),
      content: maskConfigSecrets(path, item['content'] as string),
    });
  }
  return out;
}

function decodeDiagnosis(ctx: Obj): DiagnosisCtx {
  return { flowId: validFlowId(ctx['flowId']), flow: validFlow(ctx['flow']), code: validCode(ctx['code']) };
}

function validChangeFiles(raw: unknown): ChangeFile[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_CHANGE_FILES) throw new AiError(t('invalid'));
  const out: ChangeFile[] = [];
  for (const file of raw) {
    if (!isObj(file) || !validPath(file['path']) || typeof file['status'] !== 'string' || !CHANGE_STATUSES.has(file['status'])) throw new AiError(t('invalid'));
    const status = file['status'];
    const hunks = file['hunks'];
    if (!Array.isArray(hunks) || !hunks.length || hunks.length > MAX_CHANGE_HUNKS) throw new AiError(t('invalid'));
    const outHunks: ChangeFile['hunks'] = [];
    for (const hunk of hunks) {
      const oldStart = isObj(hunk) ? hunk['oldStart'] : undefined;
      const newStart = isObj(hunk) ? hunk['newStart'] : undefined;
      const lines = isObj(hunk) ? hunk['lines'] : undefined;
      if (typeof oldStart !== 'number' || !Number.isInteger(oldStart) || oldStart < 0 || typeof newStart !== 'number' || !Number.isInteger(newStart)
        || newStart < 0 || !Array.isArray(lines) || !lines.length || lines.length > MAX_CHANGE_LINES) throw new AiError(t('invalid'));
      const outLines: ChangeFile['hunks'][number]['lines'] = [];
      for (const line of lines) {
        const kind = isObj(line) ? line['kind'] : undefined;
        const text = isObj(line) ? line['text'] : undefined;
        if (typeof kind !== 'string' || !CHANGE_KINDS.has(kind) || typeof text !== 'string' || text.length > MAX_CHANGE_TEXT || text.includes('\n')) {
          throw new AiError(t('invalid'));
        }
        if (status === 'added' && kind !== 'add') throw new AiError(t('invalid'));
        if (status === 'deleted' && kind !== 'del') throw new AiError(t('invalid'));
        outLines.push({ kind, text });
      }
      outHunks.push({ oldStart, newStart, lines: outLines });
    }
    out.push({ path: file['path'] as string, status, hunks: outHunks });
  }
  return out;
}

/* ------------------------------ textos de usuario ------------------------------ */

function idiomaTail(lang: NexoLanguage): string {
  return `## IDIOMA DE LA RESPUESTA\n${lang === 'en' ? 'en' : 'es'}${JSON_TAIL}`;
}

function composeDiagnosis(flow: unknown, code: CodeWindow[], changeText: string | null, tail: string, applied = true): string {
  let sb = `## FLUJO\n${json(flow)}\n\n## CODIGO\n`;
  if (!code.length) sb += '(sin codigo)\n';
  for (const f of code) {
    sb += `### ${cut(f.path.trim(), 400)}:L${f.startLine ?? '?'}-L${f.endLine ?? '?'}\n${numbered(f.content, f.startLine)}\n\n`;
  }
  if (changeText) sb += `## CAMBIO PROPUESTO (${applied ? 'YA INCLUIDO EN EL CODIGO' : 'AUN NO APLICADO: el CODIGO es el original'})\n${changeText}\n\n`;
  return `${sb}\n${tail}`;
}

/** FLUJO + CODIGO + tail, quitando ventanas del final hasta caber en el presupuesto. */
function fitCode(flow: unknown, rawCode: CodeWindow[], changeText: string | null, tail: string, applied = true): UserBuilder {
  const base = rawCode.filter((f) => f.path.trim() && f.content && f.content.length <= MAX_WINDOW_CHARS).slice(0, MAX_WINDOWS);
  return (maxChars) => {
    const budget = Math.min(Math.max(8000, FLOW_MAX_CONTEXT_CHARS) + tail.length, maxChars);
    const code = [...base];
    let text = composeDiagnosis(flow, code, changeText, tail, applied);
    while (text.length > budget && code.length) {
      code.pop();
      text = composeDiagnosis(flow, code, changeText, tail, applied);
    }
    return text;
  };
}

function simulateTail(input: unknown, lang: NexoLanguage): string {
  return `## DATOS DE ENTRADA\n${json(input)}\n\n${idiomaTail(lang)}`;
}

function logsTail(lines: string[], pre: unknown, lang: NexoLanguage): string {
  let sb = '## LOGS\n';
  lines.forEach((line, i) => { sb += `[${i}] ${line}\n`; });
  sb += `\n## PRE-ANALISIS\n${cut(json(pre), MAX_PRE_CHARS)}\n\n`;
  return sb + idiomaTail(lang);
}

interface FlowTextInput {
  mode: 'FLOW' | 'PROPOSE';
  question: string;
  context: FlowContext;
  activeFlow?: string;
  lang: NexoLanguage;
  scenarioHint?: boolean;
  /** Modo agente: visión general de todas las carpetas (va primero). */
  overview?: string;
  /** Modo agente: carpeta mencionada por el usuario (solo pista de por dónde empezar). */
  focusFolder?: string;
  /** Modo agente: rutas ya localizadas y fijadas (no limitan la búsqueda). */
  hintFiles?: string[];
}

const FRONT_TECH = new Set(['Angular', 'React', 'Vue', 'Svelte']);

function roleLine(role: FolderRole): string {
  const parts = role.roles.map((layer) => {
    if (layer === 'datos') return 'datos';
    const tech = role.tech.filter((t) => FRONT_TECH.has(t) === (layer === 'front'));
    return tech.length ? `${layer} (${tech.join(', ')})` : layer;
  });
  return `- ${cut(role.mount, 200)}: ${parts.join(', ')}`;
}

function composeFlowText(input: FlowTextInput, map: string, fragments: ContextFragment[], activeContent: string | null): string {
  let sb = input.overview ? `## CARPETAS DEL WORKSPACE\n${input.overview}\n\n` : '';
  sb += `## MAPA DEL PROYECTO\n${map || '(vacio)'}\n\n## MONTAJES\n`;
  const mounts = input.context.mounts.slice(0, MAX_MOUNTS);
  for (const m of mounts) sb += `- id=${cut(m.id.trim(), 200)} prefijo=${cut(m.prefix, MAX_PATH)} nombre=${cut(m.name.trim(), 200)}\n`;
  if (!mounts.length) sb += '(ninguno)\n';
  sb += '\n';
  const roles = input.context.roles ?? [];
  if (roles.length) {
    sb += `## ROLES DE LAS CARPETAS\n${roles.slice(0, MAX_MOUNTS).map(roleLine).join('\n')}\nEl flujo debe recorrer todas estas capas cuando la petición trate un comportamiento de la aplicación.\n\n`;
  }
  const bridge = input.context.bridge ?? [];
  if (bridge.length) {
    sb += '## PUENTE HTTP DETECTADO\n';
    for (const b of bridge.slice(0, 8)) sb += `- ${cut(b.front, MAX_PATH)}:L${b.line} ${b.method} → ${cut(b.back, MAX_PATH)}${b.handler ? ` (${cut(b.handler, 120)})` : ''}\n`;
    sb += '\n';
  }
  if (input.focusFolder?.trim()) sb += `## CARPETA MENCIONADA\n${cut(input.focusFolder.trim(), 200)} (empieza aquí, pero investiga también las demás carpetas relacionadas)\n\n`;
  if (input.hintFiles?.length) sb += `## ARCHIVOS INDICADOS\n${input.hintFiles.slice(0, AGENT_MAX_HINT_FILES).map((f) => `- ${cut(f, MAX_PATH)}`).join('\n')}\n\n`;
  if (input.mode === 'PROPOSE' && input.activeFlow) sb += `## FLUJO ACTIVO\n${cut(input.activeFlow, MAX_ACTIVE_FLOW_CHARS)}\n\n`;
  if (fragments.length) {
    sb += '## FRAGMENTOS RELEVANTES\n';
    for (const f of fragments) sb += `### ${f.path.trim()}:L${f.startLine}-L${f.endLine}\n${numbered(f.content, f.startLine)}\n\n`;
  }
  const active = input.context.active;
  if (active && activeContent !== null) {
    sb += `## ARCHIVO ACTIVO ${active.path.trim()} (lineas ${active.startLine}-${active.endLine} de ${active.totalLines})\n${numbered(activeContent, active.startLine)}\n\n`;
    const selection = input.context.selection;
    if (selection?.text.trim()) sb += `## SELECCION (lineas ${selection.startLine}-${selection.endLine})\n${selection.text}\n\n`;
  }
  sb += `## PETICION (modo ${input.mode})\n${input.question}`;
  if (input.mode === 'FLOW' && input.scenarioHint) sb += '\n\n(La pregunta plantea un escenario concreto: incluye "scenario" según la regla 9.)';
  return `${sb}\n\n${idiomaTail(input.lang)}`;
}

/** Recorte de tejechat: primero fragmentos de menor prioridad (el último entre iguales), luego el mapa y luego el archivo activo. */
function fitFlowText(input: FlowTextInput): UserBuilder {
  return (maxChars) => {
    const max = Math.min(Math.max(8000, FLOW_MAX_CONTEXT_CHARS), maxChars);
    let map = input.context.mapText.trim();
    const fragments = [...input.context.fragments];
    let activeContent = input.context.active ? input.context.active.content : null;
    let text = composeFlowText(input, map, fragments, activeContent);
    const multi = input.context.mounts.length > 1;
    const mountOf = (path: string): string => (multi ? path.split('/')[0] : '');
    while (text.length > max && fragments.length) {
      let drop = fragments.length - 1;
      let lowest = fragments[drop].priority ?? 1;
      for (let i = drop - 1; i >= 0; i--) {
        const priority = fragments[i].priority ?? 1;
        if (priority < lowest) {
          lowest = priority;
          drop = i;
        }
      }
      if (multi) {
        // Entre los de prioridad mínima se descarta el de la carpeta con más fragmentos (ninguna se queda sin contexto).
        const counts = new Map<string, number>();
        for (const f of fragments) counts.set(mountOf(f.path), (counts.get(mountOf(f.path)) ?? 0) + 1);
        let most = counts.get(mountOf(fragments[drop].path)) ?? 0;
        for (let i = fragments.length - 1; i >= 0; i--) {
          if ((fragments[i].priority ?? 1) !== lowest) continue;
          const count = counts.get(mountOf(fragments[i].path)) ?? 0;
          if (count > most) {
            most = count;
            drop = i;
          }
        }
      }
      fragments.splice(drop, 1);
      text = composeFlowText(input, map, fragments, activeContent);
    }
    if (text.length > max && map) {
      const keep = Math.max(0, map.length - (text.length - max) - TRUNC.length);
      map = map.slice(0, keep) + TRUNC;
      text = composeFlowText(input, map, fragments, activeContent);
    }
    if (text.length > max && activeContent) {
      const keep = Math.max(0, activeContent.length - (text.length - max) - TRUNC.length);
      activeContent = activeContent.slice(0, keep) + TRUNC;
      text = composeFlowText(input, map, fragments, activeContent);
    }
    return text;
  };
}

/* ------------------------------ vista de pantalla ------------------------------ */

interface UiFile {
  path: string;
  content: string;
}

function validUiName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > MAX_UI_NAME) throw new AiError(t('invalid'));
  return value;
}

function validUiFile(file: unknown, maxChars: number): UiFile {
  if (!isObj(file) || !validPath(file['path']) || !str(file['content'], maxChars)) throw new AiError(t('invalid'));
  const path = (file['path'] as string).trim();
  return { path, content: maskConfigSecrets(path, file['content'] as string) };
}

function validUiSheets(raw: unknown, maxSheets: number, maxChars: number): UiFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > maxSheets) throw new AiError(t('invalid'));
  return raw.filter((s) => s !== null && s !== undefined).map((s) => validUiFile(s, maxChars));
}

function decodeUiPlan(ctx: Obj): { input: Obj; change: Obj | null } {
  if (json(ctx).length > MAX_UI_INPUT_CHARS) throw new AiError(t('invalid'));
  validFlowId(ctx['flowId']);
  const rc = ctx['component'];
  if (!isObj(rc)) throw new AiError(t('invalid'));
  const html = validUiFile(rc['html'], MAX_UI_FILE);
  if (!html.content.trim()) throw new AiError(t('invalid'));
  const component = {
    name: validUiName(rc['name']),
    selector: validUiName(rc['selector']),
    ts: validUiFile(rc['ts'], MAX_UI_FILE),
    html,
    css: validUiSheets(rc['css'], MAX_UI_SHEETS, MAX_UI_FILE),
  };
  const children: Obj[] = [];
  const rawChildren = ctx['children'];
  if (rawChildren !== undefined && rawChildren !== null) {
    if (!Array.isArray(rawChildren) || rawChildren.length > MAX_UI_CHILDREN) throw new AiError(t('invalid'));
    for (const child of rawChildren) {
      if (child === null || child === undefined) continue;
      if (!isObj(child)) throw new AiError(t('invalid'));
      const selector = validUiName(child['selector']);
      if (!selector) throw new AiError(t('invalid'));
      children.push({
        selector, name: validUiName(child['name']),
        html: validUiFile(child['html'], MAX_UI_CHILD_FILE), css: validUiSheets(child['css'], MAX_UI_CHILD_SHEETS, MAX_UI_CHILD_FILE),
      });
    }
  }
  const globalCss = typeof ctx['globalCss'] === 'string' ? ctx['globalCss'] : '';
  if (globalCss.length > MAX_UI_GLOBAL_CSS) throw new AiError(t('invalid'));
  const simulation = ctx['simulation'];
  if (!isObj(simulation) || json(simulation).length > MAX_UI_SIMULATION_JSON) throw new AiError(t('invalid'));
  let change: unknown = ctx['change'];
  if (change === null || change === undefined) change = null;
  if (change !== null && (!isObj(change) || json(change).length > MAX_UI_CHANGE_JSON)) throw new AiError(t('invalid'));
  return {
    input: { component, children, globalCss: maskSensitiveText(globalCss), simulation: maskSensitiveJson(simulation) },
    change: change === null ? null : (maskSensitiveJson(change) as Obj),
  };
}

function buildUiPlanText(input: Obj, change: Obj | null, lang: NexoLanguage): string {
  const component = input['component'] as { name: string; selector: string; ts: UiFile; html: UiFile; css: UiFile[] };
  let sb = `## COMPONENTE\nname: ${component.name}\nselector: ${component.selector}\n\n`;
  sb += `## TS ${component.ts.path}\n${component.ts.content}\n\n`;
  sb += `## PLANTILLA ${component.html.path}\n${component.html.content}\n\n`;
  for (const sheet of component.css) sb += `## ESTILOS DEL COMPONENTE ${sheet.path}\n${sheet.content}\n\n`;
  sb += '## HIJOS\n';
  const children = input['children'] as { selector: string; name: string; html: UiFile }[];
  if (!children.length) sb += '(sin hijos)\n';
  for (const child of children) {
    sb += `### ${child.selector} (${child.name})\n#### PLANTILLA ${child.html.path}\n${child.html.content}\n`;
  }
  sb += `\n## ESTILOS GLOBALES (recortados)\n${cutCss(input['globalCss'] as string, UI_PLAN_GLOBAL_CSS_AI_CHARS)}\n\n`;
  sb += `## RESULTADO DE LA SIMULACION\n${json(input['simulation'])}\n\n`;
  const changeText = changeDiff(change);
  if (changeText !== null) sb += `## CAMBIO PROPUESTO\n${changeText}\n\n`;
  return sb + idiomaTail(lang);
}

/* ------------------------------ maqueta de pantalla (UI_MOCK) ------------------------------ */

interface UiMockSeedRef {
  mountId: string;
  file: string;
  line: number;
}

interface UiMockInput {
  flowId: string;
  question: string;
  screen: Obj;
  steps: Obj[];
  seeds: UiMockSeedRef[];
  simulation: unknown;
  change: Obj | null;
  applied: boolean;
}

/** Cadena recortada de un campo del contexto (texto, número o vacío); más larga que `max` = contexto no válido. */
function uiMockText(raw: unknown, max: number): string {
  const value = (typeof raw === 'number' && Number.isFinite(raw) ? String(Math.trunc(raw)) : typeof raw === 'string' ? raw : '').trim();
  if (value.length > max) throw new AiError(t('invalid'));
  return value;
}

/** Semillas (archivos de partida) del contexto: lista de como máximo `max` elementos {mountId, file, line}. */
function decodeSeeds(raw: unknown, max: number, lang: NexoLanguage = language()): UiMockSeedRef[] {
  if (!Array.isArray(raw) || raw.length > max) throw new AiError(t('invalid', lang));
  return raw.map((s) => {
    if (!isObj(s) || !str(s['mountId'], 200) || !validPath(s['file'])) throw new AiError(t('invalid', lang));
    const line = intOrNull(s['line']);
    return { mountId: s['mountId'].trim(), file: s['file'].trim(), line: line !== null && line >= 1 ? line : 1 };
  });
}

function decodeUiMock(ctx: Obj): UiMockInput {
  if (json(ctx).length > MAX_UI_MOCK_INPUT_CHARS) throw new AiError(t('invalid'));
  const flowId = validFlowId(ctx['flowId']);
  const question = ctx['question'];
  if (!str(question, 500)) throw new AiError(t('invalid'));
  const rawScreen = ctx['screen'];
  if (!isObj(rawScreen)) throw new AiError(t('invalid'));
  const screen: Obj = {
    index: uiMockText(rawScreen['index'], 20), id: uiMockText(rawScreen['id'], 200), title: uiMockText(rawScreen['title'], 400),
    label: uiMockText(rawScreen['label'], 400), what: uiMockText(rawScreen['what'], 600), kind: uiMockText(rawScreen['kind'], 80),
  };
  const rawSteps = ctx['steps'];
  if (!Array.isArray(rawSteps) || rawSteps.length > MAX_UI_MOCK_STEPS) throw new AiError(t('invalid'));
  const steps: Obj[] = rawSteps.map((s) => {
    if (!isObj(s)) throw new AiError(t('invalid'));
    return {
      index: uiMockText(s['index'], 20), label: uiMockText(s['label'], 400), title: uiMockText(s['title'], 400),
      ref: uiMockText(s['ref'], MAX_PATH + 220) || null, ui: uiMockText(s['ui'], 400) || null,
    };
  });
  const seeds = decodeSeeds(ctx['seeds'], MAX_UI_MOCK_SEEDS);
  const simulation = ctx['simulation'];
  if (!isObj(simulation) || json(simulation).length > MAX_UI_SIMULATION_JSON) throw new AiError(t('invalid'));
  let change: unknown = ctx['change'];
  if (change === null || change === undefined) change = null;
  if (change !== null && (!isObj(change) || json(change).length > MAX_UI_CHANGE_JSON)) throw new AiError(t('invalid'));
  const applied = change !== null && (change as Obj)['applied'] === true;
  return {
    flowId, question: maskSensitiveText(question),
    screen: maskSensitiveJson(screen) as Obj, steps: maskSensitiveJson(steps) as Obj[], seeds,
    simulation: maskSensitiveJson(simulation),
    change: change === null ? null : (maskSensitiveJson(change) as Obj), applied,
  };
}

/** Textos de la pantalla y del recorrido para el prompt de UI_MOCK, con la semilla recortada para que el total quepa en `maxChars`. */
function buildUiMockText(input: UiMockInput, seedText: string, overview: string, lang: NexoLanguage): UserBuilder {
  const screen = input.screen;
  const s = (value: unknown): string => (typeof value === 'string' ? value : '');
  return (maxChars) => {
    let sb = `## PANTALLA A VISUALIZAR\npaso: P${s(screen['index'])}\ntitulo: ${s(screen['title'])}\netiqueta: ${s(screen['label'])}\n`;
    sb += `lo que ve el usuario: ${s(screen['what']) || s(screen['kind']) || '(sin descripcion)'}\npregunta: ${input.question}\n\n`;
    sb += '## RECORRIDO HASTA LA PANTALLA\n';
    if (!input.steps.length) sb += '(sin pasos)\n';
    for (const step of input.steps) {
      const title = s(step['title']) ? ` · ${s(step['title'])}` : '';
      const ref = s(step['ref']) ? ` · ${s(step['ref'])}` : '';
      const ui = s(step['ui']) ? ` · ui: ${s(step['ui'])}` : '';
      sb += `- P${s(step['index'])} ${s(step['label'])}${title}${ref}${ui}\n`;
    }
    sb += `\n## RESULTADO DE LA SIMULACION\n${json(input.simulation)}\n\n`;
    const changeText = changeDiff(input.change);
    if (changeText !== null) sb += `## CAMBIO PROPUESTO (aplicado: ${input.applied ? 'sí' : 'no'})\n${changeText}\n\n`;
    sb += `## CARPETAS DEL WORKSPACE\n${overview || '(sin datos)'}\n\n`;
    const tail = idiomaTail(lang);
    const head = '## ARCHIVOS DE PARTIDA\n';
    const room = maxChars - sb.length - head.length - tail.length - 2;
    let seed = seedText.trim() || '(ninguno)';
    if (seed.length > room) seed = room > TRUNC.length ? seed.slice(0, room - TRUNC.length) + TRUNC : '';
    return `${sb}${head}${seed}\n\n${tail}`;
  };
}

/* ------------------------------ mapa de datos (DB_MAP / DB_MAP_SQL) ------------------------------ */

/** Esquema real de la conexión (opcional): validado y enmascarado; `empty` = sin conexión. */
function decodeDbSchema(ctx: Obj, lang: NexoLanguage): { schema: unknown; empty: boolean } {
  let schema = ctx['schema'];
  if (schema === undefined || schema === null) schema = {};
  else if (!isObj(schema) || json(schema).length > MAX_DB_SCHEMA_CHARS) throw new AiError(t('invalid', lang));
  else schema = maskSensitiveJson(schema);
  const empty = !isObj(schema) || !Object.keys(schema).length;
  return { schema, empty };
}

/** Validación del `FlowDbMap`: esquema JSON, reparación contra el flujo y comprobaciones semánticas. */
function dbMapCheck(flow: Obj): (raw: Obj) => Validation {
  return (raw) => {
    // Algunos modelos envuelven la respuesta con el nombre de la definición: {"FlowDbMap": {...}}.
    const wrapped = raw['FlowDbMap'];
    const root = Object.keys(raw).length === 1 && isObj(wrapped) ? { ...wrapped } : raw;
    clampToSchema('FlowDbMap', root);
    const errors = validate('FlowDbMap', root);
    if (errors.length) return { errors };
    repairDbMap(root, flow);
    return { errors: dbMapErrors(root, flow), value: root };
  };
}

/** Texto del reintento profundo del mapa de datos, con la semilla recortada para que el total quepa en `maxChars`. */
function buildDbSqlText(flow: Obj, reason: 'failed' | 'empty', schemaText: string, seedText: string, overview: string, lang: NexoLanguage): UserBuilder {
  return (maxChars) => {
    let sb = `## FLUJO\n${json(flow)}\n\n`;
    sb += `## MOTIVO DEL REINTENTO\n${reason === 'empty' ? 'El mapa anterior salió vacío o sin tablas pintables.' : 'El mapa anterior no se pudo generar.'}\n\n`;
    sb += `## ESQUEMA REAL\n${schemaText}\n\n`;
    sb += `## CARPETAS DEL WORKSPACE\n${overview || '(sin datos)'}\n\n`;
    const tail = idiomaTail(lang);
    const head = '## ARCHIVOS DE ACCESO A DATOS\n';
    const room = maxChars - sb.length - head.length - tail.length - 2;
    let seed = seedText.trim() || '(ninguno)';
    if (seed.length > room) seed = room > TRUNC.length ? seed.slice(0, room - TRUNC.length) + TRUNC : '';
    return `${sb}${head}${seed}\n\n${tail}`;
  };
}

/* ------------------------------ explicación de tabla ------------------------------ */

function addText(set: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) set.add(value.trim());
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s*(?:\r\n|[\n\r\u2028\u2029\u0085\u000b\u000c])\s*/g, ' ').replace(/[ \t\u00a0]{2,}/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function parseDbExplain(root: Obj, allowedPlaces: Set<string>, targetColumns: Set<string>): { summary: string | null; steps: Obj[] } {
  const steps: Obj[] = [];
  for (const node of Array.isArray(root['steps']) ? root['steps'] : []) {
    if (steps.length >= MAX_DB_EXPLAIN_STEPS) break;
    if (!isObj(node)) continue;
    const title = clean(node['title'], 90);
    const text = clean(node['text'], 360);
    if (!title && !text) continue;
    const kind = txt(node['kind']).trim().toLowerCase();
    const place = (v: unknown): string | null => (typeof v === 'string' && allowedPlaces.has(v.trim()) ? v.trim() : null);
    const endpoint = typeof node['endpoint'] === 'string' && ENDPOINT_PATTERN.test(node['endpoint'].trim()) ? node['endpoint'].trim() : null;
    const columns = new Set<string>();
    for (const item of Array.isArray(node['columns']) ? node['columns'] : []) {
      if (columns.size >= 12) break;
      if (typeof item === 'string' && targetColumns.has(item.trim())) columns.add(item.trim());
    }
    steps.push({
      kind: DB_EXPLAIN_KINDS.has(kind) ? kind : 'note',
      from: place(node['from']),
      to: place(node['to']),
      title: title || text,
      text: text || title,
      endpoint,
      columns: [...columns],
    });
  }
  const summary = clean(root['summary'], 300);
  return { summary: summary || null, steps };
}

/* ------------------------------------ clase ------------------------------------ */

/** IA del host con `vscode.lm`: resolución del modelo, llamadas con validación, caché y cancelación. */
export class HostAi {
  private readonly sources = new Map<string, vscode.CancellationTokenSource>();
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private last: GeneratedFlow | null = null;
  /** Último modelo elegido en el chat de Copilot (`request.model`); se reutiliza en las acciones del panel. */
  private chatModel: { id: string; vendor: string; family: string } | null = null;
  /** Últimos flujos generados (máx. 10, solo en memoria), para reabrirlos por id. */
  private readonly recent = new Map<string, GeneratedFlow>();
  /** Propuestas de cambio por flujo (máx. 10 por flujo, solo en memoria), para reabrir «Simular cambios». */
  private readonly proposals = new Map<string, Obj[]>();
  /** Semillas para la respuesta en texto del chat (máx. 2, 10 min, se consumen al usarse; nunca se persisten). */
  private readonly answerSeeds = new Map<string, AnswerSeed>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Almacén seguro de la extensión (contraseñas de base de datos). */
  get secrets(): vscode.SecretStorage {
    return this.context.secrets;
  }

  /** Último flujo generado (comando o `@traza`), para «Abrir flujo». */
  get lastGenerated(): GeneratedFlow | null {
    return this.last;
  }

  /** Flujo generado en esta sesión por su id (de los últimos 10); `null` si no está. */
  flowById(id: string): GeneratedFlow | null {
    return this.recent.get(id) ?? null;
  }

  /** Guarda una propuesta asociada a un flujo reciente (máx. 10 por flujo; descarta las más antiguas). */
  rememberProposal(flowId: string, proposal: Obj): void {
    if (!this.recent.has(flowId)) return;
    const list = [...(this.proposals.get(flowId) ?? []), proposal].slice(-10);
    this.proposals.set(flowId, list);
  }

  /** Guarda el mapa de datos generado en el flujo reciente (mismo objeto que `last`), para reabrirlo sin regenerarlo. */
  rememberDbMap(flowId: string, dbMap: Obj): void {
    const g = this.recent.get(flowId);
    if (!g) return;
    g.flow['dbMap'] = dbMap;
    trazaLog().info(`DB_MAP · flujo=${flowId} · guardado en la sesión`);
  }

  /** Propuestas guardadas de un flujo (copia). */
  proposalsFor(flowId: string): Obj[] {
    return [...(this.proposals.get(flowId) ?? [])];
  }

  /* ------------------------------ modelo ------------------------------ */

  private configuredModel(): { vendor?: string; family?: string; id?: string } | null {
    const raw = vscode.workspace.getConfiguration('traza').get<unknown>('model');
    if (!isObj(raw)) return null;
    const pick = (k: string): string | undefined => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
    const out = { vendor: pick('vendor'), family: pick('family'), id: pick('id') };
    return out.vendor || out.family || out.id ? out : null;
  }

  private async saveModel(model: vscode.LanguageModelChat | null): Promise<void> {
    const value = model ? { vendor: model.vendor, family: model.family, id: model.id } : undefined;
    await vscode.workspace.getConfiguration('traza').update('model', value, vscode.ConfigurationTarget.Global);
  }

  /**
   * Modelo a usar: el preferido (chat), el del ajuste (`id`, o `vendor`/`family`) o, con el ajuste vacío, el que se
   * elija en el QuickPick (se guarda; con un único modelo se usa sin preguntar). Cancelar el QuickPick → `cancelled`.
   */
  async resolveModel(preferred?: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat> {
    // El modelo elegido en el chat de Copilot manda también en las acciones del panel (simular, logs, BD…).
    // El objeto de `request.model` solo vale durante esa petición: se guarda su id y se vuelve a pedir por id.
    if (preferred) {
      this.chatModel = { id: preferred.id, vendor: preferred.vendor, family: preferred.family };
      return preferred;
    }
    if (this.chatModel) {
      let models = await vscode.lm.selectChatModels({ id: this.chatModel.id });
      if (!models.length) models = await vscode.lm.selectChatModels({ vendor: this.chatModel.vendor, family: this.chatModel.family });
      if (models.length) return models[0];
    }
    const configured = this.configuredModel();
    if (configured) {
      let models: vscode.LanguageModelChat[] = [];
      if (configured.id) models = await vscode.lm.selectChatModels({ id: configured.id });
      if (!models.length && (configured.vendor || configured.family)) {
        models = await vscode.lm.selectChatModels({
          ...(configured.vendor ? { vendor: configured.vendor } : {}), ...(configured.family ? { family: configured.family } : {}),
        });
      }
      if (models.length) return models[0];
      const any = await vscode.lm.selectChatModels();
      throw new AiError(t(any.length ? 'modelMissing' : 'noModels'));
    }
    const models = await vscode.lm.selectChatModels();
    logModels(models);
    if (!models.length) throw new AiError(t('noModels'));
    if (models.length === 1) return models[0];
    const picked = await this.pickModel(models);
    if (picked === undefined) throw new Error('cancelled');
    if (picked === 'auto') return models[0];
    await this.saveModel(picked);
    return picked;
  }

  /** QuickPick de modelos con «Automático» primero. `undefined` = cancelado. */
  async pickModel(available?: vscode.LanguageModelChat[]): Promise<vscode.LanguageModelChat | 'auto' | undefined> {
    const models = available ?? await vscode.lm.selectChatModels();
    if (!models.length) throw new AiError(t('noModels'));
    const current = this.configuredModel();
    const items: (vscode.QuickPickItem & { model: vscode.LanguageModelChat | 'auto' })[] = [
      { label: `$(sparkle) ${t('auto')}`, detail: t('autoDetail'), model: 'auto', picked: !current },
      ...models.map((m) => ({
        label: m.name,
        description: `${m.vendor} · ${m.family} · ${m.maxInputTokens || '?'}`,
        model: m,
        picked: !!current && current.id === m.id,
      })),
    ];
    const choice = await vscode.window.showQuickPick(items, { title: t('pickTitle'), placeHolder: t('pickPlaceholder'), ignoreFocusOut: true });
    return choice?.model;
  }

  /** Comando «Traza: Elegir modelo». */
  async selectModelCommand(): Promise<void> {
    try {
      const choice = await this.pickModel();
      if (choice === undefined) return;
      await this.saveModel(choice === 'auto' ? null : choice);
      void vscode.window.showInformationMessage(choice === 'auto' ? `Traza: ${t('auto')}` : `Traza: ${choice.name}`);
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : t('failed'));
    }
  }

  private showNoticeOnce(): void {
    if (this.context.globalState.get<boolean>(NOTICE_KEY)) return;
    void this.context.globalState.update(NOTICE_KEY, true);
    void vscode.window.showInformationMessage(t('notice'));
  }

  /* ------------------------------ cancelación ------------------------------ */

  private begin(id: string): vscode.CancellationTokenSource {
    this.cancel(id);
    const cts = new vscode.CancellationTokenSource();
    this.sources.set(id, cts);
    return cts;
  }

  private end(id: string, cts: vscode.CancellationTokenSource): void {
    if (this.sources.get(id) === cts) this.sources.delete(id);
    cts.dispose();
  }

  cancel(id: string): void {
    const cts = this.sources.get(id);
    if (!cts) return;
    this.sources.delete(id);
    cts.cancel();
  }

  cancelAll(ids: Iterable<string>): void {
    for (const id of [...ids]) this.cancel(id);
  }

  /* ------------------------------ núcleo ------------------------------ */

  private cacheGet(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    this.cache.delete(key);
    if (entry.expires <= Date.now()) return undefined;
    this.cache.set(key, entry);
    return JSON.parse(JSON.stringify(entry.value)) as unknown;
  }

  private cachePut(key: string, value: unknown): void {
    this.cache.delete(key);
    this.cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value: JSON.parse(JSON.stringify(value)) as unknown });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async countTokens(model: vscode.LanguageModelChat, system: string, user: string, token: vscode.CancellationToken): Promise<number | null> {
    try {
      return (await model.countTokens(system, token)) + (await model.countTokens(user, token));
    } catch (error: unknown) {
      console.warn('[Traza] countTokens no disponible.', error instanceof Error ? error.name : '');
      return null;
    }
  }

  /** Texto de usuario ajustado al presupuesto de tokens del modelo (estimación y, si se puede, `countTokens`). */
  private async fitUser(model: vscode.LanguageModelChat, system: string, build: UserBuilder, opMax: number, token: vscode.CancellationToken): Promise<string> {
    const budget = Math.floor((model.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS) * TOKEN_BUDGET_RATIO);
    let maxChars = Math.min(opMax, Math.max(2000, (budget - Math.ceil(system.length / CHARS_PER_TOKEN)) * CHARS_PER_TOKEN));
    let user = build(maxChars);
    for (let i = 0; i < 4; i++) {
      if (token.isCancellationRequested) throw new Error('cancelled');
      const tokens = await this.countTokens(model, system, user, token);
      if (tokens === null || tokens <= budget) break;
      const next = Math.max(2000, Math.floor(Math.min(maxChars, user.length) * (budget / tokens) * 0.95));
      if (next >= maxChars && next >= user.length) break;
      maxChars = next;
      const rebuilt = build(maxChars);
      if (rebuilt === user) break;
      user = rebuilt;
    }
    return user;
  }

  /** Una llamada al modelo con tiempo máximo, límite de tamaño y errores traducidos. */
  private async call(model: vscode.LanguageModelChat, messages: vscode.LanguageModelChatMessage[], token: vscode.CancellationToken, lang: NexoLanguage): Promise<string> {
    const cts = new vscode.CancellationTokenSource();
    const link = linked(token, cts);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cts.cancel();
    }, CALL_TIMEOUT_MS);
    const started = Date.now();
    try {
      this.showNoticeOnce();
      const response = await model.sendRequest(messages, { justification: t('justification', lang) }, cts.token);
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
        if (text.length > MAX_RESPONSE_CHARS) {
          cts.cancel();
          throw new AiError(t('tooLarge', lang));
        }
      }
      if (!text.trim()) throw new AiError(t('empty', lang).replace('{model}', modelLabel(model)));
      return text;
    } catch (error: unknown) {
      return this.modelFailure(error, timedOut, token, cts, lang);
    } finally {
      clearTimeout(timer);
      link.dispose();
      cts.dispose();
      console.info('[Traza] Llamada al modelo.', Date.now() - started, 'ms');
    }
  }

  /** Traduce el fallo de una llamada al modelo en un error apto para el usuario (o `cancelled`). */
  private modelFailure(error: unknown, timedOut: boolean, token: vscode.CancellationToken, cts: vscode.CancellationTokenSource, lang: NexoLanguage): never {
    if (error instanceof AiError) throw error;
    if (timedOut) throw new AiError(t('timeout', lang));
    if (token.isCancellationRequested || cts.token.isCancellationRequested) throw new Error('cancelled');
    if (error instanceof vscode.LanguageModelError) {
      console.warn('[Traza] Error del modelo.', error.code || error.name);
      if (error.code === vscode.LanguageModelError.NoPermissions().code) throw new AiError(t('noPermissions', lang));
      if (error.code === vscode.LanguageModelError.Blocked().code) throw new AiError(t('blocked', lang));
      if (error.code === vscode.LanguageModelError.NotFound().code) throw new AiError(t('modelMissing', lang));
      throw new AiError(`${t('failed', lang)} ${cut(error.message || '', 200)}`.trim());
    }
    console.warn('[Traza] Fallo al llamar al modelo.', error instanceof Error ? error.name : '');
    throw new AiError(`${t('failed', lang)} ${error instanceof Error ? cut(error.message || '', 200) : ''}`.trim());
  }

  /**
   * Como `call`, pero con herramientas: devuelve el texto y las llamadas a herramientas del stream de la respuesta.
   * Con `onText` se avisa de cada fragmento de texto (además de acumularlo); si devuelve `false`, se corta el stream y
   * se devuelve lo acumulado sin error (salvo cancelación del usuario).
   */
  private async callTools(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    tools: vscode.LanguageModelChatTool[] | undefined,
    token: vscode.CancellationToken,
    lang: NexoLanguage,
    allowEmpty = false,
    onText?: (chunk: string) => boolean | void,
  ): Promise<{ text: string; calls: vscode.LanguageModelToolCallPart[]; other: number }> {
    const cts = new vscode.CancellationTokenSource();
    const link = linked(token, cts);
    let timedOut = false;
    let stopped = false;
    let text = '';
    const calls: vscode.LanguageModelToolCallPart[] = [];
    let other = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      cts.cancel();
    }, CALL_TIMEOUT_MS);
    const started = Date.now();
    try {
      this.showNoticeOnce();
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: t('justification', lang),
        ...(tools ? { tools, toolMode: vscode.LanguageModelChatToolMode.Auto } : {}),
      };
      const response = await model.sendRequest(messages, options, cts.token);
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          text += part.value;
          if (text.length > MAX_RESPONSE_CHARS) {
            cts.cancel();
            throw new AiError(t('tooLarge', lang));
          }
          if (onText && onText(part.value) === false) {
            stopped = true;
            cts.cancel();
            break;
          }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          calls.push(part);
        } else {
          other++;
        }
      }
      if (!allowEmpty && !text.trim() && !calls.length) throw new AiError(t('empty', lang).replace('{model}', modelLabel(model)));
      return { text, calls, other };
    } catch (error: unknown) {
      if (stopped && !token.isCancellationRequested) return { text, calls, other };
      return this.modelFailure(error, timedOut, token, cts, lang);
    } finally {
      clearTimeout(timer);
      link.dispose();
      cts.dispose();
      console.info('[Traza] Llamada al modelo con herramientas.', Date.now() - started, 'ms');
    }
  }

  /** El modelo y la versión de VS Code admiten llamadas a herramientas (API estable desde 1.95). */
  private agentCapable(model: vscode.LanguageModelChat): boolean {
    if (typeof vscode.LanguageModelToolCallPart !== 'function' || typeof vscode.LanguageModelToolResultPart !== 'function'
      || typeof vscode.LanguageModelChatToolMode !== 'object') return false;
    const caps = (model as unknown as { capabilities?: { supportsToolCalling?: boolean } }).capabilities;
    return caps?.supportsToolCalling !== false;
  }

  /**
   * Prompt de sistema como primer mensaje User (no hay rol system estable), texto de usuario ajustado, parseo y
   * comprobación de FORMATO (esquema con recorte mecánico previo + reglas de forma): si la respuesta no se puede dibujar,
   * hasta MAX_FORMAT_ATTEMPTS intentos en total, cada reintento con las rutas con problema y el formato esperado.
   * Nunca se vuelve a preguntar por el contenido. Respuestas válidas en caché (LRU, 15 min).
   */
  private async runJson(op: PromptOp, system: string, build: UserBuilder, check: (root: Obj) => Validation | Promise<Validation>, opts: RunOptions): Promise<{ value: unknown; cached: boolean }> {
    const { model, token, language: lang } = opts;
    const user = await this.fitUser(model, system, build, opts.maxChars ?? Number.MAX_SAFE_INTEGER, token);
    const key = sha256(`${op}|${model.id}|${lang}|${system}|${user}`);
    const keepValue = (value: unknown): void => {
      if (!opts.keep) return;
      const text = json(value);
      opts.keep([
        vscode.LanguageModelChatMessage.User(system), vscode.LanguageModelChatMessage.User(user),
        vscode.LanguageModelChatMessage.Assistant(cut(text, MAX_RETRY_ASSISTANT_CHARS)),
      ], system.length + user.length + Math.min(text.length, MAX_RETRY_ASSISTANT_CHARS));
    };
    const hit = this.cacheGet(key);
    if (hit !== undefined) {
      keepValue(hit);
      return { value: hit, cached: true };
    }

    const messages = [vscode.LanguageModelChatMessage.User(system), vscode.LanguageModelChatMessage.User(user)];
    const attempt = async (msgs: vscode.LanguageModelChatMessage[]): Promise<{ text: string; result: Validation }> => {
      const text = await this.call(model, msgs, token, lang);
      let root: Obj;
      try {
        root = parseModelJson(text);
      } catch (error: unknown) {
        return { text, result: { errors: [`$: la respuesta no es un objeto JSON valido (${error instanceof Error ? error.message : ''})`] } };
      }
      const result = await check(root);
      // Los `check` que validan sin transformar no devuelven `value`: el resultado es la raíz ya validada.
      return { text, result: result.value === undefined ? { ...result, value: root } : result };
    };
    let { text, result } = await attempt(messages);
    for (let n = 1; result.errors.length; n++) {
      logValidation(op, model, n, text, result.errors);
      if (n >= MAX_FORMAT_ATTEMPTS) {
        console.warn('[Traza] Respuesta no legible tras los intentos.', op, result.errors.length);
        throw new AiError(t('schema', lang));
      }
      trazaLog().warn(`${op} · formato no legible · reintento ${n} de ${MAX_FORMAT_ATTEMPTS - 1}`);
      const retry = [
        ...messages,
        vscode.LanguageModelChatMessage.Assistant(cut(text, MAX_RETRY_ASSISTANT_CHARS)),
        vscode.LanguageModelChatMessage.User(formatFeedback(FORMAT_DEFINITION[op] ?? null, result.errors, n + 1, MAX_FORMAT_ATTEMPTS)),
      ];
      ({ text, result } = await attempt(retry));
    }
    this.cachePut(key, result.value);
    keepValue(result.value);
    return { value: result.value, cached: false };
  }

  /** Lee (solo lectura, enmascarado) los archivos de partida; los que no se encuentran van como pista de búsqueda. */
  private async readSeeds(session: AgentToolSession, seeds: UiMockSeedRef[], maxLines: number, maxChars: number): Promise<string> {
    let sb = '';
    for (const seed of seeds) {
      const path = session.pathFor(seed.mountId, seed.file);
      if (path) {
        sb += `${await session.invoke('traza_read', { path, startLine: 1, endLine: maxLines }, maxChars)}\n\n`;
      } else {
        sb += `- ${seed.mountId ? `${seed.mountId}/` : ''}${seed.file}:${seed.line} (no encontrado: búscalo)\n`;
      }
    }
    return sb;
  }

  /* ------------------------------ webview: flow ------------------------------ */

  /** Simular, analizar logs, plan de pantalla y mapa de datos (`FlowDiagnosisResponse`). */
  async flowRequest(id: string, kind: FlowKind, body: FlowRequestBody, progress?: (message: string) => void): Promise<FlowDiagnosisResponse> {
    const lang = body.language === 'en' ? 'en' : 'es';
    const cts = this.begin(id);
    try {
      const ctx = decodeContext(body.contextBase64);
      const model = await this.resolveModel();
      if (cts.token.isCancellationRequested) throw new Error('cancelled');
      const opts: RunOptions = { model, token: cts.token, language: lang };
      let operation: string;
      let run: { value: unknown; cached: boolean };
      if (kind === 'simulate' || kind === 'logs') {
        const d = decodeDiagnosis(ctx);
        const simulate = kind === 'simulate';
        let tail: string;
        let lineCount = 0;
        if (simulate) {
          const input = ctx['input'];
          if (input === undefined || json(input).length > MAX_INPUT_CHARS) throw new AiError(t('invalid', lang));
          tail = simulateTail(maskSensitiveJson(input), lang);
        } else {
          const logs = ctx['logs'];
          const pre = ctx['pre'];
          if (typeof logs !== 'string' || !logs.trim() || logs.length > MAX_LOG_CHARS) throw new AiError(t('invalid', lang));
          if (!isObj(pre) || json(pre).length > MAX_PRE_CHARS) throw new AiError(t('invalid', lang));
          const masked = maskSensitiveText(logs);
          const lines = masked.split(/\r?\n/);
          const requested = ctx['logLines'];
          lineCount = typeof requested === 'number' && requested > 0 ? Math.min(Math.trunc(requested), lines.length) : lines.length;
          tail = logsTail(lines, maskSensitiveJson(pre), lang);
        }
        operation = simulate ? 'SIMULATE' : 'LOGS';
        run = await this.runJson(operation as PromptOp, systemFor(operation as PromptOp), fitCode(d.flow, d.code, null, tail), (root) => {
          delete root['uiRef'];
          delete root['uiRefAfter'];
          const definition = simulate ? 'SimulationResult' : 'LogAnalysisResult';
          clampToSchema(definition, root);
          const errors = validate(definition, root);
          if (!errors.length) repairDiagnosis(root, lineCount, simulate);
          return { errors };
        }, opts);
      } else if (kind === 'ui-plan') {
        const ui = decodeUiPlan(ctx);
        const user = buildUiPlanText(ui.input, ui.change, lang);
        if (user.length > MAX_UI_PROMPT_CHARS) throw new AiError(t('uiTooLarge', lang));
        operation = 'UI_PLAN';
        const planFlowId = typeof ctx['flowId'] === 'string' ? ctx['flowId'].slice(0, 64) : '?';
        const t0 = Date.now();
        try {
          run = await this.runJson('UI_PLAN', systemFor('UI_PLAN'), () => user, (root) => {
            clampToSchema('UiPreviewPlan', root);
            repairUiPlan(root);
            const errors = validate('UiPreviewPlan', root);
            return { errors: errors.length ? errors : uiPlanErrors(root) };
          }, opts);
          trazaLog().info(`UI_PLAN · flujo=${planFlowId} · listo · cached=${run.cached} · ${Date.now() - t0} ms`);
        } catch (error) {
          trazaLog().warn(`UI_PLAN · ${isCancelled(error) ? 'cancelado' : 'error'} · ${Date.now() - t0} ms`);
          throw error;
        }
      } else if (kind === 'ui-mock') {
        const mock = decodeUiMock(ctx);
        operation = 'UI_MOCK';
        const mockFlowId = mock.flowId.slice(0, 64);
        const agentic = this.agentCapable(model);
        const t0 = Date.now();
        trazaLog().info(`UI_MOCK · flujo=${mockFlowId} · paso=P${String(mock.screen['index'] ?? '')} · inicio · semillas=${mock.seeds.length} · cambio=${mock.change ? 'sí' : 'no'} · agente=${agentic ? 'sí' : 'no'}`);
        const check = (raw: Obj): Validation => {
          // Algunos modelos envuelven la respuesta con el nombre de la definición: {"UiMock": {...}}.
          const wrapped = raw['UiMock'];
          const root: Obj = Object.keys(raw).length === 1 && isObj(wrapped) ? { ...wrapped } : raw;
          if (root['after'] === null) delete root['after'];
          clampToSchema('UiMock', root);
          repairUiMock(root);
          const errors = validate('UiMock', root);
          return { errors: errors.length ? errors : uiMockErrors(root), value: root };
        };
        let seedText = '';
        let overview = '';
        try {
          let value: unknown = null;
          let mode = 'clásico';
          if (agentic) {
            value = await this.runAgent({
              op: 'UI_MOCK', model, token: cts.token, lang, progress,
              seed: async (session): Promise<FlowContext> => {
                seedText = await this.readSeeds(session, mock.seeds, UI_MOCK_SEED_LINES, UI_MOCK_SEED_FILE_CHARS);
                overview = session.overview();
                return { mounts: [], mapText: '', fragments: [] };
              },
              build: () => buildUiMockText(mock, seedText, overview, lang),
              check,
            });
            if (value !== null) mode = 'agente';
          }
          let cached = false;
          if (value === null) {
            const session = new AgentToolSession({ token: cts.token, lang, progress });
            await session.init();
            seedText = await this.readSeeds(session, mock.seeds, UI_MOCK_SEED_LINES, UI_MOCK_SEED_FILE_CHARS);
            overview = session.overview();
            progress?.(lang === 'en' ? 'Building the screen mockup…' : 'Maquetando la pantalla…');
            const classic = await this.runJson('UI_MOCK', systemFor('UI_MOCK'), buildUiMockText(mock, seedText, overview, lang), check, { ...opts, maxChars: MAX_UI_MOCK_INPUT_CHARS });
            value = classic.value;
            cached = classic.cached;
          }
          run = { value, cached };
          const result = value as Obj;
          const sizeOf = (v: unknown): number => (typeof v === 'string' ? v.length : 0);
          trazaLog().info(`UI_MOCK · listo · modo=${mode} · cached=${cached} · html=${sizeOf(result['html'])} css=${sizeOf(result['css'])} · after=${isObj(result['after']) ? 'sí' : 'no'} · ${Date.now() - t0} ms`);
        } catch (error) {
          trazaLog().warn(`UI_MOCK · ${isCancelled(error) ? 'cancelado' : 'error'} · ${Date.now() - t0} ms`);
          throw error;
        }
      } else if (kind === 'db-map-sql') {
        const d = decodeDiagnosis(ctx);
        const { schema, empty } = decodeDbSchema(ctx, lang);
        const seeds = decodeSeeds(ctx['seeds'], MAX_DB_SQL_SEEDS, lang);
        const reason: 'failed' | 'empty' = ctx['reason'] === 'empty' ? 'empty' : 'failed';
        const schemaText = empty ? '(sin conexion)' : cut(json(schema), DB_SQL_SCHEMA_CHARS);
        operation = 'DB_MAP_SQL';
        const sqlFlowId = d.flowId.slice(0, 64);
        const agentic = this.agentCapable(model);
        const t0 = Date.now();
        trazaLog().info(`DB_MAP_SQL · flujo=${sqlFlowId} · inicio · semillas=${seeds.length} · motivo=${reason} · esquema=${empty ? 'código' : 'real'} · agente=${agentic ? 'sí' : 'no'}`);
        const base = dbMapCheck(d.flow);
        const check = (raw: Obj): Validation => {
          const result = base(raw);
          if (result.errors.length) return result;
          const map = result.value as Obj;
          const tables = map['tables'];
          const accesses = map['accesses'];
          if (!Array.isArray(tables) || !tables.length || !Array.isArray(accesses) || !accesses.length) {
            return { errors: ['$.tables/$.accesses: vacío; Traza necesita al menos una tabla y un acceso de un paso del FLUJO: localiza las sentencias SQL o las entidades'] };
          }
          return result;
        };
        let seedText = '';
        let overview = '';
        try {
          let value: unknown = null;
          let mode = 'clásico';
          if (agentic) {
            value = await this.runAgent({
              op: 'DB_MAP_SQL', model, token: cts.token, lang, progress,
              seed: async (session): Promise<FlowContext> => {
                seedText = await this.readSeeds(session, seeds, DB_SQL_SEED_LINES, DB_SQL_SEED_FILE_CHARS);
                overview = session.overview();
                return { mounts: [], mapText: '', fragments: [] };
              },
              build: () => buildDbSqlText(d.flow, reason, schemaText, seedText, overview, lang),
              check,
            });
            if (value !== null) mode = 'agente';
          }
          let cached = false;
          if (value === null) {
            const session = new AgentToolSession({ token: cts.token, lang, progress });
            await session.init();
            seedText = await this.readSeeds(session, seeds, DB_SQL_SEED_LINES, DB_SQL_SEED_FILE_CHARS);
            overview = session.overview();
            progress?.(lang === 'en' ? 'Building the data map…' : 'Construyendo el mapa de datos…');
            const classic = await this.runJson('DB_MAP_SQL', systemFor('DB_MAP_SQL'), buildDbSqlText(d.flow, reason, schemaText, seedText, overview, lang), check, { ...opts, maxChars: MAX_DB_SQL_INPUT_CHARS });
            value = classic.value;
            cached = classic.cached;
          }
          run = { value, cached };
          const result = value as Obj;
          const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
          trazaLog().info(`DB_MAP_SQL · listo · modo=${mode} · cached=${cached} · tablas=${count(result['tables'])} · relaciones=${count(result['relations'])} · accesos=${count(result['accesses'])} · ${Date.now() - t0} ms`);
        } catch (error) {
          trazaLog().warn(`DB_MAP_SQL · ${isCancelled(error) ? 'cancelado' : 'error'} · ${Date.now() - t0} ms`);
          throw error;
        }
      } else {
        const d = decodeDiagnosis(ctx);
        const { schema, empty } = decodeDbSchema(ctx, lang);
        const tail = `## ESQUEMA REAL\n${empty ? '(sin conexion)' : json(schema)}\n\n${idiomaTail(lang)}`;
        operation = 'DB_MAP';
        const dbFlowId = typeof ctx['flowId'] === 'string' ? ctx['flowId'].slice(0, 64) : '?';
        const t0 = Date.now();
        trazaLog().info(`DB_MAP · flujo=${dbFlowId} · inicio · esquema=${empty ? 'código' : 'real'}`);
        try {
        run = await this.runJson('DB_MAP', systemFor('DB_MAP'), fitCode(d.flow, d.code, null, tail), dbMapCheck(d.flow), opts);
        trazaLog().info(`DB_MAP · flujo=${dbFlowId} · listo · cached=${run.cached} · ${Date.now() - t0} ms`);
        } catch (error) {
          trazaLog().warn(`DB_MAP · flujo=${dbFlowId} · ${isCancelled(error) ? 'cancelado' : 'error'} · ${Date.now() - t0} ms`);
          throw error;
        }
      }
      return { success: true, codigo: 'OK', mensaje: null, operation, result: run.value, model: modelLabel(model), usage: null, cached: run.cached };
    } finally {
      this.end(id, cts);
    }
  }

  /* ------------------------------ webview: comparar ------------------------------ */

  /** «Simular cambios»: antes (SIMULATE) y después (SIMULATE_AFTER) por caso, concurrencia 3; un fallo cancela todo. */
  async compareChange(id: string, proposalId: string, body: ChangeCompareBody): Promise<unknown> {
    const lang = body.language === 'en' ? 'en' : 'es';
    const cts = this.begin(id);
    const child = new vscode.CancellationTokenSource();
    const link = linked(cts.token, child);
    try {
      const ctx = decodeContext(body.contextBase64);
      const d = decodeDiagnosis(ctx);
      if (body.flowId.trim() !== d.flowId) throw new AiError(t('invalid', lang));
      const files = validChangeFiles(ctx['files']);
      const presetIds = new Set<string>();
      for (const preset of Array.isArray(d.flow['simulationPresets']) ? d.flow['simulationPresets'] : []) {
        const presetId = isObj(preset) ? txt(preset['id']) : '';
        if (presetId) presetIds.add(presetId);
      }
      const rawCases = ctx['cases'];
      if (!Array.isArray(rawCases) || !rawCases.length || rawCases.length > MAX_COMPARE_CASES) throw new AiError(t('invalid', lang));
      const cases: { presetId: string; input: unknown }[] = [];
      const seen = new Set<string>();
      for (const item of rawCases) {
        const presetId = isObj(item) ? item['presetId'] : undefined;
        if (typeof presetId !== 'string' || !presetIds.has(presetId) || seen.has(presetId)) throw new AiError(t('invalid', lang));
        seen.add(presetId);
        const input = (item as Obj)['input'];
        if (input === undefined || json(input).length > MAX_INPUT_CHARS) throw new AiError(t('invalid', lang));
        cases.push({ presetId, input: maskSensitiveJson(input) });
      }
      const title = typeof ctx['title'] === 'string' ? cut(ctx['title'].trim(), MAX_CHANGE_TITLE) : '';
      const summary = typeof ctx['summary'] === 'string' ? cut(ctx['summary'].trim(), MAX_CHANGE_SUMMARY) : '';
      let afterCode: CodeWindow[];
      let unapplied = false;
      try {
        afterCode = afterWindows(d.code, files);
      } catch (error: unknown) {
        if (!(error instanceof PatchError)) throw error;
        // No es un error: el modelo razona el después con el código original y el diff.
        afterCode = d.code;
        unapplied = true;
        trazaLog().info(`Comparar · cambio no aplicable a las ventanas (${error.message}); el modelo razona el despues con el diff`);
      }
      const changeText = changeDiff({ title, summary, files });
      trazaLog().info(`Comparar · casos=${cases.length} · ventanas=${d.code.length} (${d.code.reduce((n, w) => n + w.content.length, 0)} caracteres) · despues=${afterCode.length}`);
      const model = await this.resolveModel();
      const opts: RunOptions = { model, token: child.token, language: lang };
      const simulateCheck = (root: Obj): Validation => {
        delete root['uiRef'];
        delete root['uiRefAfter'];
        clampToSchema('SimulationResult', root);
        const errors = validate('SimulationResult', root);
        if (!errors.length) repairDiagnosis(root, 0, true);
        return { errors };
      };
      type Job = { index: number; after: boolean };
      const jobs: Job[] = cases.flatMap((_, index) => [{ index, after: false }, { index, after: true }]);
      const results: { value: unknown; cached: boolean }[][] = cases.map(() => []);
      let failure: unknown = null;
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < jobs.length && failure === null) {
          const job = jobs[next++];
          const input = cases[job.index].input;
          try {
            const run = job.after
              ? await this.runJson('SIMULATE_AFTER', systemFor('SIMULATE_AFTER'), fitCode(d.flow, afterCode, changeText, unapplied ? `${UNAPPLIED_NOTE}${simulateTail(input, lang)}` : simulateTail(input, lang)), simulateCheck, opts)
              : await this.runJson('SIMULATE_BEFORE', systemFor('SIMULATE_BEFORE'), fitCode(d.flow, d.code, changeText, simulateTail(input, lang), false), simulateCheck, opts);
            results[job.index][job.after ? 1 : 0] = run;
          } catch (error: unknown) {
            if (failure === null) failure = error;
            child.cancel();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(COMPARE_CONCURRENCY, jobs.length) }, worker));
      if (failure !== null) {
        if (cts.token.isCancellationRequested) throw new Error('cancelled');
        throw failure;
      }
      return {
        success: true, codigo: 'OK', mensaje: null,
        comparison: {
          proposalId, flowId: d.flowId,
          cases: cases.map((c, i) => ({ presetId: c.presetId, before: results[i][0].value, after: results[i][1].value })),
        },
        model: modelLabel(model), usage: null, cached: results.every((r) => r[0].cached && r[1].cached),
      };
    } finally {
      link.dispose();
      child.dispose();
      this.end(id, cts);
    }
  }

  /* ------------------------------ webview: tabla ------------------------------ */

  /** «Mejorar con IA» de la explicación de una tabla (`DbExplainAiResponse`). */
  async dbExplain(id: string, body: { language: NexoLanguage; contextBase64: string }): Promise<unknown> {
    const lang = body.language === 'en' ? 'en' : 'es';
    const cts = this.begin(id);
    try {
      let text: string;
      try {
        text = Buffer.from(body.contextBase64.trim(), 'base64').toString('utf8');
      } catch {
        throw new AiError(t('dbInvalid', lang));
      }
      if (!text) throw new AiError(t('dbInvalid', lang));
      if (text.length > MAX_DB_EXPLAIN_CONTEXT) throw new AiError(t('dbTooLong', lang));
      let context: unknown;
      try {
        context = JSON.parse(text);
      } catch {
        throw new AiError(t('dbInvalid', lang));
      }
      const target = isObj(context) ? context['target'] : undefined;
      if (!isObj(context) || !isObj(target) || typeof target['name'] !== 'string' || !target['name'].trim()) throw new AiError(t('dbInvalid', lang));
      const allowedPlaces = new Set<string>(['@app', '@api']);
      addText(allowedPlaces, target['name']);
      for (const related of Array.isArray(context['related']) ? context['related'] : []) addText(allowedPlaces, isObj(related) ? related['name'] : null);
      for (const fk of Array.isArray(target['foreignKeys']) ? target['foreignKeys'] : []) addText(allowedPlaces, isObj(fk) ? fk['refTable'] : null);
      for (const ref of Array.isArray(target['referencedBy']) ? target['referencedBy'] : []) addText(allowedPlaces, isObj(ref) ? ref['table'] : null);
      const targetColumns = new Set<string>();
      for (const column of Array.isArray(target['columns']) ? target['columns'] : []) addText(targetColumns, isObj(column) ? column['name'] : null);
      const model = await this.resolveModel();
      const user = `Contexto de la base de datos y del proyecto (JSON):\n${json(context)}`;
      const run = await this.runJson('DB_EXPLAIN', systemFor('DB_EXPLAIN', lang), () => user, (root) => {
        const parsed = parseDbExplain(root, allowedPlaces, targetColumns);
        return parsed.steps.length ? { errors: [], value: parsed } : { errors: ['$.steps: sin pasos validos (title o text)'] };
      }, { model, token: cts.token, language: lang });
      const parsed = run.value as { summary: string | null; steps: Obj[] };
      return { success: true, codigo: 'OK', mensaje: 'Explicacion generada.', summary: parsed.summary, steps: parsed.steps };
    } catch (error: unknown) {
      if (error instanceof AiError && error.message === t('schema', lang)) throw new AiError(t('dbBadOutput', lang));
      throw error;
    } finally {
      this.end(id, cts);
    }
  }

  /* ------------------------------ generar flujo ------------------------------ */

  private async selectFiles(model: vscode.LanguageModelChat, input: { mapText: string; question: string; activePath: string | null }, token: vscode.CancellationToken, lang: NexoLanguage): Promise<string[]> {
    const tail = `${input.activePath ? `## ARCHIVO ACTIVO\n${input.activePath}\n\n` : ''}## PETICION\n${input.question}${JSON_TAIL}`;
    const build: UserBuilder = (maxChars) => {
      let map = input.mapText;
      const head = '## MAPA DEL PROYECTO\n';
      const room = maxChars - head.length - tail.length - 2;
      if (map.length > room) map = map.slice(0, Math.max(0, room - TRUNC.length)) + TRUNC;
      return `${head}${map}\n\n${tail}`;
    };
    const run = await this.runJson('FILE_SELECT', systemFor('FILE_SELECT'), build, (root) => {
      const files = root['files'];
      if (!Array.isArray(files) || !files.length) return { errors: ['$.files: debe ser un array de 3 a 12 rutas del mapa'] };
      const paths = files.filter((f): f is string => typeof f === 'string').map((f) => f.trim().replace(/^\.\//, '')).filter((f) => !!f);
      return { errors: paths.length ? [] : ['$.files: rutas vacias'], value: paths.slice(0, 12) };
    }, { model, token, language: lang });
    return run.value as string[];
  }

  /** Token con tiempo máximo global (300 s) unido al token externo. */
  private globalToken(token: vscode.CancellationToken): { cts: vscode.CancellationTokenSource; timedOut: () => boolean; dispose: () => void } {
    const cts = new vscode.CancellationTokenSource();
    const link = linked(token, cts);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cts.cancel();
    }, GENERATION_TIMEOUT_MS);
    return {
      cts,
      timedOut: () => timedOut,
      dispose: () => {
        clearTimeout(timer);
        link.dispose();
        cts.dispose();
      },
    };
  }

  /**
   * Modo agente (FLOW y PROPOSE): el modelo investiga por su cuenta todas las carpetas con `traza_search`, `traza_read` y
   * `traza_list` (solo lectura); el contexto semilla es solo un punto de partida. Los límites son de presupuesto (rondas,
   * llamadas, caracteres y tiempo), nunca de carpetas o archivos. Devuelve el valor con el formato comprobado (hasta
   * MAX_FORMAT_ATTEMPTS intentos; después, error), o `null` para ejecutar el modo clásico ante fallos de transporte,
   * API o herramientas y ante «sin respuesta final». Cancelación y timeout se relanzan.
   */
  private async runAgent(args: {
    op: 'FLOW' | 'PROPOSE' | 'UI_MOCK' | 'DB_MAP_SQL';
    model: vscode.LanguageModelChat;
    token: vscode.CancellationToken;
    lang: NexoLanguage;
    progress?: (message: string) => void;
    seed: (session: AgentToolSession) => Promise<FlowContext>;
    build: (context: FlowContext, session: AgentToolSession) => UserBuilder;
    check: (root: Obj) => Validation | Promise<Validation>;
    /** Presupuesto de tiempo de investigación (por defecto `AGENT_TIME_MS`). */
    timeMs?: number;
    keep?: KeepFn;
  }): Promise<unknown> {
    const { op, model, token, lang } = args;
    const log = trazaLog();
    const started = Date.now();
    let rounds = 0;
    let convChars = 0;
    let stage = 'semilla';
    const timeLimit = args.timeMs ?? AGENT_TIME_MS;
    const say = (es: string, en: string): void => args.progress?.(lang === 'en' ? en : es);
    const sayGenerating = (): void => {
      if (op === 'UI_MOCK') say('Maquetando la pantalla…', 'Building the screen mockup…');
      else if (op === 'DB_MAP_SQL') say('Construyendo el mapa de datos…', 'Building the data map…');
      else if (op === 'FLOW') say('Generando el flujo…', 'Generating the flow…');
      else say('Proponiendo el cambio…', 'Proposing the change…');
    };
    try {
      const session = new AgentToolSession({ token, lang, progress: args.progress });
      await session.init();
      const context = await args.seed(session);
      for (const fragment of context.fragments) session.markRead(fragment.path, fragment.startLine, fragment.endLine);
      if (context.active) session.markRead(context.active.path, context.active.startLine, context.active.endLine);
      const system = systemFor(op, 'es', true);
      const user = await this.fitUser(model, system, args.build(context, session), AGENT_SEED_CHARS, token);
      const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(system), vscode.LanguageModelChatMessage.User(user)];
      const budget = Math.floor((model.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS) * TOKEN_BUDGET_RATIO) * CHARS_PER_TOKEN;
      convChars = system.length + user.length;
      let totalCalls = 0;
      let fixes = 0;
      let finishing = false;
      let empties = 0;
      const outOfBudget = (): boolean => rounds >= AGENT_MAX_ROUNDS - 1 || totalCalls >= AGENT_MAX_CALLS
        || Date.now() - started >= timeLimit || budget - convChars < AGENT_RESERVE_CHARS + AGENT_MIN_RESULT_CHARS;
      const finish = (end: string): void => log.info(`Agente · ${op} · rondas=${rounds} · ${session.summary()} · conversación=${convChars} · fin=${end}`);
      if (op === 'UI_MOCK') say('Buscando la vista y sus estilos…', 'Looking for the view and its styles…');
      else if (op === 'DB_MAP_SQL') say('Buscando las sentencias SQL y las entidades…', 'Looking for the SQL statements and entities…');
      else say('Investigando el código en todas las carpetas…', 'Investigating the code in all folders…');
      while (rounds < AGENT_MAX_ROUNDS) {
        if (token.isCancellationRequested) throw new Error('cancelled');
        if (!finishing && outOfBudget()) {
          finishing = true;
          messages.push(vscode.LanguageModelChatMessage.User(AGENT_BUDGET_NOTE));
          convChars += AGENT_BUDGET_NOTE.length;
        }
        rounds++;
        stage = `ronda ${rounds}`;
        const reply = await this.callTools(model, messages, finishing ? undefined : AGENT_TOOLS, token, lang, true);
        if (!reply.calls.length && !reply.text.trim()) {
          if (empties < 1) {
            empties++;
            messages.push(vscode.LanguageModelChatMessage.User(AGENT_EMPTY_NOTE));
            convChars += AGENT_EMPTY_NOTE.length;
            continue;
          }
          log.warn(`Agente · ${op} · modo clásico (respuesta vacía · otras=${reply.other})`);
          return null;
        }
        if (reply.calls.length) {
          messages.push(vscode.LanguageModelChatMessage.Assistant([
            ...(reply.text ? [new vscode.LanguageModelTextPart(reply.text)] : []), ...reply.calls,
          ]));
          convChars += reply.text.length + reply.calls.reduce((n, call) => n + call.name.length + json(call.input).length, 0);
          const parts: vscode.LanguageModelToolResultPart[] = [];
          let inRound = 0;
          let exhausted = false;
          for (const call of reply.calls) {
            let out: string;
            if (finishing) {
              out = 'omitida: investigación terminada; responde con el JSON final';
            } else if (inRound >= AGENT_MAX_CALLS_PER_ROUND || totalCalls >= AGENT_MAX_CALLS) {
              out = 'omitida: límite de llamadas';
            } else {
              const maxChars = Math.min(AGENT_TOOL_RESULT_CHARS, budget - convChars - AGENT_RESERVE_CHARS);
              if (maxChars < AGENT_MIN_RESULT_CHARS) {
                out = 'omitida: presupuesto agotado';
                exhausted = true;
              } else {
                inRound++;
                totalCalls++;
                out = await session.invoke(call.name, call.input, maxChars);
              }
            }
            convChars += out.length;
            parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(out)]));
          }
          // El modo «Auto» de Copilot enruta por el texto del último mensaje de usuario: sin texto falla
          // («Auto mode needs a prompt»), así que los resultados van siempre acompañados de una indicación.
          const closing = !finishing && (exhausted || outOfBudget());
          if (closing) finishing = true;
          const note = closing ? AGENT_BUDGET_NOTE : AGENT_CONTINUE_NOTE;
          messages.push(vscode.LanguageModelChatMessage.User([...parts, new vscode.LanguageModelTextPart(note)]));
          convChars += note.length;
          sayGenerating();
          continue;
        }

        const answer = reply.text;
        let errors: string[] = [];
        let value: unknown = null;
        let root: Obj | null = null;
        try {
          root = parseModelJson(answer);
        } catch (error: unknown) {
          errors = [`$: la respuesta no es un objeto JSON valido (${error instanceof Error ? error.message : ''})`];
        }
        if (root) {
          const result = await args.check(root);
          value = result.value ?? root;
          errors = [...result.errors];
        }
        if (!errors.length) {
          finish(finishing ? 'presupuesto' : 'ok');
          args.keep?.([...messages, vscode.LanguageModelChatMessage.Assistant(cut(answer, MAX_RETRY_ASSISTANT_CHARS))], convChars + Math.min(answer.length, MAX_RETRY_ASSISTANT_CHARS));
          return value;
        }
        if (fixes < AGENT_MAX_FIXES && rounds < AGENT_MAX_ROUNDS) {
          let note = formatFeedback(FORMAT_DEFINITION[op] ?? null, errors, fixes + 2, MAX_FORMAT_ATTEMPTS);
          fixes++;
          log.warn(`Agente · ${op} · formato no legible · reintento ${fixes} de ${AGENT_MAX_FIXES}`);
          if (!finishing) note += '\nPuedes usar las herramientas si lo necesitas.';
          if (!finishing && outOfBudget()) {
            finishing = true;
            note += `\n${AGENT_BUDGET_NOTE}`;
          }
          messages.push(vscode.LanguageModelChatMessage.Assistant(cut(answer, MAX_RETRY_ASSISTANT_CHARS)));
          messages.push(vscode.LanguageModelChatMessage.User(note));
          convChars += Math.min(answer.length, MAX_RETRY_ASSISTANT_CHARS) + note.length;
          sayGenerating();
          continue;
        }
        logValidation(op, model, fixes + 1, answer, errors);
        log.warn(`Agente · ${op} · formato no legible tras ${fixes + 1} intentos`);
        throw new AiError(t('schema', lang));
      }
      log.warn(`Agente · ${op} · modo clásico (sin respuesta final)`);
      return null;
    } catch (error: unknown) {
      if (isCancelled(error) || token.isCancellationRequested) throw error;
      if (error instanceof AiError && [t('timeout', lang), t('noPermissions', lang), t('blocked', lang), t('modelMissing', lang), t('schema', lang)].includes(error.message)) throw error;
      const name = error instanceof Error ? error.name : 'Error';
      const reason = `Agente · ${op} · modo clásico (${name}: ${logSafe(error instanceof Error ? error.message : String(error))} · etapa=${stage})`;
      log.warn(reason);
      console.warn('[Traza] Modo agente no disponible; modo clásico.', reason);
      return null;
    }
  }

  private remember(generated: GeneratedFlow): void {
    const id = generated.flow['id'];
    if (typeof id !== 'string') return;
    this.recent.delete(id);
    this.recent.set(id, generated);
    while (this.recent.size > MAX_RECENT_FLOWS) {
      const oldest = this.recent.keys().next();
      if (oldest.done) break;
      this.recent.delete(oldest.value);
      this.proposals.delete(oldest.value);
    }
  }

  /** Genera un `FlowDiagram` con el contexto local (mapa, selección de archivos, fragmentos y archivo activo). */
  async generateFlow(options: GenerateFlowOptions): Promise<GeneratedFlow> {
    const lang = language();
    const question = options.question.trim();
    if (!question || question.length > MAX_QUESTION_CHARS) throw new AiError(t('question', lang));
    if (!(vscode.workspace.workspaceFolders ?? []).length) throw new AiError(t('noFolders', lang));
    const model = await this.resolveModel(options.model);
    const global = this.globalToken(options.token);
    const token = global.cts.token;
    try {
      const masked = maskSensitiveText(question);
      const flowCheck = (root: Obj): Validation => {
        clampToSchema('FlowDiagram', root, FLOW_KEEP_ARRAYS);
        dropInvalidScenario(root);
        const errors = validate('FlowDiagram', root);
        return { errors: errors.length ? errors : flowSemantics(root) };
      };
      const log = trazaLog();
      const pinnedHints = (session: AgentToolSession): string[] => options.pinned.map((p) => session.pathOfUri(p.uri)).filter((p): p is string => !!p);
      const classicContext = (folder: string | undefined, tk: vscode.CancellationToken): Promise<FlowContext> => collectFlowContext({
        question: masked,
        pinned: options.pinned,
        useActiveEditor: options.useActiveEditor,
        ...(folder ? { folder } : {}),
        token: tk,
        progress: options.progress,
        log,
        selectFiles: (input) => this.selectFiles(model, input, tk, lang),
      });
      let generated: unknown = null;
      let kept = null as { messages: vscode.LanguageModelChatMessage[]; chars: number } | null;
      const keep: KeepFn | undefined = options.keepAnswerSeed ? (messages, chars) => { kept = { messages, chars }; } : undefined;
      if (this.agentCapable(model)) {
        generated = await this.runAgent({
          op: 'FLOW', model, token, lang, progress: options.progress, ...(keep ? { keep } : {}),
          seed: (): Promise<FlowContext> => collectFlowContext({
            question: masked, pinned: options.pinned, useActiveEditor: options.useActiveEditor, token, progress: options.progress, log,
          }),
          build: (context, session) => fitFlowText({
            mode: 'FLOW', question: masked, context, lang, scenarioHint: options.scenario === true,
            overview: session.overview(), ...(options.folder ? { focusFolder: options.folder } : {}),
            hintFiles: pinnedHints(session),
          }),
          check: flowCheck,
        });
      }
      if (generated === null) {
        const context = await classicContext(options.folder, token);
        options.progress?.(lang === 'en' ? 'Generating the flow…' : 'Generando el flujo…');
        const build = fitFlowText({ mode: 'FLOW', question: masked, context, lang, scenarioHint: options.scenario === true });
        generated = (await this.runJson('FLOW', systemFor('FLOW'), build, flowCheck, { model, token, language: lang, ...(keep ? { keep } : {}) })).value;
      }

      const flow: Obj = { ...(generated as Obj) };
      flow['id'] = crypto.randomUUID();
      flow['model'] = modelLabel(model);
      flow['generatedAt'] = new Date().toISOString();
      flow['question'] = question;
      if (options.keepAnswerSeed) {
        this.saveSeed(flow['id'], { kind: 'FLOW', messages: kept?.messages ?? null, chars: kept?.chars ?? 0, data: flow, question: masked, lang, expires: 0 });
      }
      const title = typeof flow['title'] === 'string' && flow['title'].trim() ? flow['title'].trim().slice(0, 60) : 'Sin título';
      this.last = {
        flow, title, model: modelLabel(model), scenarioAsked: options.scenario === true,
        ...(options.folder ? { folder: options.folder } : {}),
      };
      this.remember(this.last);
      return this.last;
    } catch (error: unknown) {
      if (global.timedOut()) throw new AiError(t('timeout', lang));
      if (isCancelled(error) || options.token.isCancellationRequested) throw new Error('cancelled');
      throw error;
    } finally {
      global.dispose();
    }
  }

  /* ------------------------------ proponer cambio ------------------------------ */

  /** Propone un `ChangeProposal` sobre el flujo abierto (o devuelve `{answer}` si la IA pide aclaración). */
  async proposeChange(options: ProposeChangeOptions): Promise<ProposeResult> {
    const lang = language();
    const question = options.question.trim();
    if (!question || question.length > MAX_QUESTION_CHARS) throw new AiError(t('question', lang));
    if (!isObj(options.flow)) throw new AiError(t('invalid', lang));
    const flow = options.flow;
    const model = await this.resolveModel(options.model);
    const global = this.globalToken(options.token);
    const token = global.cts.token;
    try {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const multi = folders.length > 1;
      const mountIds = new Set(folders.map((f) => f.name));
      const refs: unknown[] = [
        ...(Array.isArray(flow['steps']) ? flow['steps'].map((s) => (isObj(s) ? s['ref'] : null)) : []),
        ...(Array.isArray(flow['files']) ? flow['files'] : []),
      ];
      const pinnedPaths: string[] = [];
      for (const ref of refs) {
        if (!isObj(ref) || typeof ref['file'] !== 'string' || !ref['file']) continue;
        const mountId = typeof ref['mountId'] === 'string' ? ref['mountId'] : '';
        const path = multi && mountId ? `${mountId}/${ref['file']}` : ref['file'];
        if (!pinnedPaths.includes(path)) pinnedPaths.push(path);
      }
      const masked = maskSensitiveText(question);
      const activeFlow = json(stripFlow(flow));
      const proposeCheck = async (raw: Obj): Promise<Validation> => {
        let root: Obj = raw;
        let files = root['files'];
        if (files === undefined || files === null) {
          // El modelo a veces envuelve la propuesta ({"change": {...}}, {"ChangeProposal": {...}}): se desenvuelve.
          for (const key of ['change', 'proposal', 'changeProposal', 'ChangeProposal']) {
            const inner = root[key];
            if (isObj(inner) && 'files' in inner) {
              root = inner;
              files = inner['files'];
              break;
            }
          }
        }
        if (files === undefined || files === null) {
          const answer = txt(root['answer']).trim();
          if (answer) return { errors: [], value: { answer: cut(answer, 20_000) } };
          return { errors: ['$: falta "files" en la raiz del JSON (cambio propuesto, sin envolverlo en otra clave) o "answer" (aclaracion)'] };
        }
        const change: Obj = { ...root };
        delete change['answer'];
        change['id'] = crypto.randomUUID();
        change['request'] = cut(question, MAX_QUESTION_CHARS);
        clampToSchema('ChangeProposal', change, PROPOSE_KEEP_ARRAYS);
        let errors = validate('ChangeProposal', change);
        if (!errors.length) errors = proposeSemantics(change, mountIds);
        if (!errors.length) errors = await this.privateFileErrors(change, multi);
        return errors.length ? { errors } : { errors: [], value: { change } };
      };
      let proposed: unknown = null;
      let kept = null as { messages: vscode.LanguageModelChatMessage[]; chars: number } | null;
      const keep: KeepFn | undefined = options.keepAnswerSeed ? (messages, chars) => { kept = { messages, chars }; } : undefined;
      if (this.agentCapable(model)) {
        proposed = await this.runAgent({
          op: 'PROPOSE', model, token, lang, progress: options.progress, ...(keep ? { keep } : {}),
          seed: (): Promise<FlowContext> => collectFlowContext({
            question: masked, pinned: options.pinned ?? [], pinnedPaths, useActiveEditor: false, token, progress: options.progress, log: trazaLog(),
            prioritizeRequest: true,
          }),
          build: (context, session) => fitFlowText({
            mode: 'PROPOSE', question: masked, context, activeFlow, lang,
            overview: session.overview(), hintFiles: pinnedPaths.slice(0, AGENT_MAX_HINT_FILES),
          }),
          check: proposeCheck,
        });
      }
      if (proposed === null) {
        const context = await collectFlowContext({
          question: masked, pinned: options.pinned ?? [], pinnedPaths, useActiveEditor: false, token, progress: options.progress, log: trazaLog(),
          selectFiles: (input) => this.selectFiles(model, input, token, lang), prioritizeRequest: true,
        });
        options.progress?.(lang === 'en' ? 'Proposing the change…' : 'Proponiendo el cambio…');
        const build = fitFlowText({ mode: 'PROPOSE', question: masked, context, activeFlow, lang });
        proposed = (await this.runJson('PROPOSE', systemFor('PROPOSE'), build, proposeCheck, { model, token, language: lang, ...(keep ? { keep } : {}) })).value;
      }
      const value = proposed as { answer?: string; change?: Obj };
      if (typeof value.answer === 'string') return { answer: value.answer };
      const proposal: Obj = { ...(value.change as Obj) };
      proposal['id'] = crypto.randomUUID();
      proposal['request'] = question;
      proposal['flowId'] = typeof flow['id'] === 'string' ? flow['id'] : null;
      const cases = sanitizeProposalCases(proposal['cases'], flow);
      if (cases.length) proposal['cases'] = cases;
      else delete proposal['cases'];
      proposal['createdAt'] = new Date().toISOString();
      if (options.keepAnswerSeed) {
        this.saveSeed(proposal['id'], { kind: 'PROPOSE', messages: kept?.messages ?? null, chars: kept?.chars ?? 0, data: proposal, question: masked, lang, expires: 0 });
      }
      return { proposal, model: modelLabel(model) };
    } catch (error: unknown) {
      if (global.timedOut()) throw new AiError(t('timeout', lang));
      if (isCancelled(error) || options.token.isCancellationRequested) throw new Error('cancelled');
      throw error;
    } finally {
      global.dispose();
    }
  }

  /* ------------------------------ respuesta en texto del chat ------------------------------ */

  private saveSeed(id: unknown, seed: AnswerSeed): void {
    if (typeof id !== 'string' || !id) return;
    const now = Date.now();
    for (const [key, value] of this.answerSeeds) if (value.expires <= now) this.answerSeeds.delete(key);
    this.answerSeeds.delete(id);
    this.answerSeeds.set(id, { ...seed, expires: now + ANSWER_SEED_TTL_MS });
    while (this.answerSeeds.size > ANSWER_SEED_MAX) {
      const oldest = this.answerSeeds.keys().next();
      if (oldest.done) break;
      this.answerSeeds.delete(oldest.value);
    }
  }

  private takeSeed(id: string): AnswerSeed | null {
    const seed = this.answerSeeds.get(id);
    this.answerSeeds.delete(id);
    return seed && seed.expires > Date.now() ? seed : null;
  }

  /**
   * Redacta en streaming la respuesta en texto del chat (`@traza`) para el flujo o la propuesta `id`. Si el modelo admite
   * herramientas, puede investigar antes de redactar (solo lectura, mismas reglas que el agente, presupuesto acotado y una
   * ronda final sin herramientas); si no, o si esa fase falla sin haber emitido texto con un error no fatal, vuelve a la
   * respuesta sin herramientas. Orden de intentos: conversación del agente (si cabe en el presupuesto) y después datos del
   * flujo. `progress` informa de la investigación y de la redacción. Sin semilla (caducada o ya usada) no llama al modelo.
   * Cancelación y errores se relanzan; no se cachea.
   */
  async streamAnswer(o: {
    id: string;
    model?: vscode.LanguageModelChat;
    token: vscode.CancellationToken;
    onText: (chunk: string) => void;
    progress?: (message: string) => void;
  }): Promise<{ ok: boolean; chars: number }> {
    const seed = this.takeSeed(o.id);
    if (!seed) return { ok: false, chars: 0 };
    const { kind, lang } = seed;
    const log = trazaLog();
    const started = Date.now();
    const model = await this.resolveModel(o.model);
    const tools = this.agentCapable(model);
    const noteTools = answerNote(kind, seed.question, lang, true);
    const notePlain = answerNote(kind, seed.question, lang, false);
    const budgetChars = Math.floor((model.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS) * TOKEN_BUDGET_RATIO) * CHARS_PER_TOKEN;
    const attempts: { source: 'conversación' | 'datos'; tools: boolean }[] = [];
    if (tools) {
      if (seed.messages && seed.chars + noteTools.length + AGENT_RESERVE_CHARS + AGENT_MIN_RESULT_CHARS <= budgetChars) attempts.push({ source: 'conversación', tools: true });
      attempts.push({ source: 'datos', tools: true }, { source: 'datos', tools: false });
    } else {
      if (seed.messages && seed.chars + notePlain.length <= budgetChars) attempts.push({ source: 'conversación', tools: false });
      attempts.push({ source: 'datos', tools: false });
    }
    const resume = kind === 'FLOW'
      ? (lang === 'en' ? 'Writing the answer…' : 'Redactando la respuesta…')
      : (lang === 'en' ? 'Writing the explanation…' : 'Redactando la explicación…');
    let emitted = 0;
    const onText = (chunk: string): void => {
      emitted += chunk.length;
      o.onText(chunk);
    };
    /** Emisión con tope `MAX_ANSWER_CHARS` (corta con «…»); devuelve `false` al alcanzarlo. */
    const emitCapped = (chunk: string): boolean => {
      const room = MAX_ANSWER_CHARS - emitted;
      if (chunk.length > room) {
        if (room > 0) onText(chunk.slice(0, room));
        onText('…');
        emitted = MAX_ANSWER_CHARS;
        return false;
      }
      onText(chunk);
      return true;
    };
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const note = attempt.tools ? noteTools : notePlain;
      let messages: vscode.LanguageModelChatMessage[];
      let convChars: number;
      if (attempt.source === 'conversación' && seed.messages) {
        messages = [...seed.messages, vscode.LanguageModelChatMessage.User(note)];
        convChars = seed.chars + note.length;
      } else {
        const data = `${kind === 'FLOW' ? 'FLUJO' : 'PROPUESTA'}:\n${cut(json(stripFlow(seed.data, true)), ANSWER_DATA_CHARS)}\n\n${note}`;
        messages = [vscode.LanguageModelChatMessage.User(ANSWER_SYSTEM), vscode.LanguageModelChatMessage.User(data)];
        convChars = ANSWER_SYSTEM.length + data.length;
      }
      try {
        let rounds = 1;
        let summary = '';
        let end = 'ok';
        let chars: number;
        if (attempt.tools) {
          const info = await this.answerWithTools({ model, messages, convChars, token: o.token, lang, emit: emitCapped, progress: o.progress, resume });
          chars = emitted;
          rounds = info.rounds;
          summary = info.summary;
          end = info.end;
        } else {
          chars = await this.streamCall(model, messages, o.token, lang, onText);
        }
        log.info(['Respuesta', kind, `origen=${attempt.source}`, `herramientas=${attempt.tools ? 'sí' : 'no'}`, `rondas=${rounds}`, summary,
          `${chars} caracteres`, `${Date.now() - started} ms`, `fin=${end}`].filter(Boolean).join(' · '));
        return { ok: chars > 0, chars };
      } catch (error: unknown) {
        if (isCancelled(error) || o.token.isCancellationRequested) throw error;
        const name = error instanceof Error ? error.name : 'Error';
        const detail = logSafe(error instanceof Error ? error.message : String(error));
        const fatal = error instanceof AiError
          && [t('noPermissions', lang), t('blocked', lang), t('modelMissing', lang), t('timeout', lang)].includes(error.message);
        if (i < attempts.length - 1 && emitted === 0 && !fatal) {
          log.warn(`Respuesta · ${kind} · ${attempt.source}${attempt.tools ? '+herramientas' : ''} rechazada (${name}: ${detail}) · siguiente intento`);
          continue;
        }
        log.warn(`Respuesta · ${kind} · sin respuesta (${name}: ${detail})`);
        throw error;
      }
    }
    throw new AiError(t('failed', lang));
  }

  /**
   * Fase de respuesta con herramientas (`traza_search`/`traza_read`/`traza_list`, solo lectura, vía `AgentToolSession`):
   * rondas acotadas (rondas, llamadas, tiempo y caracteres); la última ronda va sin herramientas. El texto que acompaña a
   * llamadas se retiene y solo se muestra si supera `ANSWER_HOLD_CHARS`; la ronda final va en streaming directo.
   * `emit` devuelve `false` al alcanzar el tope de la respuesta. Lanza si no se emitió ningún texto.
   */
  private async answerWithTools(a: {
    model: vscode.LanguageModelChat;
    messages: vscode.LanguageModelChatMessage[];
    convChars: number;
    token: vscode.CancellationToken;
    lang: NexoLanguage;
    emit: (chunk: string) => boolean;
    progress?: (message: string) => void;
    resume: string;
  }): Promise<{ rounds: number; summary: string; end: string }> {
    const { model, messages, token, lang } = a;
    const session = new AgentToolSession({ token, lang, progress: a.progress });
    await session.init();
    const budget = Math.floor((model.maxInputTokens || DEFAULT_MAX_INPUT_TOKENS) * TOKEN_BUDGET_RATIO) * CHARS_PER_TOKEN;
    const started = Date.now();
    let convChars = a.convChars;
    let rounds = 0;
    let totalCalls = 0;
    let finishing = false;
    let empties = 0;
    let emittedAny = false;
    let end = 'presupuesto';
    const outOfBudget = (): boolean => rounds >= ANSWER_MAX_ROUNDS - 1 || totalCalls >= ANSWER_MAX_CALLS
      || Date.now() - started >= ANSWER_TIME_MS || budget - convChars < AGENT_RESERVE_CHARS + AGENT_MIN_RESULT_CHARS;
    while (rounds < ANSWER_MAX_ROUNDS) {
      if (token.isCancellationRequested) throw new Error('cancelled');
      if (!finishing && outOfBudget()) {
        finishing = true;
        messages.push(vscode.LanguageModelChatMessage.User(ANSWER_BUDGET_NOTE));
        convChars += ANSWER_BUDGET_NOTE.length;
      }
      rounds++;
      let held = '';
      let live = finishing;
      let capped = false;
      let roundEmitted = false;
      const push = (chunk: string): boolean => {
        const text = emittedAny && !roundEmitted ? `\n\n${chunk}` : chunk;
        roundEmitted = true;
        if (text.trim()) emittedAny = true;
        if (a.emit(text)) return true;
        capped = true;
        return false;
      };
      const onPart = (chunk: string): boolean => {
        if (live) return push(chunk);
        held += chunk;
        if (held.trim().length < ANSWER_HOLD_CHARS) return true;
        live = true;
        const pending = held;
        held = '';
        return push(pending);
      };
      const reply = await this.callTools(model, messages, finishing ? undefined : AGENT_TOOLS, token, lang, true, onPart);
      if (!reply.calls.length && !reply.text.trim()) {
        if (empties < 1) {
          empties++;
          messages.push(vscode.LanguageModelChatMessage.User(ANSWER_EMPTY_NOTE));
          convChars += ANSWER_EMPTY_NOTE.length;
          continue;
        }
        throw new AiError(t('empty', lang).replace('{model}', modelLabel(model)));
      }
      if (capped || !reply.calls.length) {
        if (!capped && !live && held.trim()) push(held);
        end = capped ? 'tope' : finishing ? 'presupuesto' : 'ok';
        break;
      }
      messages.push(vscode.LanguageModelChatMessage.Assistant([
        ...(reply.text ? [new vscode.LanguageModelTextPart(reply.text)] : []), ...reply.calls,
      ]));
      convChars += reply.text.length + reply.calls.reduce((n, call) => n + call.name.length + json(call.input).length, 0);
      const parts: vscode.LanguageModelToolResultPart[] = [];
      let inRound = 0;
      let exhausted = false;
      for (const call of reply.calls) {
        let out: string;
        if (finishing) {
          out = 'omitida: investigación terminada; responde con la respuesta final';
        } else if (inRound >= AGENT_MAX_CALLS_PER_ROUND || totalCalls >= ANSWER_MAX_CALLS) {
          out = 'omitida: límite de llamadas';
        } else {
          const maxChars = Math.min(AGENT_TOOL_RESULT_CHARS, budget - convChars - AGENT_RESERVE_CHARS);
          if (maxChars < AGENT_MIN_RESULT_CHARS) {
            out = 'omitida: presupuesto agotado';
            exhausted = true;
          } else {
            inRound++;
            totalCalls++;
            out = await session.invoke(call.name, call.input, maxChars);
          }
        }
        convChars += out.length;
        parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(out)]));
      }
      if (!finishing && (exhausted || outOfBudget())) finishing = true;
      // El modo «Auto» de Copilot enruta por el texto del último mensaje de usuario: sin texto falla, así que los
      // resultados van siempre acompañados de una nota.
      const note = finishing ? ANSWER_BUDGET_NOTE : ANSWER_CONTINUE_NOTE;
      messages.push(vscode.LanguageModelChatMessage.User([...parts, new vscode.LanguageModelTextPart(note)]));
      convChars += note.length;
      a.progress?.(a.resume);
    }
    if (!emittedAny) throw new AiError(t('empty', lang).replace('{model}', modelLabel(model)));
    return { rounds, summary: session.summary(), end };
  }

  /** Como `call`, pero sin herramientas y emitiendo cada fragmento de texto; tope `MAX_ANSWER_CHARS` (corta con «…»). Devuelve los caracteres emitidos. */
  private async streamCall(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    lang: NexoLanguage,
    onText: (chunk: string) => void,
  ): Promise<number> {
    const cts = new vscode.CancellationTokenSource();
    const link = linked(token, cts);
    let timedOut = false;
    let capped = false;
    let total = 0;
    const timer = setTimeout(() => {
      timedOut = true;
      cts.cancel();
    }, CALL_TIMEOUT_MS);
    try {
      this.showNoticeOnce();
      const response = await model.sendRequest(messages, { justification: t('justification', lang) }, cts.token);
      for await (const chunk of response.text) {
        const room = MAX_ANSWER_CHARS - total;
        if (chunk.length > room) {
          capped = true;
          if (room > 0) onText(chunk.slice(0, room));
          onText('…');
          total = MAX_ANSWER_CHARS;
          cts.cancel();
          break;
        }
        total += chunk.length;
        onText(chunk);
      }
      if (!total) throw new AiError(t('empty', lang).replace('{model}', modelLabel(model)));
      return total;
    } catch (error: unknown) {
      if (capped && !token.isCancellationRequested) return total;
      return this.modelFailure(error, timedOut, token, cts, lang);
    } finally {
      clearTimeout(timer);
      link.dispose();
      cts.dispose();
    }
  }

  /**
   * Seguridad, no contenido: rechaza archivos con claves privadas. Que el diff encaje con el archivo actual, que exista
   * o no exista ya, no se comprueba aquí (la propuesta se dibuja siempre; Aplicar bloquea si no encaja).
   */
  private async privateFileErrors(change: Obj, multi: boolean): Promise<string[]> {
    const errors: string[] = [];
    const files = Array.isArray(change['files']) ? change['files'] : [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as Obj;
      let mountId = txt(file['mountId']).trim();
      let path = txt(file['path']).trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (multi && !mountId) {
        const slash = path.indexOf('/');
        if (slash > 0) {
          mountId = path.slice(0, slash);
          path = path.slice(slash + 1);
        }
      }
      const original = await readMountFile(mountId, path, 'text', MAX_FILE_READ_BYTES);
      if (PRIVATE_KEY_CHECK.test(original ?? '')) errors.push(`$.files[${i}]: archivo no permitido`);
    }
    return errors.slice(0, 20);
  }
}

const PRIVATE_KEY_CHECK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** El flujo activo sin datos solo de frontend ni resultados (`codeSnapshot`, `dbMap`, `scenario`, `verification`). */
const MAX_PROPOSAL_CASES = 3;
const MAX_CASE_LABEL = 28;

/** Casos de la propuesta: preset conocido del flujo o caso nuevo con label e input válidos; lo demás se descarta. */
function sanitizeProposalCases(raw: unknown, flow: Obj): Obj[] {
  if (!Array.isArray(raw)) return [];
  const presets = new Map<string, string>();
  for (const preset of Array.isArray(flow['simulationPresets']) ? flow['simulationPresets'] : []) {
    if (!isObj(preset)) continue;
    const id = txt(preset['id']).trim();
    if (id) presets.set(id, txt(preset['label']).trim());
  }
  const out: Obj[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_PROPOSAL_CASES) break;
    if (!isObj(item)) continue;
    const presetId = typeof item['presetId'] === 'string' ? item['presetId'].trim() : null;
    if (presetId && presetId.length <= 100 && presets.has(presetId)) {
      if (seen.has(presetId)) continue;
      seen.add(presetId);
      out.push({ presetId, label: cut(presets.get(presetId) || presetId, MAX_CASE_LABEL), input: null });
      continue;
    }
    const label = typeof item['label'] === 'string' ? cut(item['label'].trim(), MAX_CASE_LABEL) : '';
    const input = item['input'];
    if (!label || !isObj(input) || json(input).length > MAX_INPUT_CHARS) continue;
    const key = `new:${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ presetId: null, label, input: maskSensitiveJson(input) });
  }
  return out;
}

function stripFlow(flow: Obj, keepScenario = false): unknown {
  const strip = (value: unknown, depth: number): unknown => {
    if (depth > 32) return null;
    if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1));
    if (!isObj(value)) return value;
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'codeSnapshot' || k === 'verification') continue;
      if (depth === 0 && (k === 'dbMap' || (k === 'scenario' && !keepScenario))) continue;
      out[k] = strip(v, depth + 1);
    }
    return out;
  };
  return strip(flow, 0);
}

export { isCancelled };
