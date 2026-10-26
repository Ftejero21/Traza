/**
 * Recogida de contexto local para generar un flujo (FLOW) o proponer un cambio (PROPOSE) con el modelo de VS Code:
 * mapa del proyecto puntuado por palabras clave, selección de archivos (IA barata + palabras clave), fragmentos con
 * secretos enmascarados, archivo activo y selección. Nunca incluye archivos sensibles, excluidos ni binarios.
 */
import * as vscode from 'vscode';
import type { ProjectFileInfo } from '../webview/src/app/bridge/protocol';
import { maskConfigSecrets, maskSensitiveText } from '../webview/src/app/workspace-code/ai/workspace-code-ai-mask';
import { isContextExcludedPath } from '../webview/src/app/workspace-code/ai/workspace-code-context-exclude';
import { listFiles, readFile } from './host-files';
import { codeExtension, isSensitiveCodeFile } from './host-guards';

const MAX_SCAN_FILES = 3000;
const MAX_SCAN_BYTES = 256 * 1024;
const SCAN_CONCURRENCY = 8;
const MAX_TERM_HITS = 20;
const MAP_FLOW_CHARS = 20_000;
const MAP_SELECT_CHARS = 40_000;
const MAX_SELECTED = 12;
const KEYWORD_TOP = 3;
const MAX_FILES = 14;
const FULL_FILE_CHARS = 8000;
const WINDOW_RADIUS = 50;
const WINDOWS_PER_FILE = 3;
const HEAD_LINES = 40;
const MAX_FRAGMENTS = 24;
const MAX_FRAGMENT_CHARS = 8000;
const MAX_FRAGMENTS_TOTAL = 90_000;
const ACTIVE_FULL_CHARS = 16_000;
const ACTIVE_RADIUS = 150;
const MAX_SELECTION_CHARS = 4000;
const TRUNCATED = '\n…(truncado)';
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LOW_WEIGHT_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'json', 'md', 'markdown', 'txt', 'svg', 'xml', 'csv', 'lock', 'map']);

/* ---------------------- tokens (copia de chatFront workspace-code-ai-context.ts) ---------------------- */

/** Quita tildes y diacríticos (solo si el texto no es ASCII puro). */
export function foldAccents(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7f]/.test(s) ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
}

const STOPWORDS = new Set([
  // ES
  'de', 'la', 'el', 'en', 'que', 'los', 'las', 'un', 'una', 'unos', 'unas', 'por', 'con', 'para', 'del', 'al', 'lo', 'se', 'es',
  'su', 'sus', 'como', 'mas', 'más', 'pero', 'sin', 'sobre', 'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso', 'hay',
  'ya', 'muy', 'cuando', 'donde', 'dónde', 'qué', 'cómo', 'cual', 'cuál', 'me', 'mi', 'te', 'tu', 'le', 'les', 'nos', 'ni', 'no',
  'si', 'sí', 'yo', 'él', 'ella', 'hace', 'hacer', 'puede', 'puedes', 'quiero', 'favor', 'archivo', 'codigo', 'código',
  // Relleno de pregunta (ES)
  'necesito', 'explica', 'explicar', 'explicame', 'explícame', 'expliques', 'explicacion', 'explicación', 'detalle', 'detalles', 'detallado',
  'funciona', 'funcionan', 'funcionamiento', 'funcionalidad', 'funcionalidades', 'describe', 'describir', 'quisiera', 'saber', 'entender',
  // EN
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'be', 'it', 'this', 'that', 'these',
  'those', 'as', 'at', 'by', 'from', 'how', 'what', 'where', 'when', 'why', 'which', 'do', 'does', 'can', 'could', 'should', 'would',
  'my', 'me', 'you', 'your', 'we', 'our', 'not', 'if', 'then', 'there', 'here', 'into', 'about', 'please', 'file', 'code',
  // Relleno de pregunta (EN)
  'explain', 'detail', 'details', 'works', 'work', 'functionality', 'feature',
].map(foldAccents));

