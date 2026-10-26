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

const MAX_SCAN_FILES = 4000;
const MAX_SCAN_BYTES = 256 * 1024;
const SCAN_CONCURRENCY = 8;
const MAX_TERM_HITS = 20;
const MAP_FLOW_CHARS = 20_000;
const MAP_SELECT_CHARS = 40_000;
const MAX_SELECTED = 12;
const KEYWORD_TOP = 3;
const MAX_FILES = 20;
const MAX_BASE_FILES = 14;
const MAX_REF_FILES = 6;
const REF_DEPTH = 2;
const MAX_FORCED = 6;
const FORCED_BONUS = 30;
const KEYWORD_TOP_PER_MOUNT = 2;
const MAX_FILE_CHARS = 14_000;
const MIN_TRIM_CHARS = 400;
const REF_EXTENSIONS = ['java', 'kt', 'ts', 'tsx', 'js', 'jsx', 'cs', 'py', 'go', 'php', 'scala', 'groovy'];
const READ_BYTES = 3 * 1024 * 1024;
const MAX_IDENTIFIERS = 8;
const MAX_REF_TYPES = 40;
const MAX_REF_SCAN_CHARS = 400_000;
const MAX_QUESTION_ANCHORS = 12;
const MAX_ANCHOR_METHODS = 20;
const MAX_ANCHOR_WINDOWS = 3;
const ANCHOR_MAX_LINES = 120;
const ANCHOR_LEAD_LINES = 12;
const ANCHOR_BUDGET = 48_000;
const ANCHOR_ROUNDS = 3;
const MAX_FIELD_TYPES = 40;
/** Lenguajes con llaves (sin Python): permiten localizar el cuerpo de un método. */
const BRACE_EXTENSIONS = REF_EXTENSIONS.filter((ext) => ext !== 'py');
/** Fuente del tipo que cuenta como referencia (Service, Repository…); compartida por referencedParts y la detección de campos. */
const REF_TYPE_SOURCE = '[A-Z][A-Za-z0-9]{2,60}?(?:ServiceImpl|Service|Repository|Repo|Dao|Mapper|Client|Gateway|Manager|Facade|Provider|Store|Api|Adapter|UseCase)';
const FULL_FILE_CHARS = 8000;
const WINDOW_RADIUS = 50;
const WINDOWS_PER_FILE = 3;
const HEAD_LINES = 40;
const MAX_FRAGMENTS = 40;
const MAX_FRAGMENT_CHARS = 8000;
const MAX_FRAGMENTS_TOTAL = 80_000;
const ACTIVE_FULL_CHARS = 16_000;
const ACTIVE_RADIUS = 150;
const MAX_SELECTION_CHARS = 4000;
const TRUNCATED = '\n…(truncado)';
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
/** PROPOSE: plazas de archivo reservadas para lo que mejor coincide con la petición frente a los archivos fijados del flujo. */
const RESERVED_REQUEST_FILES = 6;
/** Vecindad (± líneas) en la que se cuentan los términos distintos de la petición para elegir un foco. */
const FOCUS_SPAN = 2;
/** Radio (líneas) de una ventana foco: pequeña, para no gastar el presupuesto. */
const FOCUS_RADIUS = 15;
const FOCUS_WINDOWS = 3;
/** Términos distintos mínimos en la vecindad de una línea para que sea foco (en hermanos visuales basta uno). */
const FOCUS_MIN_TERMS = 2;
/** Métodos locales (`this.metodo(`) llamados desde un foco que se incluyen enteros, por archivo. */
const MAX_LOCAL_ANCHORS = 2;
/** Archivos fuente de los que se buscan hermanos de componente, y máximo de hermanos añadidos. */
const SIBLING_SOURCES = 2;
const MAX_SIBLINGS = 4;
const SIBLING_SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'html'];
const SIBLING_EXTENSIONS = ['html', 'css', 'scss', 'sass', 'less', 'ts'];
const LOCAL_CALL = /\bthis\s*\.\s*([A-Za-z_$][\w$]{1,59})\s*\(/g;
/** Palabras que indican una petición visual (color, fondo, estilo…): activan los archivos hermanos del componente. */
const VISUAL_WORDS = [
  'color', 'colour', 'colores', 'fondo', 'background', 'estilo', 'estilos', 'style', 'styles', 'css', 'scss', 'visual', 'rojo', 'azul',
  'verde', 'amarillo', 'negro', 'blanco', 'gris', 'naranja', 'morado', 'borde', 'border', 'margen', 'margin', 'padding', 'fuente', 'font',
  'tamaño', 'icono', 'icon', 'sombra', 'shadow', 'animacion', 'animation', 'diseño', 'design', 'layout', 'tema', 'theme', 'oscuro', 'dark',
  'opacidad', 'opacity', 'hover', 'boton', 'button', 'plantilla', 'template', 'html',
];
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
  ['incorrecto', 'erroneo', 'invalido', 'incorrect', 'wrong', 'invalid'],
  ['fondo', 'background'],
  ['estilo', 'style'],
  ['boton', 'button'],
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

/** Stems de `VISUAL_WORDS`, para detectar la intención visual de la petición. */
const VISUAL_STEMS = new Set(VISUAL_WORDS.flatMap(tokenize));

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
  /** Prioridad de recorte (mayor se conserva antes); no se incluye en el prompt. */
  priority?: number;
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
  /** Canal de log (inyectado para evitar import circular); solo recibe contadores, nunca rutas ni contenido. */
  log?: Pick<vscode.LogOutputChannel, 'info' | 'warn'>;
  /** Paso barato de selección de archivos con la IA; si falla o no existe, solo palabras clave. */
  selectFiles?: (input: { mapText: string; question: string; activePath: string | null }) => Promise<string[]>;
  /** PROPOSE: reserva plazas y ventanas foco para lo que pide la petición frente a los archivos fijados del flujo. */
  prioritizeRequest?: boolean;
}

