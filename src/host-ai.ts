/**
 * IA en el host con el modelo de lenguaje que el usuario ya tiene en VS Code (`vscode.lm`: Copilot, Claude, GPT,
 * BYOK…). Sustituye al backend de Nexo: arma los prompts portados de tejechat, valida la salida (esquema + semántica,
 * con un reintento conversacional) y devuelve las mismas formas que esperan los sanitizadores de la webview.
 * Nunca registra código, prompts, respuestas ni preguntas: solo códigos, tamaños y tiempos.
 */
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { ChangeCompareBody, FlowDiagnosisResponse, FlowKind, FlowRequestBody, NexoLanguage } from '../webview/src/app/bridge/protocol';
import { maskConfigSecrets, maskSensitiveJson, maskSensitiveText } from '../webview/src/app/workspace-code/ai/workspace-code-ai-mask';
import { applyFileChange } from '../webview/src/app/workspace-code/ai/workspace-code-ai-change-patch';
import type { FileChange } from '../webview/src/app/workspace-code/ai/nexo-ia.changes.types';
import { afterWindows, PatchError, type ChangeFile, type CodeWindow } from './ai/change-patcher';
import { systemFor, type PromptOp } from './ai/prompts';
import { validate } from './ai/schema-validator';
import {
  changeDiff, cut, cutCss, dbMapErrors, dropInvalidScenario, flowSemantics, isObj, numbered, parseModelJson, proposeSemantics,
  repairDbMap, semantics, txt, uiPlanErrors,
} from './ai/semantics';
import { collectFlowContext, type ContextFragment, type FlowContext, type PinnedRef } from './host-context';
import { readMountFile } from './host-files';

type Obj = Record<string, unknown>;

let validationLog: vscode.LogOutputChannel | null = null;

/** Diagnóstico en el canal «Nexo»: operación, modelo, tamaño de la respuesta y errores de esquema (nunca su contenido). */
function logValidation(op: PromptOp, model: vscode.LanguageModelChat, attempt: number, text: string, errors: string[]): void {
  validationLog ??= vscode.window.createOutputChannel('Nexo', { log: true });
  const shape = text.trimStart().startsWith('{') ? 'json' : text.includes('{') ? 'texto+json' : 'sin json';
  validationLog.warn(`${op} · ${model.name} (${model.vendor}/${model.family}) · intento ${attempt} · ${text.length} caracteres (${shape})`);
  for (const error of errors.slice(0, 20)) validationLog.warn(`  ${cut(error, 300)}`);
}

/** Nombre visible del modelo: «Auto · claude-fable-5.1» cuando la familia añade información al nombre. */
function modelLabel(model: vscode.LanguageModelChat): string {
  const family = model.family?.trim();
  return family && family.toLowerCase() !== model.name.trim().toLowerCase() ? `${model.name} · ${family}` : model.name;
}

/** Diagnóstico: modelos que VS Code expone a la extensión (nombre, proveedor y familia). */
function logModels(models: readonly vscode.LanguageModelChat[]): void {
  validationLog ??= vscode.window.createOutputChannel('Nexo', { log: true });
  validationLog.info(`Modelos disponibles: ${models.map((m) => `${m.name} (${m.vendor}/${m.family || '-'})`).join(', ') || 'ninguno'}`);
}

const NOTICE_KEY = 'nexo.aiNoticeShown';
const CALL_TIMEOUT_MS = 180_000;
const GENERATION_TIMEOUT_MS = 300_000;
const MAX_RESPONSE_CHARS = 300_000;
const MAX_RETRY_ASSISTANT_CHARS = 40_000;
const DEFAULT_MAX_INPUT_TOKENS = 64_000;
const TOKEN_BUDGET_RATIO = 0.8;
const CHARS_PER_TOKEN = 3;
const CACHE_MAX = 50;
const CACHE_TTL_MS = 15 * 60_000;
const COMPARE_CONCURRENCY = 3;

const MAX_STEPS = 20;
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
const JSON_TAIL = '\n\nResponde con un único objeto json.';
const CHANGE_STATUSES = new Set(['modified', 'added', 'deleted']);
const CHANGE_KINDS = new Set(['context', 'add', 'del']);
const DB_EXPLAIN_KINDS = new Set(['actor', 'request', 'flow', 'insert', 'fill', 'note']);
const ENDPOINT_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/[\w\-/{}.:]{0,120}$/;