/** Sufijos ES/EN del stemming ligero, de más largo a más corto. */
const STEM_SUFFIXES = [
  'amientos', 'imientos', 'amiento', 'imiento', 'aciones', 'iciones', 'adores', 'edores', 'idores', 'ations',
  'acion', 'icion', 'iendo', 'erias', 'ation', 'ador', 'edor', 'idor', 'ando', 'ados', 'idos', 'adas', 'idas', 'ales', 'eria',
  'ings', 'edly', 'ado', 'ido', 'ada', 'ida', 'ing', 'ers', 'al', 'ar', 'er', 'ir', 'es', 'os', 'as', 'ed', 'o', 'a', 'e', 's',
].sort((x, y) => y.length - x.length);

/** Stemming ligero ES/EN: quita el primer sufijo que encaje (de más largo a más corto) dejando ≥ 3 caracteres. */
function stemTerm(term: string): string {
  if (term.length < 4) return term;
  if (term.endsWith('ies') && term.length - 3 >= 3) return `${term.slice(0, -3)}y`;
  for (const suffix of STEM_SUFFIXES) {
    if (term.length - suffix.length >= 3 && term.endsWith(suffix)) return term.slice(0, -suffix.length);
  }
  return term;
}

const MAX_TOKEN_CHARS = 40;
const MAX_NUMERIC_CHARS = 6;

/** Separa por no alfanuméricos, camelCase y snake_case; pliega tildes; minúsculas; sin stopwords; stemming ligero. */
export function tokenize(text: string): string[] {
  const spaced = foldAccents(String(text ?? ''))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const out: string[] = [];
  for (const raw of spaced.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > MAX_TOKEN_CHARS) continue;
    const token = raw.toLowerCase();
    if (STOPWORDS.has(token)) continue;
    if (token.length > MAX_NUMERIC_CHARS && /^\d+$/.test(token)) continue;
    out.push(stemTerm(token));
  }
  return out;
}

const SYNONYM_GROUPS: string[][] = [
  ['enviar', 'envio', 'send', 'dispatch', 'publish', 'emit'],
  ['mensaje', 'message', 'msg'],
  ['grupo', 'grupal', 'group'],
  ['usuario', 'user'],
  ['chat', 'conversacion', 'conversation'],
  ['borrar', 'eliminar', 'delete', 'remove'],
  ['crear', 'create'],
  ['editar', 'modificar', 'actualizar', 'edit', 'update'],
  ['buscar', 'busqueda', 'search', 'find'],
  ['individual', 'privado', 'private', 'direct'],
  ['notificacion', 'notification'],
  ['imagen', 'image'],
  ['subir', 'upload'],
  ['descargar', 'download'],
  ['contrasena', 'password'],
  ['registro', 'registrar', 'register', 'signup'],
  ['amigo', 'friend'],
  ['reaccion', 'reaction'],
  ['llamada', 'call'],
  ['perfil', 'profile'],
  ['pagina', 'page'],
  ['ruta', 'route'],
  ['guardar', 'save', 'store'],
  ['leer', 'read'],
  ['recibir', 'receive'],
  ['respuesta', 'response', 'reply'],
  ['error', 'fallo', 'exception'],
  ['seguridad', 'security'],
  ['autenticacion', 'authentication', 'login', 'auth'],
  ['cifrar', 'cifrado', 'encrypt'],
  ['descifrar', 'decrypt'],
  ['programado', 'programar', 'schedule', 'scheduled'],
  ['temporal', 'temporary', 'ephemeral'],
  ['encuesta', 'poll'],
  ['comentario', 'comment'],
  ['documento', 'document'],
  ['tarea', 'task'],
  ['evento', 'event'],
  ['suscribir', 'suscripcion', 'subscribe', 'subscription'],
];

/** stem → stems sinónimos (sin él mismo). */
const SYNONYMS: Map<string, Set<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    const stems = [...new Set(group.map((w) => stemTerm(foldAccents(w).toLowerCase())))];
    for (const stem of stems) {
      let set = map.get(stem);
      if (!set) { set = new Set<string>(); map.set(stem, set); }
      for (const other of stems) if (other !== stem) set.add(other);
    }
  }
  return map;
})();

/* --------------------------------- tipos --------------------------------- */