interface CodeScan {
  path: string;
  mount: string;
  key: string;
  ext: string;
  lines: string[];
  calls: CallSite[];
  located: Map<string, MethodLocation | null>;
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

/* ------------------------- reparto por carpeta y referencias ------------------------- */

/** Carpeta (primer segmento) de una ruta del mapa en multi-root; '' en single-root. */
function mountOf(path: string, multi: boolean): string {
  if (!multi) return '';
  const index = path.indexOf('/');
  return index < 0 ? path : path.slice(0, index);
}

/** Ruta sin el prefijo de carpeta (multi-root). */
function relPath(path: string, multi: boolean): string {
  if (!multi) return path;
  const index = path.indexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

function normKey(text: string): string {
  return text.replace(/[.\-_]/g, '').toLowerCase();
}

/** Nombre sin la última extensión, sin `.`, `-`, `_`, en minúsculas (`auth.service.ts` → `authservice`). */
function fileKey(name: string): string {
  const dot = name.lastIndexOf('.');
  return normKey(dot > 0 ? name.slice(0, dot) : name);
}

/** Reparto max-min: demandas de menor a mayor, cada una recibe min(demanda, restante / pendientes, tope). */
function fairShares(demands: number[], total: number, cap = Infinity): number[] {
  const out = demands.map(() => 0);
  const order = demands.map((_, index) => index).sort((a, b) => demands[a] - demands[b]);
  let remaining = total;
  order.forEach((index, position) => {
    const pending = order.length - position;
    const share = Math.max(0, Math.min(demands[index], Math.floor(remaining / pending), cap));
    out[index] = share;
    remaining -= share;
  });
  return out;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//i.test(path) || /\.(spec|test)\./i.test(path) || /Tests?\.(java|kt)$/.test(path);
}

/** Round-robin entre carpetas conservando el orden dentro de cada una. */
function interleaveByMount(paths: string[], multi: boolean): string[] {
  if (!multi) return paths;
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = mountOf(path, true);
    const group = groups.get(key);
    if (group) group.push(path);
    else groups.set(key, [path]);
  }
  const lists = [...groups.values()];
  const out: string[] = [];
  for (let round = 0; out.length < paths.length; round++) {
    for (const list of lists) if (round < list.length) out.push(list[round]);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Quita de la pregunta los nombres de carpeta del workspace (solo multi-root) y devuelve las carpetas nombradas. */
function stripMountNames(question: string, mounts: { id: string; name: string }[]): { text: string; mentioned: Set<string> } {
  const mentioned = new Set<string>();
  if (mounts.length <= 1) return { text: question, mentioned };
  let text = question;
  for (const mount of mounts) {
    for (const name of new Set([mount.id, mount.name])) {
      if (!name) continue;
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'giu');
      text = text.replace(pattern, () => {
        mentioned.add(mount.id);
        return ' ';
      });
    }
  }
  return { text, mentioned };
}

/** Claves de archivo de los identificadores citados (PascalCase compuestos y nombres tipo `login.component`). */
function identifiersOf(text: string): string[] {
  const found: { index: number; key: string }[] = [];
  const patterns = [
    /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g,
    /\b[a-z][a-z0-9-]*\.(?:component|service|controller|module|guard|interceptor|store|repository|resolver)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = normKey(match[0]);
      if (key.length >= 3 && key.length <= 60) found.push({ index: match.index ?? 0, key });
    }
  }
  const out: string[] = [];
  for (const { key } of found.sort((a, b) => a.index - b.index)) {
    if (!out.includes(key)) out.push(key);
    if (out.length >= MAX_IDENTIFIERS) break;
  }
  return out;
}

/** Tipos (Service, Repository…) que usa un archivo y, en Java/Kotlin, la entidad de un Repository<X>. */
function referencedParts(content: string, ext: string): { types: string[]; entity: string | null } {
  const text = content.length > MAX_REF_SCAN_CHARS ? content.slice(0, MAX_REF_SCAN_CHARS) : content;
  const types: string[] = [];
  const typeRegex = new RegExp(`\\b(${REF_TYPE_SOURCE})\\b`, 'g');
  const seen = new Set<string>();
  for (const match of text.matchAll(typeRegex)) {
    const key = normKey(match[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!key.endsWith('impl')) types.push(`${key}impl`);
    types.push(key);
    if (seen.size >= MAX_REF_TYPES) break;
  }
  let entity: string | null = null;
  if (ext === 'java' || ext === 'kt') {
    const match = /\b(?:Jpa|Crud|PagingAndSorting|Mongo|Reactive\w*)?Repository<\s*([A-Z]\w{1,60})/.exec(text);
    if (match) entity = normKey(match[1]);
  }
  return { types, entity };
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

/** Ventana con la prioridad de recorte (mayor se conserva antes) y si está anclada a un método. */
interface PlannedWindow extends Range0 {
  priority: number;
  anchor: boolean;
  /** Ventana foco de la petición (solo modo PROPOSE). */
  focus?: boolean;
}

type PlannedFragment = ContextFragment & { priority: number; anchor: boolean; focus?: boolean };

interface CallSite {
  line: number;
  method: string;
  targets: string[];
}

interface MethodLocation {
  decl: number;
  end: number;
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const DECL_STATEMENT = /^\s*(return|await|if|else|while|for|switch|throw|new|yield|case)\b/;
const ANNOTATION = /@[\w.]+(\([^)]*\))?/g;
const NON_METHOD_NAMES = new Set(['html', 'css', 'scss', 'json', 'md', 'xml', 'yml', 'yaml', 'properties']);
const CALL_SOURCE = '(?:^|[^\\w$.])(?:this\\.)?([a-z_$][A-Za-z0-9_$]{1,59})\\s*\\.\\s*([A-Za-z_$][A-Za-z0-9_$]{1,59})\\s*\\(';
const JAVA_FIELD_SOURCE = `\\b(${REF_TYPE_SOURCE})(?:<[^<>;(){}]{0,80}>)?\\s+([a-z_$][\\w$]{0,59})\\s*[;=,)]`;
const COLON_FIELD_SOURCE = `\\b([a-z_$][\\w$]{1,59})\\s*[?!]?\\s*:\\s*(${REF_TYPE_SOURCE})\\b(?![\\w$])`;
const INJECT_FIELD_SOURCE = `\\b([a-z_$][\\w$]{1,59})\\s*=\\s*inject\\s*(?:<[^<>()]{0,80}>)?\\s*\\(\\s*(${REF_TYPE_SOURCE})\\b`;

/** Métodos citados en la pregunta: camelCase compuestos (todos los archivos) y `Clase.metodo` (solo el archivo de esa clase). */
function methodAnchorsOf(text: string): { global: string[]; scoped: Map<string, string[]> } {
  const found: { index: number; method: string; scope: string | null }[] = [];
  for (const match of text.matchAll(/\b[a-z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+\b/g)) {
    if (match[0].length >= 2 && match[0].length <= 60) found.push({ index: match.index ?? 0, method: match[0], scope: null });
  }
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]{1,60})\.([a-z_$][A-Za-z0-9_$]{1,59})\b/g)) {
    const method = match[2];
    if (REF_EXTENSIONS.includes(method) || NON_METHOD_NAMES.has(method)) continue;
    found.push({ index: match.index ?? 0, method, scope: normKey(match[1]) });
  }
  found.sort((a, b) => a.index - b.index);
  const global: string[] = [];
  const scoped = new Map<string, string[]>();
  let count = 0;
  for (const { method, scope } of found) {
    if (count >= MAX_QUESTION_ANCHORS) break;
    if (scope === null) {
      if (global.includes(method)) continue;
      global.push(method);
    } else {
      const list = scoped.get(scope);
      if (list?.includes(method)) continue;
      if (list) list.push(method);
      else scoped.set(scope, [method]);
    }
    count++;
  }
  return { global, scoped };
}

