/**
 * Resumen de un flujo generado, usado por `@traza`:
 * detección de escenario («¿qué pasa si…?»), elección de carpeta del workspace y formateo del markdown escapado
 * para el chat. Todo texto que viene de la IA se recorta y, en el chat, se escapa.
 */
import * as vscode from 'vscode';
import type { GeneratedFlow } from './host-ai';
import type { ChangeRunResult } from './host-change';
import { foldAccents } from './host-context';
import { normalizeCodePath } from './host-guards';

const MAX_SUMMARY = 600;
const MAX_ERRORS = 400;
const MAX_LABEL = 120;
const MAX_FILE = 260;

export function isSpanish(): boolean {
  return vscode.workspace.getConfiguration('traza').get<string>('language') !== 'en';
}

/** Texto en una línea (saltos colapsados) y recortado a `max`. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** Escapa el texto para `stream.markdown` (sin HTML, enlaces ni comandos). */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`)
    .replace(/\r?\n/g, '  \n');
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/* ------------------------------ detección ------------------------------ */

const SCENARIO_PATTERNS: readonly RegExp[] = [
  /\bque\s+(pasa|ocurre|sucede|pasaria|ocurriria|sucederia)\s+(si|cuando)\b/,
  /\bsi\s+(pongo|meto|introduzco|escribo|envio|mando|falla|no\s+(hay|tengo|existe|esta))\b/,
  /\bwhat\s+(happens|would\s+happen|will\s+happen)\s+(if|when)\b/,
  /\bwhat\s+if\b/,
];

/** ¿La pregunta plantea un escenario concreto («qué pasa si…», «what happens if…»)? */
export function isScenarioQuestion(question: string): boolean {
  const folded = foldAccents(question).toLowerCase();
  return SCENARIO_PATTERNS.some((re) => re.test(folded));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Carpeta del workspace a la que se limita el contexto: `hint` exacto (sin mayúsculas) o nombre de carpeta citado en la
 * pregunta (sin tildes ni mayúsculas, palabra completa; gana el nombre más largo). `null` con menos de 2 carpetas o sin
 * coincidencia (se mantienen todas). El `hint` solo se compara con nombres, nunca como ruta.
 */
export function resolveFlowFolder(question: string, hint?: string): vscode.WorkspaceFolder | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length < 2) return null;
  const wanted = typeof hint === 'string' ? hint.trim().toLowerCase() : '';
  if (wanted) {
    const exact = folders.find((f) => f.name.toLowerCase() === wanted);
    if (exact) return exact;
  }
  const text = foldAccents(question).toLowerCase();
  let best: vscode.WorkspaceFolder | null = null;
  for (const folder of folders) {
    const name = foldAccents(folder.name).toLowerCase().trim();
    if (!name) continue;
    if (!new RegExp(`(^|[^a-z0-9])${escapeRegExp(name)}([^a-z0-9]|$)`).test(text)) continue;
    if (!best || name.length > foldAccents(best.name).trim().length) best = folder;
  }
  return best;
}

/* ------------------------------ escenario ------------------------------ */

interface ScenarioWhere {
  mountId: string;
  file: string;
  line: number | null;
}

interface ScenarioInfo {
  label: string;
  kind: string;
  badge: string;
  httpStatus: number | null;
  title: string;
  userImpact: string;
  conclusion: string;
  /** Índice (base 1) del paso donde falla o se detiene; 0 si no hay. */
  stepIndex: number;
  stepLabel: string;
  where: ScenarioWhere | null;
}

function refOf(value: unknown): ScenarioWhere | null {
  const ref = asObject(value);
  if (!ref || typeof ref['file'] !== 'string' || !ref['file'].trim()) return null;
  const line = typeof ref['line'] === 'number' && Number.isFinite(ref['line']) && ref['line'] > 0 ? Math.floor(ref['line']) : null;
  return { mountId: typeof ref['mountId'] === 'string' ? ref['mountId'].trim() : '', file: ref['file'].trim(), line };
}

function scenarioInfo(generated: GeneratedFlow): ScenarioInfo | null {
  const scenario = asObject(generated.flow['scenario']);
  const result = scenario ? asObject(scenario['result']) : null;
  if (!scenario || !result) return null;
  const kind = typeof result['kind'] === 'string' ? result['kind'] : 'none';
  const steps = asArray(generated.flow['steps']).map(asObject);
  const failId = typeof result['failStepId'] === 'string' ? result['failStepId'] : '';
  const index = failId ? steps.findIndex((s) => s !== null && s['id'] === failId) : -1;
  const failStep = index >= 0 ? steps[index] : null;
  const where = (kind === 'error' || kind === 'stop') ? (refOf(result['where']) ?? (failStep ? refOf(failStep['ref']) : null)) : null;
  return {
    label: oneLine(scenario['label'], 60),
    kind,
    badge: oneLine(result['badge'], 60),
    httpStatus: typeof result['httpStatus'] === 'number' && Number.isFinite(result['httpStatus']) ? result['httpStatus'] : null,
    title: oneLine(result['title'], 90),
    userImpact: oneLine(result['userImpact'], 400),
    conclusion: oneLine(result['conclusion'], 900),
    stepIndex: index >= 0 ? index + 1 : 0,
    stepLabel: failStep ? (oneLine(failStep['label'], MAX_LABEL) || oneLine(failStep['title'], MAX_LABEL)) : '',
    where,
  };
}

function whereText(where: ScenarioWhere | null, esc: (s: string) => string): string {
  if (!where) return '';
  const multi = (vscode.workspace.workspaceFolders ?? []).length > 1;
  const file = oneLine(multi && where.mountId ? `${where.mountId}/${where.file}` : where.file, MAX_FILE);
  return `${esc(file)}${where.line ? `:${where.line}` : ''}`;
}

/** Ubicación del fallo del escenario para `stream.anchor`; `undefined` si no hay o no se puede resolver. */
export function failLocation(generated: GeneratedFlow): vscode.Location | undefined {
  const where = scenarioInfo(generated)?.where;
  if (!where) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders.length > 1 ? folders.find((f) => f.name === where.mountId) : folders[0];
  const rel = normalizeCodePath(where.file);
  if (!folder || !rel) return undefined;
  const line = Math.max(0, (where.line ?? 1) - 1);
  return new vscode.Location(vscode.Uri.joinPath(folder.uri, rel), new vscode.Position(line, 0));
}

/* ------------------------------ pasos ------------------------------ */

/** Líneas `N. origen → destino: etiqueta (archivo:línea)` de los primeros `max` pasos y cuántos quedan. */
function stepLines(flow: Record<string, unknown>, max: number, esc: (s: string) => string): { lines: string[]; more: number } {
  const lanes = new Map<string, string>();
  for (const lane of asArray(flow['lanes'])) {
    const o = asObject(lane);
    if (!o) continue;
    const id = typeof o['id'] === 'string' ? o['id'] : '';
    if (id) lanes.set(id, oneLine(o['name'], 80) || oneLine(id, 80));
  }
  const nameOf = (id: unknown): string => {
    const key = typeof id === 'string' ? id : '';
    return esc(lanes.get(key) ?? (oneLine(key, 80) || '?'));
  };
  const steps = asArray(flow['steps']).map(asObject).filter((s): s is Record<string, unknown> => s !== null);
  const lines = steps.slice(0, max).map((step, index) => {
    const label = oneLine(step['label'], MAX_LABEL) || oneLine(step['title'], MAX_LABEL);
    const ref = asObject(step['ref']);
    const file = ref ? oneLine(ref['file'], MAX_FILE) : '';
    const line = ref && typeof ref['line'] === 'number' && Number.isFinite(ref['line']) ? `:${ref['line']}` : '';
    const where = file ? ` (${esc(file)}${line})` : '';
    return `${index + 1}. ${nameOf(step['from'])} → ${nameOf(step['to'])}: ${esc(label)}${where}`;
  });
  return { lines, more: Math.max(0, steps.length - max) };
}

/* ------------------------------ textos ------------------------------ */

const MAX_CHAT_STEPS = 8;

/**
 * Markdown del chat de `@traza`: título, resumen, escenario y pasos; todo texto de la IA escapado.
 * Con `compact` (debajo de la respuesta de la IA): título «Recorrido»/«Walkthrough», sin resumen y, del escenario, solo su línea
 * y dónde falla o se detiene; después los pasos con archivo:línea.
 */
export function formatFlowChatMarkdown(generated: GeneratedFlow, opts?: { compact?: boolean }): string {
  const es = isSpanish();
  const compact = opts?.compact === true;
  const flow = generated.flow;
  const esc = escapeMarkdown;
  const title = oneLine(generated.title, 120);
  const parts: string[] = [compact ? `**${esc(`${es ? 'Recorrido' : 'Walkthrough'}: ${title}`)}**` : `**${esc(title)}**`];
  const summary = oneLine(flow['summary'], MAX_SUMMARY);
  if (summary && !compact) parts.push(esc(summary));
  const info = scenarioInfo(generated);
  if (info) {
    const badge = info.badge ? ` · ${info.badge}` : '';
    const block: string[] = [`**${esc(`${es ? 'Escenario' : 'Scenario'}: ${info.label}${badge}`)}**`];
    if (info.userImpact && !compact) block.push(`**${es ? 'Qué ve el usuario' : 'What the user sees'}:** ${esc(info.userImpact)}`);
    if (info.kind === 'error' || info.kind === 'stop') {
      const head = info.kind === 'error' ? (es ? 'Dónde falla' : 'Where it fails') : (es ? 'Dónde se detiene' : 'Where it stops');
      const step = info.stepIndex ? `${es ? 'paso' : 'step'} ${info.stepIndex}` : '';
      const label = info.stepLabel ? ` — ${esc(info.stepLabel)}` : '';
      const place = whereText(info.where, esc);
      const text = `${step}${label}${place ? ` (${place})` : ''}`.trim();
      if (text) block.push(`**${head}:** ${text}`);
    } else if (info.kind === 'ok' && !compact) {
      block.push(es ? 'El flujo termina correctamente.' : 'The flow ends successfully.');
    }
    if (info.conclusion && !compact) block.push(`**${es ? 'Conclusión' : 'Conclusion'}:** ${esc(info.conclusion)}`);
    parts.push(block.join('\n\n'));
  } else if (generated.scenarioAsked) {
    parts.push(es
      ? 'No se pudo generar un escenario simulable para esta pregunta; puedes probarlo en «Simular datos» del panel\\.'
      : 'A simulable scenario could not be generated for this question; you can try it in "Simular datos" in the panel\\.');
    if (typeof flow['errorSummary'] === 'string') {
      const errors = oneLine(flow['errorSummary'], MAX_ERRORS);
      if (errors) parts.push(`**${es ? 'Errores' : 'Errors'}:** ${esc(errors)}`);
    }
  }
  const steps = stepLines(flow, MAX_CHAT_STEPS, esc);
  if (steps.lines.length) {
    const list = steps.lines.join('\n');
    const more = steps.more > 0 ? `\n\n${es ? `… y ${steps.more} pasos más` : `… and ${steps.more} more steps`}` : '';
    parts.push(`**${es ? 'Pasos' : 'Steps'}**\n\n${list}${more}`);
  }
  return parts.join('\n\n');
}

/* ------------------------------ texto del modelo ------------------------------ */

const CODE_SPAN = /(`+)[^`]*\1/g;
const PLACEHOLDER = /\u0000(\d+)\u0000/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]*\]:/;

/** Saneado de una línea fuera de bloque de código: sin imágenes, enlaces, definiciones de referencia ni HTML. Los code spans no se tocan. */
function sanitizeModelLine(line: string): string {
  if (REFERENCE_DEFINITION.test(line)) return '';
  const spans: string[] = [];
  const masked = line.replace(/\u0000/g, '').replace(CODE_SPAN, (m) => {
    spans.push(m);
    return `\u0000${spans.length - 1}\u0000`;
  });
  const clean = masked
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<(?=[A-Za-z/!])/g, '&lt;');
  return clean.replace(PLACEHOLDER, (_m, i: string) => spans[Number(i)] ?? '');
}

/**
 * Escritor del Markdown del modelo para `stream.markdown`: acumula los fragmentos y emite solo líneas completas, saneadas
 * (imágenes → alt, enlaces → texto, definiciones de referencia fuera, `<` → `&lt;`). Dentro de bloques de código y code
 * spans no se toca nada. `end()` vacía el resto, cierra un fence abierto y devuelve los caracteres no vacíos recibidos.
 * El texto sale siempre como `string` (nunca como MarkdownString confiable).
 */
export function modelMarkdownWriter(emit: (md: string) => void): { push(chunk: string): void; end(): number } {
  let buffer = '';
  let fence: { ch: string; len: number } | null = null;
  let total = 0;
  const processLine = (line: string): string => {
    const body = line.replace(/\r?\n$/, '');
    const trimmed = body.trim();
    const marker = /^(`{3,}|~{3,})/.exec(trimmed)?.[1] ?? '';
    if (fence) {
      if (marker && marker[0] === fence.ch && marker.length >= fence.len && trimmed === marker) fence = null;
      return line;
    }
    if (marker) {
      fence = { ch: marker[0], len: marker.length };
      return line;
    }
    const clean = sanitizeModelLine(body);
    return clean || !body ? `${clean}${line.slice(body.length)}` : '';
  };
  const flush = (text: string): void => {
    if (!text) return;
    const out = text.split(/(?<=\n)/).map(processLine).join('');
    if (out) emit(out);
  };
  return {
    push(chunk: string): void {
      if (!chunk) return;
      total += chunk.replace(/\s/g, '').length;
      buffer += chunk;
      const last = buffer.lastIndexOf('\n');
      if (last < 0) return;
      const complete = buffer.slice(0, last + 1);
      buffer = buffer.slice(last + 1);
      flush(complete);
    },
    end(): number {
      const rest = buffer;
      buffer = '';
      flush(rest);
      if (fence) {
        const closing = fence.ch.repeat(fence.len);
        fence = null;
        emit(`\n${closing}`);
      }
      return total;
    },
  };
}