const MESSAGES = {
  es: {
    noModels: 'No hay modelos de lenguaje disponibles en VS Code. Instala o inicia sesión en GitHub Copilot u otro proveedor.',
    modelMissing: 'El modelo configurado no está disponible. Usa «Nexo: Elegir modelo».',
    noPermissions: 'No has dado permiso a Nexo para usar el modelo. Vuelve a intentarlo y acepta el permiso.',
    blocked: 'El proveedor ha bloqueado la petición (límite o política). Inténtalo más tarde.',
    failed: 'El modelo no pudo completar la petición.',
    timeout: 'El modelo no respondió a tiempo.',
    schema: 'La respuesta del modelo no tiene el formato esperado.',
    empty: 'El modelo «{model}» no ha devuelto ninguna respuesta. Comprueba que tienes la sesión iniciada en su proveedor o elige otro con «Nexo: Elegir modelo».',
    tooLarge: 'La respuesta del modelo es demasiado grande.',
    invalid: 'El contexto de la petición no es válido.',
    uiTooLarge: 'El contexto de la pantalla es demasiado grande.',
    noFit: 'El cambio no encaja con el código actual.',
    question: `La pregunta es obligatoria y no puede superar ${MAX_QUESTION_CHARS} caracteres.`,
    noFolders: 'Abre una carpeta del proyecto para generar el flujo.',
    dbTooLong: 'El contexto de la tabla es demasiado largo para generar la explicación.',
    dbInvalid: 'El contexto de la tabla no es válido.',
    dbBadOutput: 'La IA no devolvió pasos válidos.',
    justification: 'Nexo envía el código relevante del proyecto (sin archivos sensibles y con secretos enmascarados) a este modelo para generar y simular el flujo.',
    notice: 'Nexo usa el modelo de lenguaje que elijas en VS Code: el código relevante del proyecto (sin archivos sensibles y con secretos enmascarados) se envía al proveedor de ese modelo.',
    pickTitle: 'Nexo: Elegir modelo',
    pickPlaceholder: 'Modelo de VS Code que usará Nexo',
    auto: 'Automático',
    autoDetail: 'Elegir el modelo la próxima vez que se use',
  },
  en: {
    noModels: 'No language models are available in VS Code. Install or sign in to GitHub Copilot or another provider.',
    modelMissing: 'The configured model is not available. Use "Nexo: Elegir modelo".',
    noPermissions: 'You have not allowed Nexo to use the model. Try again and accept the permission.',
    blocked: 'The provider blocked the request (quota or policy). Please try again later.',
    failed: 'The model could not complete the request.',
    timeout: 'The model did not respond in time.',
    schema: 'The model response does not have the expected format.',
    empty: 'The model "{model}" returned no response. Make sure you are signed in to its provider or pick another one with "Nexo: Elegir modelo".',
    tooLarge: 'The model response is too large.',
    invalid: 'The request context is not valid.',
    uiTooLarge: 'The screen context is too large.',
    noFit: 'The change does not fit the current code.',
    question: `The question is required and cannot exceed ${MAX_QUESTION_CHARS} characters.`,
    noFolders: 'Open a project folder to generate the flow.',
    dbTooLong: 'The table context is too long to generate the explanation.',
    dbInvalid: 'The table context is not valid.',
    dbBadOutput: 'The AI did not return valid steps.',
    justification: 'Nexo sends the relevant project code (without sensitive files and with masked secrets) to this model to generate and simulate the flow.',
    notice: 'Nexo uses the language model you choose in VS Code: the relevant project code (without sensitive files and with masked secrets) is sent to that model\'s provider.',
    pickTitle: 'Nexo: Elegir modelo',
    pickPlaceholder: 'VS Code model that Nexo will use',
    auto: 'Automatic',
    autoDetail: 'Choose the model the next time it is used',
  },
} as const;

type MessageKey = keyof typeof MESSAGES.es;

interface Validation {
  errors: string[];
  value?: unknown;
}