/** Campos/variables cuyo tipo es un Service/Repository…: nombre → claves de archivo destino (`tipo` y `tipoimpl`). */
function fieldTypesOf(content: string, ext: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const text = content.length > MAX_REF_SCAN_CHARS ? content.slice(0, MAX_REF_SCAN_CHARS) : content;
  const patterns: { source: string; name: number; type: number }[] = [];
  if (ext === 'java' || ext === 'cs' || ext === 'groovy') patterns.push({ source: JAVA_FIELD_SOURCE, name: 2, type: 1 });
  if (ext === 'kt' || ext === 'scala' || ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
    patterns.push({ source: COLON_FIELD_SOURCE, name: 1, type: 2 });
  }
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') patterns.push({ source: INJECT_FIELD_SOURCE, name: 1, type: 2 });
  for (const { source, name, type } of patterns) {
    for (const match of text.matchAll(new RegExp(source, 'g'))) {
      const field = match[name];
      const key = normKey(match[type]);
      let targets = out.get(field);
      if (!targets) {
        if (out.size >= MAX_FIELD_TYPES) continue;
        targets = [];
        out.set(field, targets);
      }
      if (!targets.includes(key)) targets.push(key);
      if (!key.endsWith('impl') && !targets.includes(`${key}impl`)) targets.push(`${key}impl`);
    }
  }
  return out;
}

/** Llamadas `(this.)?campo.metodo(` sobre los campos dados, línea a línea (0-based); ignora comentarios. */
function callsOf(lines: string[], fields: Map<string, string[]>): CallSite[] {
  const out: CallSite[] = [];
  if (!fields.size) return out;
  const regex = new RegExp(CALL_SOURCE, 'g');
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    chars += line.length + 1;
    if (chars > MAX_REF_SCAN_CHARS) break;
    if (!line.includes('.') || !line.includes('(')) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    regex.lastIndex = 0;
    for (let match = regex.exec(line); match; match = regex.exec(line)) {
      const targets = fields.get(match[1]);
      if (targets) out.push({ line: i, method: match[2], targets });
      // El `(` final sirve de separador previo para una llamada anidada.
      regex.lastIndex = Math.max(match.index + 1, match.index + match[0].length - 1);
    }
  }
  return out;
}

function cleanLine(line: string): string {
  return line.replace(STRING_LITERAL, '""').replace(/\/\/.*$/, '');
}

/** Desde la declaración en `start`, línea (0-based) de cierre del cuerpo por conteo de llaves; null si no hay cuerpo. Máx `ANCHOR_MAX_LINES` líneas. */
function braceBody(lines: string[], start: number): number | null {
  let depth = 0;
  let opened = false;
  const last = Math.min(lines.length - 1, start + ANCHOR_MAX_LINES - 1);
  for (let i = start; i <= last; i++) {
    for (const ch of cleanLine(lines[i])) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) return i;
      } else if (ch === ';' && !opened) {
        return null;
      }
    }
  }
  return opened ? last : null;
}

/** Línea del `;` de una firma sin cuerpo (interfaz/abstracta/repositorio) en las 6 líneas desde `start`; -1 si no. */
function signatureEnd(lines: string[], start: number): number {
  for (let i = start; i < Math.min(lines.length, start + 6); i++) {
    const clean = cleanLine(lines[i]);
    const semi = clean.indexOf(';');
    const brace = clean.indexOf('{');
    if (brace >= 0 && (semi < 0 || brace < semi)) return -1;
    if (semi >= 0) return i;
  }
  return -1;
}

function locateMethod(lines: string[], method: string, ext: string): MethodLocation | null {
  if (!BRACE_EXTENSIONS.includes(ext)) return null;
  const name = escapeRegExp(method);
  const call = new RegExp(`(^|[^.\\w$])${name}\\s*(<[^>]*>)?\\s*\\(`);
  const assigned = new RegExp(`(^|[^.\\w$])${name}\\s*[=:]\\s*(async\\s*)?(function\\b|\\(|[\\w$]+\\s*=>)`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(method) || DECL_STATEMENT.test(line)) continue;
    const match = call.exec(line) ?? assigned.exec(line);
    if (!match) continue;
    let prefix = line.slice(0, match.index + match[1].length).replace(ANNOTATION, ' ');
    for (let n = 0; n < 3; n++) prefix = prefix.replace(/<[^<>]*>/g, '');
    if (/[=(,+!&|]/.test(prefix)) continue;
    const body = braceBody(lines, i);
    if (body !== null) return { decl: i, end: body };
    if (prefix.trim()) {
      const signature = signatureEnd(lines, i);
      if (signature >= 0) return { decl: i, end: signature };
    }
  }
  return null;
}

