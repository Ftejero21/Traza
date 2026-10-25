/**
 * Cambios propuestos por Nexo IA (`ChangeProposal`): saneado con los límites del esquema, encaje de cada bloque del
 * diff contra el archivo real (corrige `oldStart`), cálculo del contenido nuevo, etiquetas de la comparación
 * antes/después y resolución estricta de rutas de escritura. Funciones puras, sin Angular.
 */
import { WorkspaceCodeFile, WorkspaceCodeMount, normalizeCodePath } from '../workspace-code.types';
import { GitTextLine, gitDominantEol, gitJoinLines, gitSplitLines } from '../services/workspace-code-git-patch';
import { MASK } from './workspace-code-ai-mask';
import { FlowDiagram, SimulationPreset, SimulationResult } from './nexo-ia.types';
import { CaseComparison, ChangeProposal, ComparisonTag, DiffHunk, DiffLine, DiffLineKind, FileChange } from './nexo-ia.changes.types';

const MAX_TITLE = 70;
const MAX_SUMMARY = 500;
const MAX_NOTE = 60;
const MAX_RISKS = 5;
const MAX_RISK = 200;
const MAX_FILES = 12;
const MAX_HUNKS = 40;
const MAX_LINES = 400;
const MAX_TEXT = 2000;
const MAX_HEADER = 80;
const MAX_REQUEST = 4000;
const MAX_PATH = 1000;
const MAX_MOUNT_ID = 200;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const LINE_PREFIX = /^\s*\d+\| /;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STATUSES: readonly ChangeProposal['status'][] = ['pending', 'applied', 'discarded', 'conflict'];
const FILE_STATUSES: readonly FileChange['status'][] = ['modified', 'added', 'deleted'];
const KINDS: readonly DiffLineKind[] = ['context', 'add', 'del'];