/* ------------------------------ cambios ------------------------------ */

const CHANGE_QUESTION_START = /^(como|que|donde|por que|cual|cuales|cuando|how|what|where|why|which|when)\b/;
const CHANGE_PATTERNS: readonly RegExp[] = [
  /^(por favor\s+)?(cambia|cambie|cambiemos|modifica|modifique|anade|agrega|pon|pongamos|quita|elimina|renombra|refactoriza|implementa|arregla|corrige|sustituye|reemplaza|haz que)\b/,
  /\b(necesito|quiero|me gustaria|puedes|podrias|hay que)\s+(que\s+)?(\w+\s+){0,12}?(cambi|modific|anad|agreg|pong|poner|quit|elimin|renombr|refactoriz|implement|arregl|corrig|sustitu|reemplaz)\w*/,
  /^(please\s+)?(change|modify|add|remove|rename|refactor|implement|fix|replace|make)\b/,
  /\b(i need|i want|can you|could you|please)\s+(to\s+)?(\w+\s+){0,6}?(change|modify|add|remove|rename|refactor|implement|fix|replace|make)\b/,
];

/** ¿El texto es una petición de cambio de código/UI (y no una pregunta ni un escenario)? */
export function isChangeRequest(text: string): boolean {
  if (isScenarioQuestion(text)) return false;
  const folded = foldAccents(text).toLowerCase().trim().replace(/^[¿¡\s]+/, '');
  if (!folded || CHANGE_QUESTION_START.test(folded)) return false;
  return CHANGE_PATTERNS.some((re) => re.test(folded));
}

