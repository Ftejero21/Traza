import { maskSensitiveText } from './workspace-code-ai-mask';
import { FlowDiagram, FlowStep, LogEvidence, LogPreAnalysis, LogTone } from './nexo-ia.types';

/**
 * Análisis determinista de logs en el frontend (antes de llamar a la IA): enmascara, extrae marcos de pila Java/JS/TS,
 * excepciones (y el campo nulo de una NPE), códigos HTTP, verbos + URL y menciones a clases/funciones de los pasos, y
 * asigna cada línea al paso del flujo que le corresponde.
 */
type Frame = NonNullable<LogEvidence['frame']>;

const JAVA_FRAME = /at ([\w$.]+)\.([\w$<>]+)\(([\w$]+\.\w+):(\d+)\)/;
const JS_FRAME = /at (?:([\w$.]+)\.)?([\w$<>]+) \(?(.+?\.(?:ts|js|mjs|tsx)):(\d+):(\d+)\)?/;
const EXCEPTION = /^\s*(?:Caused by: )?([\w.$]+(?:Exception|Error))(?::\s*(.*))?$/;
const NPE_FIELD = /because "([^"]+)" is null/;
const HTTP_STATUS = /\b(?:status(?: code)?[:= ]*|HTTP\/\d\.\d\s+)([1-5]\d{2})\b/i;
/** Código suelto (` 500`): solo con verbo + URL en la línea, texto de estado detrás o si es 4xx/5xx sin unidades. */
const HTTP_LOOSE = /\s([1-5]\d{2})\b(?!\s*(?:ms|s|kb|mb|bytes|%|px|rows|items)\b)(\s+[A-Z][a-z]+)?/;
const VERB_URL = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/;

function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/[?#].*$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** Ruta de URL sin host, query ni variables (`/api/x/{id}` y `/api/x/42` comparan igual). */
function urlShape(url: string): string {
  let path = url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/['"`,;)]+$/, '');
  path = path.replace(/\$\{[^}]*\}|\{[^}]*\}|:[A-Za-z_]\w*/g, '*').replace(/\/[0-9a-f-]{8,}|\/\d+/gi, '/*');
  return path.toLowerCase();
}

function httpStatusOf(text: string, hasVerb: boolean): number | undefined {
  const strict = text.match(HTTP_STATUS);
  if (strict) return Number(strict[1]);
  const loose = text.match(HTTP_LOOSE);
  if (!loose) return undefined;
  const code = Number(loose[1]);
  return hasVerb || !!loose[2] || code >= 400 ? code : undefined;
}

function parseFrame(line: string): Frame | undefined {
  const java = line.match(JAVA_FRAME);
  if (java) {
    return { className: lastSegment(java[1]), functionName: java[2], file: java[3], line: Number(java[4]) };
  }
  const js = line.match(JS_FRAME);
  if (js) {
    return { className: js[1] ? lastSegment(js[1]) : '', functionName: js[2], file: js[3].replace(/^.*?(webpack:\/\/\/?|file:\/\/\/?)/, ''), line: Number(js[4]) };
  }
  return undefined;
}

function stepForFrame(frame: Frame, steps: FlowStep[]): string | null {
  const file = baseName(frame.file).toLowerCase();
  const candidates = steps.filter((s) => s.ref && baseName(s.ref.file).toLowerCase() === file
    && (!frame.className || s.ref.className === frame.className || lastSegment(s.ref.className) === frame.className));
  if (!candidates.length) return null;
  const byFn = candidates.find((s) => s.ref?.functionName === frame.functionName);
  return (byFn ?? candidates[0]).id;
}

function stepForUrl(url: string, steps: FlowStep[]): string | null {
  const shape = urlShape(url);
  if (!shape || shape === '/') return null;
  for (const step of steps) {
    const sources = [step.label, step.generatedCode?.code ?? ''];
    for (const source of sources) {
      const m = source.match(/(?:GET|POST|PUT|PATCH|DELETE)?\s*((?:https?:\/\/[^\s'"`]+)?\/[^\s'"`]+)/i);
      if (m && urlShape(m[1]) === shape) return step.id;
    }
  }
  return null;
}

function stepForMention(line: string, steps: FlowStep[]): string | null {
  for (const step of steps) {
    const ref = step.ref;
    if (!ref) continue;
    if (ref.className && ref.functionName && line.includes(ref.className) && line.includes(ref.functionName)) return step.id;
  }
  return null;
}

export function analyzeLogs(rawLogs: string, flow: FlowDiagram, projectFileExists: (file: string) => boolean): { masked: string; pre: LogPreAnalysis } {
  const masked = maskSensitiveText(String(rawLogs ?? ''));
  const lines = masked.split(/\r?\n/);
  const evidence: LogEvidence[] = [];
  const seen: string[] = [];
  const statuses = new Set<number>();
  let exception: LogPreAnalysis['exception'];
  let topProjectFrame: Frame | undefined;

  lines.forEach((text, index) => {
    if (!text.trim()) return;
    const frame = parseFrame(text);
    const ex = frame ? null : text.match(EXCEPTION);
    const verbUrl = text.match(VERB_URL);
    const httpStatus = frame ? undefined : httpStatusOf(text, !!verbUrl);
    if (ex && !exception) {
      exception = { type: ex[1], message: (ex[2] ?? '').trim() };
      const nullField = text.match(NPE_FIELD);
      if (nullField) exception.nullField = nullField[1];
    } else if (exception && !exception.nullField) {
      const nullField = text.match(NPE_FIELD);
      if (nullField) exception.nullField = nullField[1];
    }
    if (httpStatus !== undefined) statuses.add(httpStatus);
    if (frame && !topProjectFrame && projectFileExists(frame.file)) topProjectFrame = frame;

    let stepId: string | null = frame ? stepForFrame(frame, flow.steps) : null;
    if (!stepId && verbUrl) stepId = stepForUrl(verbUrl[2], flow.steps);
    if (!stepId) stepId = stepForMention(text, flow.steps);

    const tone: LogTone = ex || (httpStatus !== undefined && httpStatus >= 400) ? 'error' : frame ? 'trace' : 'info';
    const relevant = !!(frame || ex || httpStatus !== undefined || verbUrl || stepId);
    if (!relevant) return;
    const item: LogEvidence = { index, text: text.length > 2000 ? text.slice(0, 2000) : text, stepId, tone };
    if (frame) item.frame = frame;
    if (httpStatus !== undefined) item.httpStatus = httpStatus;
    evidence.push(item);
    if (stepId && !seen.includes(stepId)) seen.push(stepId);
  });

  const pre: LogPreAnalysis = { evidence: evidence.slice(0, 400), seenStepIds: seen, httpStatuses: [...statuses] };
  if (exception) pre.exception = exception;
  if (topProjectFrame) pre.topProjectFrame = topProjectFrame;
  return { masked, pre };
}