export interface ContextMount {
  id: string;
  prefix: string;
  name: string;
}

export interface ContextFragment {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ContextActive extends ContextFragment {
  totalLines: number;
}

export interface ContextSelection {
  startLine: number;
  endLine: number;
  text: string;
}

export interface FlowContext {
  mounts: ContextMount[];
  mapText: string;
  fragments: ContextFragment[];
  active?: ContextActive;
  selection?: ContextSelection;
}

export interface PinnedRef {
  uri: vscode.Uri;
  range?: vscode.Range;
}

export interface CollectOptions {
  question: string;
  pinned: PinnedRef[];
  /** Rutas del mapa (con prefijo de carpeta en multi-root) que se fijan primero (archivos del flujo en PROPOSE). */
  pinnedPaths?: string[];
  useActiveEditor: boolean;
  /** Nombre de carpeta (mount) del workspace multi-root a la que se limita el contexto. */
  folder?: string;
  token: vscode.CancellationToken;
  progress?: (message: string) => void;
  /** Paso barato de selección de archivos con la IA; si falla o no existe, solo palabras clave. */
  selectFiles?: (input: { mapText: string; question: string; activePath: string | null }) => Promise<string[]>;
}

interface Scored {
  file: ProjectFileInfo;
  score: number;
}

/* -------------------------------- utilidades -------------------------------- */

function cancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('cancelled');
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function weightOf(path: string): number {
  return LOW_WEIGHT_EXTENSIONS.has(codeExtension(baseName(path))) ? 0.4 : 1;
}

function countHits(haystack: string, term: string): number {
  let count = 0;
  let from = 0;
  while (count < MAX_TERM_HITS) {
    const index = haystack.indexOf(term, from);
    if (index < 0) break;
    count++;
    from = index + term.length;
  }
  return count;
}

/** Términos de búsqueda: tokens de la pregunta, la selección y el nombre del archivo activo, más sinónimos. */
function termsOf(texts: string[]): string[] {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const token of tokenize(text)) {
      if (token.length < 3) continue;
      terms.add(token);
      for (const syn of SYNONYMS.get(token) ?? []) if (syn.length >= 3) terms.add(syn);
    }
  }
  return [...terms].slice(0, 40);
}

function allowed(file: ProjectFileInfo): boolean {
  return !file.binary && !isContextExcludedPath(file.path) && !isSensitiveCodeFile(file.name);
}

async function readText(file: ProjectFileInfo, maxBytes: number): Promise<string | null> {
  try {
    const uri = vscode.Uri.parse(file.id, true);
    const open = vscode.workspace.textDocuments.some((doc) => doc.uri.toString() === uri.toString());
    if (!open) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxBytes) return null;
    }
    const read = await readFile(file.id, 'text');
    if (!read.ok || read.binary) return null;
    return read.content.length > maxBytes ? null : read.content;
  } catch (error: unknown) {
    console.warn('[Traza] No se pudo leer un archivo del contexto.', error instanceof Error ? error.name : '');
    return null;
  }
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>, token: vscode.CancellationToken): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !token.isCancellationRequested) {
      const item = items[next++];
      await run(item);
    }
  });
  await Promise.all(workers);
}

function mapText(scored: Scored[], max: number): string {
  let out = '';
  for (const { file } of scored) {
    const line = `${file.path}\n`;
    if (out.length + line.length > max) return out + TRUNCATED.trimStart();
    out += line;
  }
  return out.trimEnd();
}

/* -------------------------------- fragmentos -------------------------------- */

interface Range0 {
  start: number;
  end: number;
}

function clampWindow(lines: string[], range: Range0, center: number): Range0 {
  let { start, end } = range;
  const length = (): number => lines.slice(start, end + 1).reduce((n, l) => n + l.length + 1, 0);
  while (length() > MAX_FRAGMENT_CHARS && end > start) {
    if (end - center >= center - start) end--;
    else start++;
  }
  return { start, end };
}