export type ApplyFileResult =
  | { ok: true; content: string | null; hunks: DiffHunk[]; additions: number; deletions: number }
  | { ok: false; reason: 'missing' | 'exists' | 'mismatch' | 'overlap'; hunkIndex?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (error: unknown) {
    console.warn('[Nexo IA] randomUUID no disponible.', error instanceof Error ? error.name : '');
  }
  return `chg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ruta relativa segura (sin `..`, absolutas ni caracteres de control) o `null`. */
export function safeRelativePath(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw : '';
  if (!text || text.length > MAX_PATH || CONTROL.test(text) || /^(?:[\\/]|[A-Za-z]:)/.test(text)) return null;
  if (text.replace(/\\/g, '/').split('/').some((s) => s.trim() === '..')) return null;
  return normalizeCodePath(text);
}

/**
 * Sanea la propuesta con los límites del esquema `ChangeProposal`. Con `preserve` (historial) conserva el estado,
 * `baseHash`, la fecha y los números de línea ya calculados; si no, el estado es `pending` y `baseHash` `null`.
 */
export function sanitizeChangeProposal(raw: unknown, question: string, preserve = false): ChangeProposal | null {
  if (!isRecord(raw) || !Array.isArray(raw['files'])) return null;
  const rawFiles = raw['files'] as unknown[];
  if (rawFiles.length < 1 || rawFiles.length > MAX_FILES) return null;
  const files: FileChange[] = [];
  const seen = new Set<string>();
  for (const rawFile of rawFiles) {
    const file = sanitizeFile(rawFile, preserve);
    if (!file) return null;
    const key = `${file.mountId}\u0000${file.path}`;
    if (seen.has(key)) return null;
    seen.add(key);
    files.push(file);
  }
  const rawRisks = Array.isArray(raw['risks']) ? (raw['risks'] as unknown[]) : [];
  const risks = rawRisks.filter((r): r is string => typeof r === 'string' && !!r.trim()).slice(0, MAX_RISKS).map((r) => r.trim().slice(0, MAX_RISK));
  const flowId = raw['flowId'];
  const rawId = typeof raw['id'] === 'string' ? raw['id'] : '';
  const request = (question || str(raw['request'], MAX_REQUEST)).slice(0, MAX_REQUEST);
  const status = preserve && STATUSES.includes(raw['status'] as ChangeProposal['status']) ? raw['status'] as ChangeProposal['status'] : 'pending';
  const createdAt = preserve && typeof raw['createdAt'] === 'string' && raw['createdAt'] ? raw['createdAt'] : new Date().toISOString();
  return {
    id: ID_PATTERN.test(rawId) ? rawId : newId(),
    request,
    title: str(raw['title'], MAX_TITLE).trim(),
    summary: str(raw['summary'], MAX_SUMMARY).trim(),
    files,
    flowId: typeof flowId === 'string' && flowId ? flowId.slice(0, 200) : null,
    risks,
    status,
    createdAt,
  };
}

function sanitizeFile(raw: unknown, preserve: boolean): FileChange | null {
  if (!isRecord(raw)) return null;
  const path = safeRelativePath(raw['path']);
  if (!path) return null;
  const mountId = typeof raw['mountId'] === 'string' ? raw['mountId'] : '';
  if (mountId.length > MAX_MOUNT_ID || CONTROL.test(mountId)) return null;
  const status = raw['status'] as FileChange['status'];
  if (!FILE_STATUSES.includes(status)) return null;
  if (!Array.isArray(raw['hunks'])) return null;
  const rawHunks = raw['hunks'] as unknown[];
  if (rawHunks.length < 1 || rawHunks.length > MAX_HUNKS) return null;
  const hunks: DiffHunk[] = [];
  for (const rawHunk of rawHunks) {
    const hunk = sanitizeHunk(rawHunk, preserve);
    if (!hunk) return null;
    hunks.push(hunk);
  }
  const all = hunks.flatMap((h) => h.lines);
  if (status === 'added' && (hunks.some((h) => h.oldStart !== 0) || all.some((l) => l.kind !== 'add'))) return null;
  if (status === 'deleted' && all.some((l) => l.kind !== 'del')) return null;
  if (status === 'modified' && !all.some((l) => l.kind !== 'context')) return null;
  const baseHash = preserve && typeof raw['baseHash'] === 'string' && /^[0-9a-f]{64}$/.test(raw['baseHash']) ? raw['baseHash'] : null;
  return {
    mountId,
    path,
    note: str(raw['note'], MAX_NOTE).trim(),
    status,
    baseHash,
    hunks,
    additions: all.filter((l) => l.kind === 'add').length,
    deletions: all.filter((l) => l.kind === 'del').length,
  };
}

function sanitizeHunk(raw: unknown, preserve: boolean): DiffHunk | null {
  if (!isRecord(raw) || !Array.isArray(raw['lines'])) return null;
  const oldStart = int(raw['oldStart']);
  const newStart = int(raw['newStart']);
  if (oldStart === null || newStart === null) return null;
  const rawLines = raw['lines'] as unknown[];
  if (rawLines.length < 1 || rawLines.length > MAX_LINES) return null;
  const lines: DiffLine[] = [];
  for (const rawLine of rawLines) {
    if (!isRecord(rawLine)) return null;
    const kind = rawLine['kind'] as DiffLineKind;
    const text = rawLine['text'];
    if (!KINDS.includes(kind) || typeof text !== 'string' || text.length > MAX_TEXT || /[\r\n]/.test(text.replace(/\r$/, ''))) return null;
    lines.push({
      kind,
      text: text.replace(/\r$/, ''),
      oldLine: preserve && kind !== 'add' ? int(rawLine['oldLine']) : null,
      newLine: preserve && kind !== 'del' ? int(rawLine['newLine']) : null,
    });
  }
  // La IA a veces copia el prefijo de numeración del contexto (`12| `): si lo llevan todas las líneas, se quita.
  if (lines.every((l) => LINE_PREFIX.test(l.text))) for (const line of lines) line.text = line.text.replace(LINE_PREFIX, '');
  return { header: str(raw['header'], MAX_HEADER), oldStart, newStart, lines };
}

/* ---------------------------- aplicar un archivo ---------------------------- */

interface Placement { index: number; start: number; length: number }

/**
 * Aplica los bloques de un archivo sobre `original` (null = no existe). Encaja cada bloque por sus líneas de contexto
 * y eliminadas (comparando con `trimEnd()`, la sangría cuenta): primero en `oldStart`, si no en la coincidencia más
 * cercana (empate o ninguna = `mismatch`). Conserva el EOL de cada línea; las añadidas usan el EOL dominante.
 */
export function applyFileChange(original: string | null, change: FileChange): ApplyFileResult {
  if (change.status === 'added') {
    if (original !== null) return { ok: false, reason: 'exists' };
    let newLine = 1;
    const hunks = change.hunks.map((h) => {
      const newStart = newLine;
      const lines = h.lines.map((l) => ({ kind: l.kind, text: l.text, oldLine: null, newLine: newLine++ }));
      return { ...h, oldStart: 0, newStart, lines };
    });
    const body = hunks.flatMap((h) => h.lines.map((l) => l.text));
    return { ok: true, content: `${body.join('\n')}\n`, hunks, additions: body.length, deletions: 0 };
  }
  if (original === null) return { ok: false, reason: 'missing' };

  const lines = gitSplitLines(original);
  const placements: Placement[] = [];
  const input = change.hunks.map((h) => ({ ...h }));
  for (let index = 0; index < input.length; index++) {
    const hunk = input[index];
    let old = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text);
    // Un bloque con «oculto» en su contexto nunca encaja: así no se escribe la máscara encima de un secreto.
    if (old.some((t) => t.includes(MASK))) return { ok: false, reason: 'mismatch', hunkIndex: index };
    let start = locate(lines, old, hunk.oldStart);
    if (start === null) {
      // La IA a veces omite (o inventa) líneas en blanco del contexto: se realinea solo por líneas vacías.
      const realigned = realignBlankLines(lines, hunk.lines, hunk.oldStart);
      if (realigned) {
        hunk.lines = realigned;
        old = realigned.filter((l) => l.kind !== 'add').map((l) => l.text);
        start = locate(lines, old, hunk.oldStart);
      }
    }
    if (start === null) return { ok: false, reason: 'mismatch', hunkIndex: index };
    placements.push({ index, start, length: old.length });
  }
  const sorted = [...placements].sort((a, b) => a.start - b.start || a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    if (sorted[i].start < prev.start + prev.length) return { ok: false, reason: 'overlap', hunkIndex: sorted[i].index };
  }

  const eol = gitDominantEol(original) || '\n';
  const endsWithEol = lines.length === 0 || lines[lines.length - 1].eol !== '';
  const out: GitTextLine[] = [];
  const hunks: DiffHunk[] = [];
  let cursor = 0;
  let delta = 0;
  let additions = 0;
  let deletions = 0;
  for (const placement of sorted) {
    const hunk = input[placement.index];
    while (cursor < placement.start) out.push({ ...lines[cursor++] });
    const oldStart = placement.length ? placement.start + 1 : placement.start;
    const newStart = placement.start + delta + 1;
    let oldLine = placement.start + 1;
    let newLine = newStart;
    const viewLines: DiffLine[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'context') {
        out.push({ ...lines[cursor++] });
        viewLines.push({ kind: 'context', text: line.text, oldLine: oldLine++, newLine: newLine++ });
      } else if (line.kind === 'del') {
        cursor++;
        deletions++;
        viewLines.push({ kind: 'del', text: line.text, oldLine: oldLine++, newLine: null });
      } else {
        out.push({ body: line.text, eol });
        additions++;
        viewLines.push({ kind: 'add', text: line.text, oldLine: null, newLine: newLine++ });
      }
    }
    delta += viewLines.filter((l) => l.kind === 'add').length - viewLines.filter((l) => l.kind === 'del').length;
    hunks.push({ ...hunk, oldStart, newStart, lines: viewLines });
  }
  while (cursor < lines.length) out.push({ ...lines[cursor++] });
  for (let i = 0; i < out.length - 1; i++) if (!out[i].eol) out[i].eol = eol;
  if (out.length) {
    const last = out[out.length - 1];
    if (!endsWithEol) last.eol = '';
    else if (!last.eol) last.eol = eol;
  }
  return { ok: true, content: change.status === 'deleted' ? null : gitJoinLines(out), hunks, additions, deletions };
}

/** Índice 0-based donde encajan las líneas `old`, o `null`. */
function locate(lines: GitTextLine[], old: string[], oldStart: number): number | null {
  const preferred = Math.max(0, oldStart - 1);
  if (!old.length) {
    const at = Math.min(Math.max(0, oldStart), lines.length);
    return at;
  }
  const matches = (p: number): boolean => {
    if (p < 0 || p + old.length > lines.length) return false;
    for (let k = 0; k < old.length; k++) if (lines[p + k].body.trimEnd() !== old[k].trimEnd()) return false;
    return true;
  };
  if (matches(preferred)) return preferred;
  let best: number | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (let p = 0; p + old.length <= lines.length; p++) {
    if (!matches(p)) continue;
    const distance = Math.abs(p - preferred);
    if (distance < bestDistance) {
      best = p;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Encaje tolerante a líneas en blanco: las líneas no vacías del bloque deben coincidir en orden; las vacías del archivo
 * que falten se añaden como contexto y las vacías del bloque que no existan se quitan. Devuelve las líneas del bloque
 * reescritas para la coincidencia más cercana a `oldStart` (empate o ninguna = null).
 */
function realignBlankLines(lines: GitTextLine[], hunkLines: DiffLine[], oldStart: number): DiffLine[] | null {
  const blank = (t: string): boolean => t.trim() === '';
  const old = hunkLines.filter((l) => l.kind !== 'add');
  if (!old.some((l) => !blank(l.text))) return null;
  const preferred = Math.max(0, oldStart - 1);
  const build = (p: number): DiffLine[] | null => {
    const out: DiffLine[] = [];
    let ptr = p;
    for (const line of hunkLines) {
      if (line.kind === 'add') { out.push(line); continue; }
      if (blank(line.text)) {
        if (ptr < lines.length && blank(lines[ptr].body)) { out.push(line); ptr++; }
        continue;
      }
      while (ptr < lines.length && blank(lines[ptr].body)) out.push({ kind: 'context', text: lines[ptr++].body, oldLine: null, newLine: null });
      if (ptr >= lines.length || lines[ptr].body.trimEnd() !== line.text.trimEnd()) return null;
      out.push(line);
      ptr++;
    }
    return out;
  };
  let best: DiffLine[] | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (let p = 0; p < lines.length; p++) {
    if (blank(lines[p].body) && !blank(old[0].text)) continue;
    const built = build(p);
    if (!built) continue;
    const distance = Math.abs(p - preferred);
    if (distance < bestDistance) { best = built; bestDistance = distance; tie = false; }
    else if (distance === bestDistance) tie = true;
  }
  return tie ? null : best;
}

/* ---------------------------- comparación ---------------------------- */

/** Etiqueta de un caso: arreglado, regresión, mejora el aviso o sin cambios (nunca la decide la IA). */
export function compareTag(before: SimulationResult, after: SimulationResult, touched = true): ComparisonTag {
  if (before.kind === 'error' && after.kind === 'ok') return 'fixed';
  if (before.kind === 'ok' && after.kind !== 'ok') return 'regression';
  if (before.kind !== after.kind) return 'same';
  // En un caso correcto el modelo a veces omite el 200: null equivale a 2xx.
  const status = (r: SimulationResult): number | null => r.httpStatus ?? (r.kind === 'ok' ? 200 : null);
  if (status(before) !== status(after)) return 'better';
  // Dos simulaciones independientes nunca redactan igual: en un caso correcto solo cuenta el código HTTP, y en uno que
  // falla el texto solo cuenta si el cambio toca algún archivo de los pasos que se ejecutan en ese caso.
  if (before.kind === 'ok' || !touched) return 'same';
  const impact = (r: SimulationResult): string => String(r.userImpact ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return impact(before) !== impact(after) ? 'better' : 'same';
}

/**
 * ¿El cambio toca algún archivo que interviene en este caso? Pasos ejecutados (antes o después), más la línea que
 * falla. Mismo montaje (o sin montaje) y misma ruta relativa.
 */
export function caseTouchedByChange(flow: FlowDiagram, files: FileChange[], before: SimulationResult, after: SimulationResult): boolean {
  const norm = (p: string | null | undefined): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const hits = (mountId: string | null | undefined, file: string | null | undefined): boolean =>
    !!file && files.some((f) => norm(f.path) === norm(file) && (!f.mountId || !mountId || f.mountId === mountId));
  const executed = new Set([...(before.executedStepIds ?? []), ...(after.executedStepIds ?? [])]);
  if (before.failStepId) executed.add(before.failStepId);
  if (after.failStepId) executed.add(after.failStepId);
  if (flow.steps.some((s) => executed.has(s.id) && hits(s.ref?.mountId, s.ref?.file))) return true;
  return [before.where, after.where].some((w) => !!w && hits(w.mountId, w.file));
}

/** Regresiones primero; el resto en el orden de los presets del flujo. */
export function sortCases<T extends CaseComparison>(cases: T[], presets: SimulationPreset[]): T[] {
  const order = new Map(presets.map((p, i) => [p.id, i]));
  const rank = (c: T) => order.get(c.preset.id) ?? Number.MAX_SAFE_INTEGER;
  return [...cases].sort((a, b) => {
    const ra = a.tag === 'regression' ? 0 : 1;
    const rb = b.tag === 'regression' ? 0 : 1;
    return ra - rb || rank(a) - rank(b);
  });
}

/* ---------------------------- utilidades ---------------------------- */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? '')));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function proposalStats(p: ChangeProposal): { additions: number; deletions: number; files: number } {
  return {
    additions: p.files.reduce((n, f) => n + f.additions, 0),
    deletions: p.files.reduce((n, f) => n + f.deletions, 0),
    files: p.files.length,
  };
}

/** Lenguaje del resaltado propio (`tokenizeCodeLine`) a partir de la extensión. */
export function languageOfPath(path: string): string {
  const name = String(path ?? '').slice(String(path ?? '').lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Resolución estricta de la ruta de escritura (nunca por sufijo): el `mountId` tiene que existir; vacío solo vale con
 * un montaje como mucho o si la ruta virtual existe exactamente.
 */
export function resolveChangeTarget(
  mounts: WorkspaceCodeMount[],
  fileByPath: (path: string) => WorkspaceCodeFile | null | undefined,
  fc: Pick<FileChange, 'mountId' | 'path'>,
): { path: string } | null {
  const rel = safeRelativePath(fc.path);
  if (!rel) return null;
  const mountId = String(fc.mountId ?? '');
  if (mountId) {
    const mount = mounts.find((m) => m.id === mountId);
    if (!mount) return null;
    if (!mount.path) return { path: rel };
    const joined = `${mount.path}/${rel}`;
    if (!fileByPath(joined) && rel.startsWith(`${mount.path}/`) && fileByPath(rel)) return { path: rel };
    return { path: joined };
  }
  if (fileByPath(rel)) return { path: rel };
  if (mounts.length === 0) return { path: rel };
  if (mounts.length === 1) {
    const prefix = mounts[0].path;
    if (!prefix || rel.startsWith(`${prefix}/`)) return { path: rel };
    return { path: `${prefix}/${rel}` };
  }
  return null;
}