/** Línea (0-based) de la primera declaración del método, o -1. */
function findDeclaration(lines: string[], method: string, ext: string): number {
  return locateMethod(lines, method, ext)?.decl ?? -1;
}

/** Ventana de la declaración (con anotaciones/javadoc previos) y el cuerpo del método; recorta por el final para conservar la firma. */
function anchorWindow(lines: string[], method: string, ext: string): Range0 | null {
  const found = locateMethod(lines, method, ext);
  if (!found) return null;
  let start = found.decl;
  for (let lead = 0; start > 0 && lead < ANCHOR_LEAD_LINES; lead++) {
    const previous = lines[start - 1].trim();
    if (!previous || /[;{}]$/.test(previous)) break;
    start--;
  }
  return clampWindow(lines, { start, end: found.end }, start);
}

/**
 * Fragmentos de un archivo: entero si es corto; si no, cabecera, rangos fijados, ventanas ancladas a métodos
 * (declaración y cuerpo) y ventanas alrededor de coincidencias de términos en los huecos restantes.
 * Con `focusMinTerms` (PROPOSE) añade ventanas foco de prioridad alta alrededor de las líneas cuya vecindad contiene
 * al menos ese número de términos distintos, más el cuerpo de los métodos locales que esas líneas llaman.
 */