/** Fragmentos de un archivo: entero si es corto; si no, cabecera y ventanas alrededor de coincidencias o rangos fijados. */
function fragmentsOf(path: string, content: string, terms: string[], ranges: vscode.Range[]): ContextFragment[] {
  const masked = maskConfigSecrets(path, content);
  if (PRIVATE_KEY.test(masked)) return [];
  const lines = masked.split(/\r?\n/);
  if (masked.length <= FULL_FILE_CHARS) return [{ path, startLine: 1, endLine: lines.length, content: masked }];
  const centers: number[] = ranges.map((r) => Math.floor((r.start.line + r.end.line) / 2));
  if (centers.length < WINDOWS_PER_FILE && terms.length) {
    const scores = lines.map((line) => {
      const folded = foldAccents(line).toLowerCase();
      return terms.reduce((n, term) => n + (folded.includes(term) ? 1 : 0), 0);
    });
    const order = scores.map((score, index) => ({ score, index })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const { index } of order) {
      if (centers.length >= WINDOWS_PER_FILE) break;
      if (centers.every((c) => Math.abs(c - index) > WINDOW_RADIUS * 2)) centers.push(index);
    }
  }
  const windows: Range0[] = [{ start: 0, end: Math.min(lines.length, HEAD_LINES) - 1 }];
  for (const center of centers.slice(0, WINDOWS_PER_FILE)) {
    const raw = { start: Math.max(0, center - WINDOW_RADIUS), end: Math.min(lines.length - 1, center + WINDOW_RADIUS) };
    windows.push(clampWindow(lines, raw, center));
  }
  windows.sort((a, b) => a.start - b.start);
  const merged: Range0[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 1) {
      const joined = clampWindow(lines, { start: last.start, end: Math.max(last.end, w.end) }, Math.floor((last.start + w.end) / 2));
      merged[merged.length - 1] = joined;
    } else {
      merged.push(w);
    }
  }
  return merged.map((w) => ({ path, startLine: w.start + 1, endLine: w.end + 1, content: lines.slice(w.start, w.end + 1).join('\n') }));
}

/* ------------------------------ archivo activo ------------------------------ */

function activeOf(files: ProjectFileInfo[]): { active: ContextActive; selection?: ContextSelection; file: ProjectFileInfo } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const key = editor.document.uri.toString();
  const file = files.find((f) => f.id === key);
  if (!file || !allowed(file)) return null;
  const doc = editor.document;
  const text = maskConfigSecrets(file.path, doc.getText());
  if (PRIVATE_KEY.test(text)) return null;
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length - 1;
  if (text.length > ACTIVE_FULL_CHARS) {
    const sel = editor.selection;
    const center = Math.floor((sel.start.line + sel.end.line) / 2);
    start = Math.max(0, center - ACTIVE_RADIUS);
    end = Math.min(lines.length - 1, center + ACTIVE_RADIUS);
  }
  const active: ContextActive = {
    path: file.path, startLine: start + 1, endLine: end + 1, totalLines: lines.length, content: lines.slice(start, end + 1).join('\n'),
  };
  let selection: ContextSelection | undefined;
  if (!editor.selection.isEmpty) {
    const selText = maskSensitiveText(doc.getText(editor.selection)).slice(0, MAX_SELECTION_CHARS);
    if (selText.trim() && !PRIVATE_KEY.test(selText)) {
      selection = { startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1, text: selText };
    }
  }
  return { active, selection, file };
}

/* --------------------------------- principal --------------------------------- */