const MAX_CHANGE_FILES = 12;
const MAX_CHANGE_RISKS = 5;

interface ChangeFileLine {
  path: string;
  status: string;
}

function changeFiles(proposal: Record<string, unknown>): { lines: ChangeFileLine[]; more: number } {
  const multi = (vscode.workspace.workspaceFolders ?? []).length > 1;
  const all = asArray(proposal['files']).map(asObject).filter((f): f is Record<string, unknown> => f !== null);
  const lines = all.slice(0, MAX_CHANGE_FILES).map((f) => {
    const mount = typeof f['mountId'] === 'string' ? f['mountId'].trim() : '';
    const rel = oneLine(f['path'], MAX_FILE);
    return { path: multi && mount ? `${mount}/${rel}` : rel, status: oneLine(f['status'], 20) };
  });
  return { lines, more: Math.max(0, all.length - lines.length) };
}

function changeRisks(proposal: Record<string, unknown>): string[] {
  return asArray(proposal['risks']).map((r) => oneLine(r, 200)).filter((r) => r).slice(0, MAX_CHANGE_RISKS);
}

/** Markdown del chat para una petición de cambio resuelta; todo texto de la IA escapado. */
export function formatChangeChatMarkdown(r: ChangeRunResult): string {
  const es = isSpanish();
  const esc = escapeMarkdown;
  if (r.kind === 'answer') return esc(oneLine(r.answer, 1500));
  const proposal = r.proposal;
  const flowTitle = esc(oneLine(r.flowTitle, 120));
  const parts: string[] = [
    r.generated
      ? `${es ? 'Flujo generado' : 'Generated flow'}: **${flowTitle}**`
      : `${es ? 'Sobre el flujo abierto' : 'On the open flow'}: **${flowTitle}**`,
    `**${esc(oneLine(proposal['title'], 120))}**`,
  ];
  const summary = oneLine(proposal['summary'], MAX_SUMMARY);
  if (summary) parts.push(esc(summary));
  const files = changeFiles(proposal);
  if (files.lines.length) {
    const list = files.lines.map((f) => `- ${esc(f.path)}${f.status ? ` (${esc(f.status)})` : ''}`).join('\n');
    const more = files.more > 0 ? `\n\n${es ? `… y ${files.more} archivos más` : `… and ${files.more} more files`}` : '';
    parts.push(`**${es ? 'Archivos' : 'Files'}**\n\n${list}${more}`);
  }
  const risks = changeRisks(proposal);
  if (risks.length) parts.push(`**${es ? 'Riesgos' : 'Risks'}**\n\n${risks.map((x) => `- ${esc(x)}`).join('\n')}`);
  parts.push(es
    ? 'Abierto en «Simular cambios» (antes/después)\\. No se ha modificado ningún archivo\\.'
    : 'Opened in "Simular cambios" (before/after)\\. No file has been modified\\.');
  return parts.join('\n\n');
}