function fragmentsOf(
  path: string, content: string, terms: string[], ranges: vscode.Range[], anchors: string[], focusMinTerms?: number,
): PlannedFragment[] {
  const masked = maskConfigSecrets(path, content);
  if (PRIVATE_KEY.test(masked)) return [];
  const lines = masked.split(/\r?\n/);
  const ext = codeExtension(baseName(path));
  const useAnchors = anchors.length > 0 && BRACE_EXTENSIONS.includes(ext);
  const focusOn = focusMinTerms !== undefined && terms.length > 0;
  const minTerms = focusMinTerms ?? 0;
  /** Índices de término presentes en cada línea y términos distintos en su vecindad (solo con foco). */
  const lineTerms: number[][] = [];
  const neigh: number[] = [];
  if (focusOn) {
    for (const line of lines) {
      const folded = foldAccents(line).toLowerCase();
      const hit: number[] = [];
      for (let t = 0; t < terms.length; t++) if (folded.includes(terms[t])) hit.push(t);
      lineTerms.push(hit);
    }
    for (let i = 0; i < lines.length; i++) {
      const distinct = new Set<number>();
      for (let j = Math.max(0, i - FOCUS_SPAN); j <= Math.min(lines.length - 1, i + FOCUS_SPAN); j++) for (const t of lineTerms[j]) distinct.add(t);
      neigh.push(distinct.size);
    }
  }
  const isFocusLine = (i: number): boolean => lineTerms[i].length > 0 && neigh[i] >= minTerms;
  if (masked.length <= FULL_FILE_CHARS) {
    const anchored = useAnchors && anchors.some((name) => findDeclaration(lines, name, ext) >= 0);
    const focused = focusOn && lines.some((_, i) => isFocusLine(i));
    return [{
      path, startLine: 1, endLine: lines.length, content: masked, priority: anchored || focused ? 3 : 2, anchor: anchored,
      ...(focused ? { focus: true } : {}),
    }];
  }
  const around = (center: number): Range0 =>
    clampWindow(lines, { start: Math.max(0, center - WINDOW_RADIUS), end: Math.min(lines.length - 1, center + WINDOW_RADIUS) }, center);
  const windows: PlannedWindow[] = [{ start: 0, end: Math.min(lines.length, HEAD_LINES) - 1, priority: 2, anchor: false }];
  const fixed: number[] = ranges.map((r) => Math.floor((r.start.line + r.end.line) / 2));
  const fixedUsed = fixed.slice(0, WINDOWS_PER_FILE);
  for (const center of fixedUsed) windows.push({ ...around(center), priority: 3, anchor: false });
  const focusWindows: Range0[] = [];
  const focusCenters: number[] = [];
  if (focusOn) {
    const inFixed = (i: number): boolean => windows.slice(1).some((w) => i >= w.start && i <= w.end);
    const candidates: number[] = [];
    for (let i = 0; i < lines.length; i++) if (isFocusLine(i) && !inFixed(i)) candidates.push(i);
    candidates.sort((a, b) => neigh[b] - neigh[a] || lineTerms[b].length - lineTerms[a].length || a - b);
    for (const c of candidates) {
      if (focusCenters.length >= FOCUS_WINDOWS) break;
      if (!focusCenters.every((other) => Math.abs(other - c) > FOCUS_RADIUS * 2)) continue;
      const window = clampWindow(lines, { start: Math.max(0, c - FOCUS_RADIUS), end: Math.min(lines.length - 1, c + FOCUS_RADIUS) }, c);
      focusCenters.push(c);
      focusWindows.push(window);
      windows.push({ ...window, priority: 3, anchor: false, focus: true });
    }
  }
  const anchoredWindows: Range0[] = [];
  if (useAnchors) {
    for (const name of anchors.slice(0, MAX_ANCHOR_METHODS)) {
      if (anchoredWindows.length >= MAX_ANCHOR_WINDOWS) break;
      const window = anchorWindow(lines, name, ext);
      if (!window) continue;
      if (windows.slice(1).some((w) => w.start <= window.start && w.end >= window.end)) continue;
      windows.push({ ...window, priority: 3, anchor: true });
      anchoredWindows.push(window);
    }
  }
  // Métodos locales (`this.metodo(`) llamados desde una línea foco: declaración y cuerpo, aparte del tope de anclas.
  const localWindows: Range0[] = [];
  if (focusCenters.length && BRACE_EXTENSIONS.includes(ext)) {
    const tried = new Set<string>();
    for (const c of focusCenters) {
      if (localWindows.length >= MAX_LOCAL_ANCHORS) break;
      const near = lines.slice(Math.max(0, c - FOCUS_SPAN), Math.min(lines.length, c + FOCUS_SPAN + 1)).join('\n');
      for (const match of near.matchAll(LOCAL_CALL)) {
        if (localWindows.length >= MAX_LOCAL_ANCHORS) break;
        const name = match[1];
        if (tried.has(name)) continue;
        tried.add(name);
        const window = anchorWindow(lines, name, ext);
        if (!window || (window.start <= c && window.end >= c)) continue;
        if (windows.slice(1).some((w) => w.start <= window.start && w.end >= window.end)) continue;
        windows.push({ ...window, priority: 3, anchor: true });
        localWindows.push(window);
      }
    }
  }
  const gaps = WINDOWS_PER_FILE - fixedUsed.length - anchoredWindows.length;
  if (gaps > 0 && terms.length) {
    const scores = lines.map((line) => {
      const folded = foldAccents(line).toLowerCase();
      return terms.reduce((n, term) => n + (folded.includes(term) ? 1 : 0), 0);
    });
    const order = scores.map((score, index) => ({ score, index })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
    const centers: number[] = [];
    for (const { index } of order) {
      if (centers.length >= gaps) break;
      if (anchoredWindows.some((w) => index >= w.start && index <= w.end)) continue;
      if (focusWindows.some((w) => index >= w.start && index <= w.end) || localWindows.some((w) => index >= w.start && index <= w.end)) continue;
      if ([...fixed, ...centers].every((c) => Math.abs(c - index) > WINDOW_RADIUS * 2)) centers.push(index);
    }
    for (const center of centers) windows.push({ ...around(center), priority: 1, anchor: false });
  }
  windows.sort((a, b) => a.start - b.start || b.priority - a.priority);
  const charsOf = (start: number, end: number): number => lines.slice(start, end + 1).reduce((n, l) => n + l.length + 1, 0);
  const merged: PlannedWindow[] = [];
  const place = (w: PlannedWindow): void => {
    const last = merged[merged.length - 1];
    if (last && w.start === last.end + 1 && w.priority === last.priority && charsOf(last.start, w.end) <= MAX_FRAGMENT_CHARS) {
      last.end = w.end;
      last.anchor = last.anchor || w.anchor;
      if (w.focus) last.focus = true;
    } else {
      merged.push(w);
    }
  };
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.priority = Math.max(last.priority, w.priority);
      if (w.focus) last.focus = true;
      if (w.end <= last.end) last.anchor = last.anchor || w.anchor;
      else place({ ...w, start: last.end + 1 });
    } else {
      place({ ...w });
    }
  }
  return merged.map((w) => ({
    path, startLine: w.start + 1, endLine: w.end + 1, content: lines.slice(w.start, w.end + 1).join('\n'), priority: w.priority, anchor: w.anchor,
    ...(w.focus ? { focus: true } : {}),
  }));
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
  const listed = snapshot.files.length;
  let candidates = snapshot.files.filter(allowed);
  const excluded = listed - candidates.length;
  let mountInfos = snapshot.mounts;
  const only = options.folder && snapshot.mounts.length > 1 ? snapshot.mounts.find((m) => m.id === options.folder) : undefined;
  if (only) {
    const prefix = `${only.id}/`;
    candidates = candidates.filter((f) => f.path.startsWith(prefix));
    mountInfos = [only];
  }
  const mounts: ContextMount[] = mountInfos.map((m) => ({ id: m.id, prefix: m.path || '(raiz)', name: m.name }));
  /** Las rutas llevan prefijo de carpeta (hay varias abiertas, aunque el contexto se limite a una). */
  const prefixed = snapshot.mounts.length > 1;
  /** Reparto e intercalado entre carpetas (más de una en juego). */
  const multi = mountInfos.length > 1;
  const countBy = (paths: Iterable<string>): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const path of paths) {
      const key = mountOf(path, prefixed);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const perMount = (counts: Map<string, number>): string =>
    mountInfos.map((m) => `${m.id}=${counts.get(prefixed ? m.id : '') ?? 0}`).join(' ');

  const activeInfo = options.useActiveEditor ? activeOf(candidates) : null;
  const { text: questionText, mentioned } = stripMountNames(options.question, multi ? mountInfos : []);
  const ids = identifiersOf(questionText);
  const terms = termsOf([questionText, activeInfo?.selection?.text ?? '', activeInfo ? baseName(activeInfo.file.path) : '']);

  // Puntuación por ruta (×3, sin el prefijo de carpeta) y por contenido (el código pesa más que css/json/md).
  const scores = new Map<string, number>();
  const forcedByKey = new Map<string, ProjectFileInfo[]>();
  const forcedSeen = new Set<string>();
  for (const file of candidates) {
    const rel = relPath(file.path, prefixed);
    const pathTokens = new Set(tokenize(rel));
    const foldedPath = foldAccents(rel).toLowerCase();
    let score = 0;
    for (const term of terms) if (pathTokens.has(term) || foldedPath.includes(term)) score += 3;
    score *= weightOf(file.path);
    const key = fileKey(file.name);
    if (ids.includes(key) && !isTestPath(file.path) && weightOf(file.path) >= 1) {
      const unique = `${mountOf(file.path, prefixed)}|${key}|${codeExtension(file.name)}`;
      if (!forcedSeen.has(unique)) {
        forcedSeen.add(unique);
        score += FORCED_BONUS;
        const list = forcedByKey.get(key);
        if (list) list.push(file);
        else forcedByKey.set(key, [file]);
      }
    }
    scores.set(file.path, score);
  }
  const forced: ProjectFileInfo[] = ids.flatMap((id) => forcedByKey.get(id) ?? []).slice(0, MAX_FORCED);

  // Escaneo de contenido repartido por carpeta (ninguna lo agota; lo no usado pasa a las demás).
  const groups = new Map<string, ProjectFileInfo[]>();
  for (const file of candidates) {
    const key = mountOf(file.path, prefixed);
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  const groupList = [...groups.values()].map((group) =>
    group.sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || weightOf(b.path) - weightOf(a.path)));
  const scanShares = fairShares(groupList.map((g) => g.length), MAX_SCAN_FILES);
  const toScan: ProjectFileInfo[] = groupList.flatMap((group, index) => group.slice(0, scanShares[index]));
  const scanSet = new Set(toScan.map((f) => f.path));
  for (const file of forced) {
    if (scanSet.has(file.path)) continue;
    scanSet.add(file.path);
    toScan.push(file);
  }
  if (terms.length) {
    report('Buscando en el código…');
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
  // Mapa: en multi-root, primero lo puntuado y luego el resto, intercalando carpetas.
  let mapRanked = ranked;
  if (multi) {
    const scoredByPath = new Map(ranked.map((r) => [r.file.path, r]));
    const toScored = (paths: string[]): Scored[] => interleaveByMount(paths, true).map((p) => scoredByPath.get(p) as Scored);
    mapRanked = [
      ...toScored(ranked.filter((r) => r.score > 0).map((r) => r.file.path)),
      ...toScored(ranked.filter((r) => r.score <= 0).map((r) => r.file.path)),
    ];
  }

  // Archivos fijados: referencias del chat/editor y rutas del flujo (siempre primero y sin intercalar).
  const pinnedRanges = new Map<string, vscode.Range[]>();
  const pinnedOrder: string[] = [];
  const rest: string[] = [];
  const prioritize = options.prioritizeRequest === true;
  /** Archivos del flujo (PROPOSE con `prioritizeRequest`): se fijan tras la selección, dejando plazas a la petición. */
  const flowPinned: string[] = [];
  const pushPinned = (path: string): void => {
    if (byPath.has(path) && !pinnedOrder.includes(path)) pinnedOrder.push(path);
  };
  const pushPath = (path: string): void => {
    if (byPath.has(path) && !pinnedOrder.includes(path) && !rest.includes(path)) rest.push(path);
  };
  for (const ref of options.pinned) {
    const file = candidates.find((f) => f.id === ref.uri.toString());
    if (!file) continue;
    pushPinned(file.path);
    if (ref.range) pinnedRanges.set(file.path, [...(pinnedRanges.get(file.path) ?? []), ref.range]);
  }
  for (const path of options.pinnedPaths ?? []) {
    if (!prioritize) pushPinned(path);
    else if (byPath.has(path) && !pinnedOrder.includes(path) && !flowPinned.includes(path)) flowPinned.push(path);
  }

  // Archivos cuyo nombre coincide con un identificador citado.
  for (const file of forced) pushPath(file.path);

  // Selección con la IA (paso barato); si falla, forzados + palabras clave por carpeta + referencias.
  let aiPicked = 0;
  let valid: string[] = [];
  if (options.selectFiles) {
    report('Eligiendo los archivos relevantes…');
    try {
      const picked = await options.selectFiles({
        mapText: mapText(mapRanked, MAP_SELECT_CHARS), question: options.question, activePath: activeInfo?.file.path ?? null,
      });
      cancelled(token);
      valid = picked.filter((p) => byPath.has(p)).slice(0, MAX_SELECTED);
      aiPicked = valid.length;
      for (const path of valid) pushPath(path);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'cancelled') throw error;
      console.warn('[Traza] Selección de archivos con IA no disponible.', error instanceof Error ? error.name : '');
      options.log?.warn(`Contexto · selección IA no disponible (${error instanceof Error ? error.name : 'Error'})`);
    }
  }
  for (const { file, score } of ranked.slice(0, KEYWORD_TOP)) if (score > 0) pushPath(file.path);
  if (multi) {
    const best = new Map<string, number>();
    for (const { file, score } of ranked) {
      const key = mountOf(file.path, true);
      if (!best.has(key)) best.set(key, score);
    }
    const globalBest = ranked.length ? ranked[0].score : 0;
    for (const mount of mountInfos) {
      const relevant = mentioned.size > 0
        ? mentioned.has(mount.id)
        : globalBest > 0 && (best.get(mount.id) ?? 0) >= globalBest * 0.5;
      if (!relevant) continue;
      let taken = 0;
      for (const { file, score } of ranked) {
        if (taken >= KEYWORD_TOP_PER_MOUNT || score <= 0) break;
        if (mountOf(file.path, true) !== mount.id) continue;
        pushPath(file.path);
        taken++;
      }
    }
  }
  let base: string[];
  let siblings: string[] = [];
  const siblingSet = new Set<string>();
  if (!prioritize) {
    base = interleaveByMount(rest, multi).slice(0, Math.max(0, MAX_BASE_FILES - pinnedOrder.length));
  } else {
    // Los archivos del flujo se ordenan por relevancia (elegidos por la IA, puntuación, orden original) y dejan plazas a la petición.
    const aiSet = new Set(valid);
    const originalOrder = new Map(flowPinned.map((path, i) => [path, i]));
    flowPinned.sort((a, b) =>
      (aiSet.has(b) ? 1 : 0) - (aiSet.has(a) ? 1 : 0)
      || (scores.get(b) ?? 0) - (scores.get(a) ?? 0)
      || (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));
    const refPinned = [...pinnedOrder];
    const reserve = Math.min(RESERVED_REQUEST_FILES, Math.max(0, MAX_FILES - refPinned.length));
    pinnedOrder.push(...flowPinned.slice(0, Math.max(0, MAX_FILES - refPinned.length - reserve)));

    // Hermanos del componente (html/css/ts con la misma base) de los mejores fuentes, si la petición es visual.
    if (terms.some((term) => VISUAL_STEMS.has(term))) {
      const siblingsOf = (path: string): string[] => {
        const own = codeExtension(baseName(path));
        const stem = path.slice(0, path.length - own.length - 1);
        return SIBLING_EXTENSIONS
          .filter((ext) => ext !== own)
          .map((ext) => `${stem}.${ext}`)
          .filter((sibling) => byPath.has(sibling) && !isTestPath(sibling));
      };
      const sources = [...new Set([...refPinned, ...flowPinned, ...rest])]
        .filter((path) =>
          (scores.get(path) ?? 0) > 0 && !isTestPath(path) && SIBLING_SOURCE_EXTENSIONS.includes(codeExtension(baseName(path)))
          && siblingsOf(path).length > 0)
        .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
        .slice(0, SIBLING_SOURCES);
      for (const source of sources) for (const sibling of siblingsOf(source)) siblingSet.add(sibling);
      siblings = [...siblingSet].slice(0, MAX_SIBLINGS);
    }
    const inPinned = new Set(pinnedOrder);
    const requestPaths = [...new Set([...siblings, ...interleaveByMount(rest, multi)])].filter((path) => !inPinned.has(path));
    base = requestPaths.slice(0, Math.max(0, Math.min(MAX_FILES - pinnedOrder.length, Math.max(reserve, MAX_BASE_FILES - pinnedOrder.length))));
  }
  const finalPaths = [...pinnedOrder.slice(0, MAX_FILES), ...base];

  // Contenido de los archivos (caché compartida entre la expansión por referencias y los fragmentos).
  const contents = new Map<string, string | null>();
  const contentOf = async (file: ProjectFileInfo): Promise<string | null> => {
    if (contents.has(file.path)) return contents.get(file.path) ?? null;
    const content = await readText(file, READ_BYTES);
    contents.set(file.path, content);
    return content;
  };

  // Expansión por referencias (Controller → ServiceImpl → Repository → entidad), solo en la misma carpeta.
  const index = new Map<string, Map<string, ProjectFileInfo[]>>();
  for (const file of candidates) {
    if (isTestPath(file.path) || !REF_EXTENSIONS.includes(codeExtension(file.name))) continue;
    const mountKey = mountOf(file.path, prefixed);
    let byKey = index.get(mountKey);
    if (!byKey) {
      byKey = new Map();
      index.set(mountKey, byKey);
    }
    const key = fileKey(file.name);
    const list = byKey.get(key);
    if (list) list.push(file);
    else byKey.set(key, [file]);
  }
  const included = new Set(finalPaths);
  const queue = finalPaths.map((path) => ({ path, depth: 0 }));
  let refsAdded = 0;
  for (let q = 0; q < queue.length; q++) {
    cancelled(token);
    if (refsAdded >= MAX_REF_FILES || finalPaths.length >= MAX_FILES) break;
    const { path, depth } = queue[q];
    const file = byPath.get(path);
    if (!file) continue;
    const ext = codeExtension(file.name);
    if (!REF_EXTENSIONS.includes(ext)) continue;
    const withTypes = depth < REF_DEPTH;
    if (!withTypes && ext !== 'java' && ext !== 'kt') continue;
    const content = await contentOf(file);
    if (content === null) continue;
    const parts = referencedParts(content, ext);
    const keys = [...(withTypes ? parts.types : []), ...(parts.entity ? [parts.entity] : [])];
    const byKey = index.get(mountOf(path, prefixed));
    let offset = 0;
    for (const key of keys) {
      if (refsAdded >= MAX_REF_FILES || finalPaths.length >= MAX_FILES) break;
      const list = byKey?.get(key);
      if (!list || list.some((f) => included.has(f.path))) continue;
      const target = list[0];
      finalPaths.splice(finalPaths.indexOf(path) + 1 + offset, 0, target.path);
      included.add(target.path);
      queue.push({ path: target.path, depth: depth + 1 });
      offset++;
      refsAdded++;
    }
  }

  // Anclas: métodos citados en la pregunta (rank 1), llamados desde el cuerpo de un método anclado en otro archivo (rank 2)
  // o llamados en cualquier punto con un nombre afín a la pregunta (rank 3).
  const questionAnchors = methodAnchorsOf(questionText);
  const scans: CodeScan[] = [];
  if (questionAnchors.global.length || questionAnchors.scoped.size || terms.length) {
    for (const path of finalPaths) {
      cancelled(token);
      const file = byPath.get(path);
      if (!file) continue;
      const ext = codeExtension(file.name);
      if (!BRACE_EXTENSIONS.includes(ext)) continue;
      const content = await contentOf(file);
      if (content === null) continue;
      const lines = content.split(/\r?\n/);
      scans.push({ path, mount: mountOf(path, prefixed), key: fileKey(file.name), ext, lines, calls: callsOf(lines, fieldTypesOf(content, ext)), located: new Map() });
    }
  }
  const scanByPath = new Map(scans.map((s) => [s.path, s]));
  const finalKeys = new Set(scans.map((s) => `${s.mount}|${s.key}`));
  const called = new Map<string, Map<string, number>>();
  const setCalled = (destKey: string, method: string, rank: number): boolean => {
    let methods = called.get(destKey);
    if (!methods) {
      methods = new Map();
      called.set(destKey, methods);
    }
    const current = methods.get(method);
    if (current !== undefined) {
      if (current <= rank) return false;
      methods.set(method, rank);
      return true;
    }
    if (methods.size >= MAX_ANCHOR_METHODS) {
      let worst: string | null = null;
      let worstRank = rank;
      for (const [name, r] of methods) {
        if (r > worstRank) {
          worst = name;
          worstRank = r;
        }
      }
      if (worst === null) return false;
      methods.delete(worst);
    }
    methods.set(method, rank);
    return true;
  };
  const addTargets = (scan: CodeScan, call: CallSite, rank: number): boolean => {
    let changed = false;
    for (const target of call.targets) {
      const destKey = `${scan.mount}|${target}`;
      if (finalKeys.has(destKey) && setCalled(destKey, call.method, rank)) changed = true;
    }
    return changed;
  };
  /** Métodos anclados de un archivo con su rank (menor = más importante). */
  const ownAnchors = (scan: CodeScan): Map<string, number> => {
    const out = new Map<string, number>();
    for (const method of questionAnchors.global) out.set(method, 1);
    for (const method of questionAnchors.scoped.get(scan.key) ?? []) out.set(method, 1);
    for (const [method, rank] of called.get(`${scan.mount}|${scan.key}`) ?? []) {
      const current = out.get(method);
      if (current === undefined || current > rank) out.set(method, rank);
    }
    return out;
  };
  const locate = (scan: CodeScan, method: string): MethodLocation | null => {
    if (!scan.located.has(method)) scan.located.set(method, locateMethod(scan.lines, method, scan.ext));
    return scan.located.get(method) ?? null;
  };
  if (scans.length) {
    const termSet = new Set(terms);
    for (const scan of scans) {
      cancelled(token);
      for (const call of scan.calls) if (tokenize(call.method).some((t) => termSet.has(t))) addTargets(scan, call, 3);
    }
    for (let round = 0; round < ANCHOR_ROUNDS; round++) {
      let changed = false;
      for (const scan of scans) {
        cancelled(token);
        if (!scan.calls.length) continue;
        for (const [method, rank] of ownAnchors(scan)) {
          if (rank > 2) continue;
          const found = locate(scan, method);
          if (!found) continue;
          for (const call of scan.calls) {
            if (call.line >= found.decl && call.line <= found.end && addTargets(scan, call, 2)) changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }
  const anchorsFor = (path: string): string[] => {
    const scan = scanByPath.get(path);
    if (!scan) return [];
    return [...ownAnchors(scan)].sort((a, b) => a[1] - b[1]).slice(0, MAX_ANCHOR_METHODS).map(([method]) => method);
  };

  // Fragmentos: el presupuesto se reparte entre archivos (primero lo anclado) para que unos pocos grandes no lo consuman.
  report('Leyendo los fragmentos…');
  const entries: { path: string; fragments: PlannedFragment[]; demand: number; anchorDemand: number }[] = [];
  for (const path of finalPaths) {
    cancelled(token);
    if (activeInfo && path === activeInfo.file.path && !pinnedRanges.has(path)) continue;
    const file = byPath.get(path);
    if (!file) continue;
    const content = await contentOf(file);
    if (content === null) continue;
    const list = fragmentsOf(path, content, terms, pinnedRanges.get(path) ?? [], anchorsFor(path), prioritize ? (siblingSet.has(path) ? 1 : FOCUS_MIN_TERMS) : undefined);
    if (!list.length) continue;
    entries.push({
      path,
      fragments: list,
      demand: list.reduce((n, f) => n + f.content.length, 0),
      anchorDemand: list.reduce((n, f) => n + (f.priority >= 3 ? f.content.length : 0), 0),
    });
  }
  const anchorShares = fairShares(entries.map((e) => Math.min(e.anchorDemand, MAX_FILE_CHARS)), ANCHOR_BUDGET, MAX_FILE_CHARS);
  const anchorTotal = anchorShares.reduce((n, v) => n + v, 0);
  const restShares = fairShares(
    entries.map((e, i) => Math.max(0, Math.min(e.demand, MAX_FILE_CHARS) - anchorShares[i])),
    Math.max(0, MAX_FRAGMENTS_TOTAL - anchorTotal),
    MAX_FILE_CHARS,
  );
  const fragments: ContextFragment[] = [];
  const fragmentFiles: string[] = [];
  let total = 0;
  let anchorCount = 0;
  let focusCount = 0;
  for (let i = 0; i < entries.length; i++) {
    let left = anchorShares[i] + restShares[i];
    const kept: PlannedFragment[] = [];
    let full = false;
    const ordered = [...entries[i].fragments].sort((a, b) => b.priority - a.priority || a.startLine - b.startLine);
    for (const fragment of ordered) {
      if (fragments.length + kept.length >= MAX_FRAGMENTS) {
        full = true;
        break;
      }
      if (fragment.content.length <= left) {
        kept.push(fragment);
        left -= fragment.content.length;
        total += fragment.content.length;
        continue;
      }
      // No cabe: se recorta por líneas desde el final y se pasa al siguiente archivo.
      const lines = fragment.content.split('\n');
      let size = 0;
      let count = 0;
      for (const line of lines) {
        const next = size + line.length + (count ? 1 : 0);
        if (next > left) break;
        size = next;
        count++;
      }
      if (count > 0 && size >= MIN_TRIM_CHARS) {
        kept.push({ ...fragment, endLine: fragment.startLine + count - 1, content: lines.slice(0, count).join('\n') });
        total += size;
      }
      break;
    }
    kept.sort((a, b) => a.startLine - b.startLine);
    for (const fragment of kept) {
      fragments.push({ path: fragment.path, startLine: fragment.startLine, endLine: fragment.endLine, content: fragment.content, priority: fragment.priority });
      fragmentFiles.push(fragment.path);
      if (fragment.anchor) anchorCount++;
      if (fragment.focus) focusCount++;
    }
    if (full) break;
  }

  options.log?.info(
    `Contexto · carpetas=${mountInfos.length} · listados=${listed} · excluidos=${excluded} · candidatos ${perMount(countBy(candidates.map((f) => f.path)))}`
    + ` · escaneados ${perMount(countBy(toScan.map((f) => f.path)))} · forzados=${forced.length} · IA=${aiPicked} · claves=${ids.length}`
    + ` · referencias=${refsAdded} · anclas=${anchorCount} · archivos ${perMount(countBy(new Set(fragmentFiles)))} · fragmentos=${fragments.length} (${total} caracteres)`
    + (prioritize ? ` · foco=${focusCount} · hermanos=${siblings.length}` : ''),
  );
  return {
    mounts,
    mapText: mapText(mapRanked, MAP_FLOW_CHARS),
    fragments,
    ...(activeInfo ? { active: activeInfo.active } : {}),
    ...(activeInfo?.selection ? { selection: activeInfo.selection } : {}),
  };
}