interface RunOptions {
  model: vscode.LanguageModelChat;
  token: vscode.CancellationToken;
  language: NexoLanguage;
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
}

export interface GenerateFlowOptions {
  question: string;
  model?: vscode.LanguageModelChat;
  pinned: PinnedRef[];
  useActiveEditor: boolean;
  token: vscode.CancellationToken;
  progress?: (message: string) => void;
}

export interface ProposeChangeOptions {
  question: string;
  flow: unknown;
  model?: vscode.LanguageModelChat;
  pinned?: PinnedRef[];
  token: vscode.CancellationToken;
  progress?: (message: string) => void;
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
  return vscode.workspace.getConfiguration('nexo').get<string>('language') === 'en' ? 'en' : 'es';
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

function composeDiagnosis(flow: unknown, code: CodeWindow[], changeText: string | null, tail: string): string {
  let sb = `## FLUJO\n${json(flow)}\n\n## CODIGO\n`;
  if (!code.length) sb += '(sin codigo)\n';
  for (const f of code) {
    sb += `### ${cut(f.path.trim(), 400)}:L${f.startLine ?? '?'}-L${f.endLine ?? '?'}\n${numbered(f.content, f.startLine)}\n\n`;
  }
  if (changeText) sb += `## CAMBIO PROPUESTO (YA INCLUIDO EN EL CODIGO)\n${changeText}\n\n`;
  return `${sb}\n${tail}`;
}

/** FLUJO + CODIGO + tail, quitando ventanas del final hasta caber en el presupuesto. */
function fitCode(flow: unknown, rawCode: CodeWindow[], changeText: string | null, tail: string): UserBuilder {
  const base = rawCode.filter((f) => f.path.trim() && f.content && f.content.length <= MAX_WINDOW_CHARS).slice(0, MAX_WINDOWS);
  return (maxChars) => {
    const budget = Math.min(Math.max(8000, FLOW_MAX_CONTEXT_CHARS) + tail.length, maxChars);
    const code = [...base];
    let text = composeDiagnosis(flow, code, changeText, tail);
    while (text.length > budget && code.length) {
      code.pop();
      text = composeDiagnosis(flow, code, changeText, tail);
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
}

function composeFlowText(input: FlowTextInput, map: string, fragments: ContextFragment[], activeContent: string | null): string {
  let sb = `## MAPA DEL PROYECTO\n${map || '(vacio)'}\n\n## MONTAJES\n`;
  const mounts = input.context.mounts.slice(0, MAX_MOUNTS);
  for (const m of mounts) sb += `- id=${cut(m.id.trim(), 200)} prefijo=${cut(m.prefix, MAX_PATH)} nombre=${cut(m.name.trim(), 200)}\n`;
  if (!mounts.length) sb += '(ninguno)\n';
  sb += '\n';
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
  return `${sb}\n\n${idiomaTail(input.lang)}`;
}

/** Recorte de tejechat: primero fragmentos del final, luego el mapa y luego el archivo activo. */
function fitFlowText(input: FlowTextInput): UserBuilder {
  return (maxChars) => {
    const max = Math.min(Math.max(8000, FLOW_MAX_CONTEXT_CHARS), maxChars);
    let map = input.context.mapText.trim();
    const fragments = [...input.context.fragments];
    let activeContent = input.context.active ? input.context.active.content : null;
    let text = composeFlowText(input, map, fragments, activeContent);
    while (text.length > max && fragments.length) {
      fragments.pop();
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

function decodeUiPlan(ctx: Obj): { input: Obj; change: Obj | null; htmlTexts: string[] } {
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
  const htmlTexts = [html.content, ...children.map((c) => (c['html'] as UiFile).content).filter((h) => !!h)];
  return {
    input: { component, children, globalCss: maskSensitiveText(globalCss), simulation: maskSensitiveJson(simulation) },
    change: change === null ? null : (maskSensitiveJson(change) as Obj),
    htmlTexts,
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

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Almacén seguro de la extensión (contraseñas de base de datos). */
  get secrets(): vscode.SecretStorage {
    return this.context.secrets;
  }

  /** Último flujo generado (comando o `@nexo`), para «Abrir flujo». */
  get lastGenerated(): GeneratedFlow | null {
    return this.last;
  }

  /* ------------------------------ modelo ------------------------------ */

  private configuredModel(): { vendor?: string; family?: string; id?: string } | null {
    const raw = vscode.workspace.getConfiguration('nexo').get<unknown>('model');
    if (!isObj(raw)) return null;
    const pick = (k: string): string | undefined => (typeof raw[k] === 'string' && (raw[k] as string).trim() ? (raw[k] as string).trim() : undefined);
    const out = { vendor: pick('vendor'), family: pick('family'), id: pick('id') };
    return out.vendor || out.family || out.id ? out : null;
  }

  private async saveModel(model: vscode.LanguageModelChat | null): Promise<void> {
    const value = model ? { vendor: model.vendor, family: model.family, id: model.id } : undefined;
    await vscode.workspace.getConfiguration('nexo').update('model', value, vscode.ConfigurationTarget.Global);
  }

  /**
   * Modelo a usar: el preferido (chat), el del ajuste (`id`, o `vendor`/`family`) o, con el ajuste vacío, el que se
   * elija en el QuickPick (se guarda; con un único modelo se usa sin preguntar). Cancelar el QuickPick → `cancelled`.
   */
  async resolveModel(preferred?: vscode.LanguageModelChat): Promise<vscode.LanguageModelChat> {
    if (preferred) return preferred;
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

  /** Comando «Nexo: Elegir modelo». */
  async selectModelCommand(): Promise<void> {
    try {
      const choice = await this.pickModel();
      if (choice === undefined) return;
      await this.saveModel(choice === 'auto' ? null : choice);
      void vscode.window.showInformationMessage(choice === 'auto' ? `Nexo: ${t('auto')}` : `Nexo: ${choice.name}`);
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
      console.warn('[Nexo] countTokens no disponible.', error instanceof Error ? error.name : '');
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
      if (error instanceof AiError) throw error;
      if (timedOut) throw new AiError(t('timeout', lang));
      if (token.isCancellationRequested || cts.token.isCancellationRequested) throw new Error('cancelled');
      if (error instanceof vscode.LanguageModelError) {
        console.warn('[Nexo] Error del modelo.', error.code || error.name);
        if (error.code === vscode.LanguageModelError.NoPermissions().code) throw new AiError(t('noPermissions', lang));
        if (error.code === vscode.LanguageModelError.Blocked().code) throw new AiError(t('blocked', lang));
        if (error.code === vscode.LanguageModelError.NotFound().code) throw new AiError(t('modelMissing', lang));
        throw new AiError(`${t('failed', lang)} ${cut(error.message || '', 200)}`.trim());
      }
      console.warn('[Nexo] Fallo al llamar al modelo.', error instanceof Error ? error.name : '');
      throw new AiError(`${t('failed', lang)} ${error instanceof Error ? cut(error.message || '', 200) : ''}`.trim());
    } finally {
      clearTimeout(timer);
      link.dispose();
      cts.dispose();
      console.info('[Nexo] Llamada al modelo.', Date.now() - started, 'ms');
    }
  }

  /**
   * Prompt de sistema como primer mensaje User (no hay rol system estable), texto de usuario ajustado, parseo y
   * validación; si falla, un reintento conversacional con los errores. Respuestas válidas en caché (LRU, 15 min).
   */
  private async runJson(op: PromptOp, system: string, build: UserBuilder, check: (root: Obj) => Validation | Promise<Validation>, opts: RunOptions): Promise<{ value: unknown; cached: boolean }> {
    const { model, token, language: lang } = opts;
    const user = await this.fitUser(model, system, build, opts.maxChars ?? Number.MAX_SAFE_INTEGER, token);
    const key = sha256(`${op}|${model.id}|${lang}|${system}|${user}`);
    const hit = this.cacheGet(key);
    if (hit !== undefined) return { value: hit, cached: true };

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
    if (result.errors.length) {
      console.warn('[Nexo] Respuesta no válida; reintento.', op, result.errors.length);
      logValidation(op, model, 1, text, result.errors);
      const retry = [
        ...messages,
        vscode.LanguageModelChatMessage.Assistant(cut(text, MAX_RETRY_ASSISTANT_CHARS)),
        vscode.LanguageModelChatMessage.User(`## ERRORES DE VALIDACION DE TU RESPUESTA ANTERIOR\n${result.errors.slice(0, 20).join('\n')}\nDevuelve de nuevo el JSON completo corregido.`),
      ];
      ({ text, result } = await attempt(retry));
      if (result.errors.length) {
        console.warn('[Nexo] Respuesta no válida tras el reintento.', op, result.errors.length);
        logValidation(op, model, 2, text, result.errors);
        throw new AiError(t('schema', lang));
      }
    }
    this.cachePut(key, result.value);
    return { value: result.value, cached: false };
  }

  /* ------------------------------ webview: flow ------------------------------ */

  /** Simular, analizar logs, plan de pantalla y mapa de datos (`FlowDiagnosisResponse`). */
  async flowRequest(id: string, kind: FlowKind, body: FlowRequestBody): Promise<FlowDiagnosisResponse> {
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
          const errors = validate(simulate ? 'SimulationResult' : 'LogAnalysisResult', root);
          return { errors: errors.length ? errors : semantics(root, d.flow, simulate, lineCount) };
        }, opts);
      } else if (kind === 'ui-plan') {
        const ui = decodeUiPlan(ctx);
        const user = buildUiPlanText(ui.input, ui.change, lang);
        if (user.length > MAX_UI_PROMPT_CHARS) throw new AiError(t('uiTooLarge', lang));
        operation = 'UI_PLAN';
        run = await this.runJson('UI_PLAN', systemFor('UI_PLAN'), () => user, (root) => {
          const errors = validate('UiPreviewPlan', root);
          return { errors: errors.length ? errors : uiPlanErrors(root, ui.htmlTexts) };
        }, opts);
      } else {
        const d = decodeDiagnosis(ctx);
        let schema = ctx['schema'];
        if (schema === undefined || schema === null) schema = {};
        else if (!isObj(schema) || json(schema).length > MAX_DB_SCHEMA_CHARS) throw new AiError(t('invalid', lang));
        else schema = maskSensitiveJson(schema);
        const empty = !isObj(schema) || !Object.keys(schema).length;
        const tail = `## ESQUEMA REAL\n${empty ? '(sin conexion)' : json(schema)}\n\n${idiomaTail(lang)}`;
        operation = 'DB_MAP';
        run = await this.runJson('DB_MAP', systemFor('DB_MAP'), fitCode(d.flow, d.code, null, tail), (raw) => {
          // Algunos modelos envuelven la respuesta con el nombre de la definición: {"FlowDbMap": {...}}.
          const wrapped = raw['FlowDbMap'];
          const root = Object.keys(raw).length === 1 && isObj(wrapped) ? { ...wrapped } : raw;
          const errors = validate('FlowDbMap', root);
          if (errors.length) return { errors };
          repairDbMap(root, d.flow);
          return { errors: dbMapErrors(root, d.flow), value: root };
        }, opts);
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
      try {
        afterCode = afterWindows(d.code, files);
      } catch (error: unknown) {
        if (error instanceof PatchError) {
          console.warn('[Nexo] El cambio no encaja.', error.message);
          throw new AiError(t('noFit', lang));
        }
        throw error;
      }
      const changeText = changeDiff({ title, summary, files });
      const model = await this.resolveModel();
      const opts: RunOptions = { model, token: child.token, language: lang };
      const simulateCheck = (root: Obj): Validation => {
        delete root['uiRef'];
        delete root['uiRefAfter'];
        const errors = validate('SimulationResult', root);
        return { errors: errors.length ? errors : semantics(root, d.flow, true, 0) };
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
              ? await this.runJson('SIMULATE_AFTER', systemFor('SIMULATE_AFTER'), fitCode(d.flow, afterCode, changeText, simulateTail(input, lang)), simulateCheck, opts)
              : await this.runJson('SIMULATE', systemFor('SIMULATE'), fitCode(d.flow, d.code, null, simulateTail(input, lang)), simulateCheck, opts);
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
      const context = await collectFlowContext({
        question: maskSensitiveText(question),
        pinned: options.pinned,
        useActiveEditor: options.useActiveEditor,
        token,
        progress: options.progress,
        selectFiles: (input) => this.selectFiles(model, input, token, lang),
      });
      options.progress?.(lang === 'en' ? 'Generating the flow…' : 'Generando el flujo…');
      const build = fitFlowText({ mode: 'FLOW', question: maskSensitiveText(question), context, lang });
      const run = await this.runJson('FLOW', systemFor('FLOW'), build, (root) => {
        dropInvalidScenario(root);
        const errors = validate('FlowDiagram', root);
        return { errors: errors.length ? errors : flowSemantics(root) };
      }, { model, token, language: lang });
      const flow: Obj = { ...(run.value as Obj) };
      flow['id'] = crypto.randomUUID();
      flow['model'] = modelLabel(model);
      flow['generatedAt'] = new Date().toISOString();
      flow['question'] = question;
      const title = typeof flow['title'] === 'string' && flow['title'].trim() ? flow['title'].trim().slice(0, 60) : 'Sin título';
      this.last = { flow, title, model: modelLabel(model) };
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
      const context = await collectFlowContext({
        question: maskSensitiveText(question), pinned: options.pinned ?? [], pinnedPaths, useActiveEditor: false, token, progress: options.progress,
      });
      options.progress?.(lang === 'en' ? 'Proposing the change…' : 'Proponiendo el cambio…');
      const activeFlow = json(stripFlow(flow));
      const build = fitFlowText({ mode: 'PROPOSE', question: maskSensitiveText(question), context, activeFlow, lang });
      const run = await this.runJson('PROPOSE', systemFor('PROPOSE'), build, async (raw) => {
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
        let errors = validate('ChangeProposal', change);
        if (!errors.length) errors = proposeSemantics(change, mountIds);
        if (!errors.length) errors = await this.fitErrors(change, multi);
        return errors.length ? { errors } : { errors: [], value: { change } };
      }, { model, token, language: lang });
      const value = run.value as { answer?: string; change?: Obj };
      if (typeof value.answer === 'string') return { answer: value.answer };
      const proposal: Obj = { ...(value.change as Obj) };
      proposal['id'] = crypto.randomUUID();
      proposal['request'] = question;
      proposal['flowId'] = typeof flow['id'] === 'string' ? flow['id'] : null;
      proposal['createdAt'] = new Date().toISOString();
      return { proposal, model: modelLabel(model) };
    } catch (error: unknown) {
      if (global.timedOut()) throw new AiError(t('timeout', lang));
      if (isCancelled(error) || options.token.isCancellationRequested) throw new Error('cancelled');
      throw error;
    } finally {
      global.dispose();
    }
  }

  /** Comprueba que cada archivo de la propuesta encaja con el archivo actual del workspace. */
  private async fitErrors(change: Obj, multi: boolean): Promise<string[]> {
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
      if (PRIVATE_KEY_CHECK.test(original ?? '')) {
        errors.push(`$.files[${i}]: archivo no permitido`);
        continue;
      }
      const status = txt(file['status']);
      if (status === 'added') {
        if (original !== null) errors.push(`$.files[${i}]: el archivo ya existe (usa status "modified")`);
        continue;
      }
      if (original === null) {
        errors.push(`$.files[${i}]: el archivo no existe o no se puede leer`);
        continue;
      }
      const result = applyFileChange(original, file as unknown as FileChange);
      if (!result.ok) errors.push(`$.files[${i}]: el bloque no encaja con el archivo actual (copia las líneas de contexto exactas y usa oldStart real)`);
    }
    return errors.slice(0, 20);
  }
}

const PRIVATE_KEY_CHECK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** El flujo activo sin datos solo de frontend ni resultados (`codeSnapshot`, `dbMap`, `scenario`, `verification`). */
function stripFlow(flow: Obj): unknown {
  const strip = (value: unknown, depth: number): unknown => {
    if (depth > 32) return null;
    if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1));
    if (!isObj(value)) return value;
    const out: Obj = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'codeSnapshot' || k === 'verification') continue;
      if (depth === 0 && (k === 'dbMap' || k === 'scenario')) continue;
      out[k] = strip(v, depth + 1);
    }
    return out;
  };
  return strip(flow, 0);
}

export { isCancelled };