/** Contexto del proyecto para FLOW/PROPOSE. Lanza `Error('cancelled')` si se cancela. */
export async function collectFlowContext(options: CollectOptions): Promise<FlowContext> {
  const { token } = options;
  const report = (message: string): void => options.progress?.(message);
  report('Leyendo el proyecto…');
  const snapshot = await listFiles();
  cancelled(token);
  if (!snapshot.mounts.length) throw new Error('No hay carpetas abiertas en el workspace.');
  let candidates = snapshot.files.filter(allowed);
  let mountInfos = snapshot.mounts;
  const only = options.folder && snapshot.mounts.length > 1 ? snapshot.mounts.find((m) => m.id === options.folder) : undefined;
  if (only) {
    const prefix = `${only.id}/`;
    candidates = candidates.filter((f) => f.path.startsWith(prefix));
    mountInfos = [only];
  }
  const mounts: ContextMount[] = mountInfos.map((m) => ({ id: m.id, prefix: m.path || '(raiz)', name: m.name }));

  const activeInfo = options.useActiveEditor ? activeOf(candidates) : null;
  const terms = termsOf([options.question, activeInfo?.selection?.text ?? '', activeInfo ? baseName(activeInfo.file.path) : '']);

  // Puntuación por ruta (×3) y por contenido (el código pesa más que css/json/md).
  const scores = new Map<string, number>();
  for (const file of candidates) {
    const pathTokens = new Set(tokenize(file.path));
    const foldedPath = foldAccents(file.path).toLowerCase();
    let score = 0;
    for (const term of terms) if (pathTokens.has(term) || foldedPath.includes(term)) score += 3;
    scores.set(file.path, score * weightOf(file.path));
  }
  if (terms.length) {
    report('Buscando en el código…');
    const toScan = [...candidates]
      .sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || weightOf(b.path) - weightOf(a.path))
      .slice(0, MAX_SCAN_FILES);
    await pool(toScan, SCAN_CONCURRENCY, async (file) => {
      const content = await readText(file, MAX_SCAN_BYTES);
      if (content === null) return;
      const folded = foldAccents(content).toLowerCase();
      let score = 0;
      for (const term of terms) score += Math.log2(1 + countHits(folded, term));
      scores.set(file.path, (scores.get(file.path) ?? 0) + score * weightOf(file.path));
    }, token);
    cancelled(token);
  }
  const ranked: Scored[] = candidates
    .map((file) => ({ file, score: scores.get(file.path) ?? 0 }))
    .sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  const byPath = new Map(candidates.map((f) => [f.path, f]));

  // Archivos fijados: referencias del chat/editor y rutas del flujo.
  const pinnedRanges = new Map<string, vscode.Range[]>();
  const order: string[] = [];
  const pushPath = (path: string): void => {
    if (byPath.has(path) && !order.includes(path)) order.push(path);
  };
  for (const ref of options.pinned) {
    const file = candidates.find((f) => f.id === ref.uri.toString());
    if (!file) continue;
    pushPath(file.path);
    if (ref.range) pinnedRanges.set(file.path, [...(pinnedRanges.get(file.path) ?? []), ref.range]);
  }
  for (const path of options.pinnedPaths ?? []) pushPath(path);

  // Selección con la IA (paso barato); si falla, solo palabras clave.
  if (options.selectFiles) {
    report('Eligiendo los archivos relevantes…');
    try {
      const picked = await options.selectFiles({
        mapText: mapText(ranked, MAP_SELECT_CHARS), question: options.question, activePath: activeInfo?.file.path ?? null,
      });
      cancelled(token);
      for (const path of picked.filter((p) => byPath.has(p)).slice(0, MAX_SELECTED)) pushPath(path);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'cancelled') throw error;
      console.warn('[Traza] Selección de archivos con IA no disponible.', error instanceof Error ? error.name : '');
    }
  }
  for (const { file, score } of ranked.slice(0, KEYWORD_TOP)) if (score > 0) pushPath(file.path);

  report('Leyendo los fragmentos…');
  const fragments: ContextFragment[] = [];
  let total = 0;
  for (const path of order.slice(0, MAX_FILES)) {
    cancelled(token);
    if (activeInfo && path === activeInfo.file.path && !pinnedRanges.has(path)) continue;
    const file = byPath.get(path);
    if (!file) continue;
    const content = await readText(file, 3 * 1024 * 1024);
    if (content === null) continue;
    for (const fragment of fragmentsOf(path, content, terms, pinnedRanges.get(path) ?? [])) {
      if (fragments.length >= MAX_FRAGMENTS || total + fragment.content.length > MAX_FRAGMENTS_TOTAL) break;
      fragments.push(fragment);
      total += fragment.content.length;
    }
  }
  return {
    mounts,
    mapText: mapText(ranked, MAP_FLOW_CHARS),
    fragments,
    ...(activeInfo ? { active: activeInfo.active } : {}),
    ...(activeInfo?.selection ? { selection: activeInfo.selection } : {}),
  };
}
