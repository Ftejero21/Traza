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
const MAX_REF_FILES = 8;
/** Referencias (Controller → Service → Repository…) máximas por carpeta cuando hay varias en juego. */
const MAX_REF_FILES_PER_MOUNT = 4;
/** Puente HTTP front → back: archivos del back añadidos, peticiones analizadas y archivos del front que se examinan. */
const MAX_BRIDGE_FILES = 3;
const MAX_HTTP_CALLS = 24;
const MAX_BRIDGE_SOURCES = 8;
/** FLOW multi-root: una carpeta cuenta como relevante con esta fracción de la mejor puntuación (PROPOSE mantiene 0.5). */
const FLOW_MOUNT_RELEVANCE = 0.2;
const KEYWORD_TOP_PER_MOUNT_FLOW = 3;
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
export const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
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

const MAX_BRIDGE_HINTS = 12;

export type FolderLayer = 'front' | 'back' | 'datos';

/** Rol de una carpeta del workspace, detectado solo por nombres de archivo (sin leer contenido). */
export interface FolderRole {
  mount: string;
  roles: FolderLayer[];
  tech: string[];
}

/** Pareja detectada llamada del front → handler del back (rutas como en el mapa). */
export interface BridgeHint {
  front: string;
  line: number;
  method: string;
  back: string;
  handler: string | null;
}

export interface FlowContext {
  mounts: ContextMount[];
  mapText: string;
  fragments: ContextFragment[];
  active?: ContextActive;
  selection?: ContextSelection;
  /** Rol de cada carpeta del workspace (solo por nombres de archivo). */
  roles?: FolderRole[];
  /** Parejas llamada del front → handler del back detectadas. */
  bridge?: BridgeHint[];
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

export function allowed(file: ProjectFileInfo): boolean {
  return !file.binary && !isContextExcludedPath(file.path) && !isSensitiveCodeFile(file.name);
}

export async function readText(file: ProjectFileInfo, maxBytes: number): Promise<string | null> {
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

export async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>, token: vscode.CancellationToken): Promise<void> {
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
export function interleaveByMount(paths: string[], multi: boolean): string[] {
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

/* ------------------------------ puente HTTP front → back ------------------------------ */

/** Endpoint declarado en el back: método HTTP, expresiones de ruta (prefijo de clase + método, sin resolver) y handler. */
interface RouteDecl {
  path: string;
  httpMethod: string;
  exprs: string[];
  handler: string | null;
  line: number;
}

/** Petición HTTP del front: método, segmentos de la ruta y si se perdió el prefijo (host o variable sin resolver). */
interface HttpCall {
  httpMethod: string;
  segments: string[];
  partial: boolean;
  line: number;
}

/** Endpoint del back con la ruta ya resuelta. */
interface BridgeRoute {
  path: string;
  httpMethod: string;
  segments: string[];
  handler: string | null;
}

const ROUTE_EXTENSIONS = ['java', 'kt', 'ts', 'js', 'py'];
const MAX_ROUTE_DECLS = 2000;
const MAX_ROUTE_LINES = 6000;
/** Marcadores baratos: solo se analizan los archivos que declaran endpoints. */
const ROUTE_MARKERS = /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@Controller\s*\(|\b(?:router|app|\w{1,40}Router)\s*\.\s*(?:get|post|put|patch|delete|all)\s*\(|@\w{1,40}\s*\.\s*(?:get|post|put|patch|delete|route)\s*\(/;
const SPRING_CONTROLLER = /@(?:Rest)?Controller\b/;
const SPRING_MAPPING = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b/;
const SPRING_HANDLER = /(?:public|protected|private|fun)\b[^=;(){]{0,200}?\b([A-Za-z_]\w*)\s*\(/;
const NEST_CONTROLLER = /@Controller\s*\(\s*(?:(['"`])([^'"`\n]{0,200})\1)?/;
const NEST_MAPPING = /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*(?:(['"`])([^'"`\n]{0,200})\2)?/;
const NEST_HANDLER = /^\s*(?:(?:public|private|protected|async|static)\s+)*([A-Za-z_$][\w$]{0,60})\s*\(/;
const EXPRESS_ROUTE = /\b(?:router|app|\w{1,40}Router)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`\n]{0,300})\2/;
const PY_ROUTE = /@\w{1,40}\s*\.\s*(get|post|put|patch|delete|route)\s*\(\s*(['"])([^'"\n]{0,300})\2([^\n]{0,200})/;
const PY_HANDLER = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w{0,60})/;
const JAVA_CONST = /\bstatic\s+final\s+String\s+([A-Za-z_]\w{0,80})\s*=\s*([^;\n]{1,300});/g;
const JAVA_IFACE_CONST = /\bString\s+([A-Z][A-Z0-9_]{0,80})\s*=\s*([^;\n]{1,300});/g;
const KOTLIN_CONST = /\bconst\s+val\s+([A-Za-z_]\w{0,80})\s*(?::\s*String)?\s*=\s*([^\n]{1,300})/g;
const TS_CONST = /\bexport\s+const\s+([A-Za-z_$][\w$]{0,80})\s*(?::\s*string)?\s*=\s*([^;\n]{1,300})/g;
const HTTP_CLIENT_MARKERS = /HttpClient|\bfetch\s*\(|axios|\bhttp\s*\.|\$http/;
const HTTP_CALL_LITERAL = /\.\s*(get|post|put|patch|delete|request)\s*(?:<[^()]{0,200}>)?\s*\(\s*(['"`])((?:(?!\2)[\s\S]){1,300})\2/g;
const HTTP_CALL_PLUS = /\.\s*(get|post|put|patch|delete|request)\s*(?:<[^()]{0,200}>)?\s*\(\s*((?:this\.)?[A-Za-z_$][\w$]{0,60})\s*\+\s*(['"`])((?:(?!\3)[\s\S]){1,300})\3/g;
const HTTP_CALL_IDENT = /\.\s*(get|post|put|patch|delete|request)\s*(?:<[^()]{0,200}>)?\s*\(\s*(?:this\.)?([A-Za-z_$][\w$]{0,60})\s*[,)]/g;
const FETCH_CALL = /\bfetch\s*\(\s*(['"`])((?:(?!\1)[\s\S]){1,300})\1/g;
const FIELD_LITERAL = /^\s*(?:(?:export|private|public|protected|readonly|static|const|let|var)\s+)*([A-Za-z_$][\w$]{0,60})\s*(?::[^=;]{1,80})?=\s*(['"`])((?:(?!\2).){0,300})\2/;
const FIELD_PLUS = /^\s*(?:(?:export|private|public|protected|readonly|static|const|let|var)\s+)*([A-Za-z_$][\w$]{0,60})\s*(?::[^=;]{1,80})?=\s*([A-Za-z_$][\w$.]{0,80})\s*\+\s*(['"`])((?:(?!\3).){0,300})\3/;
const MAX_HTTP_MATCHES = 200;

/** Método HTTP de un verbo (`get` → GET); `request`, `route` y `all` valen para cualquiera. */
function verbOf(name: string): string {
  const upper = name.toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper) ? upper : 'ANY';
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#');
}

/** Anotación desde `from` en la línea `start` hasta cerrar el paréntesis (como mucho 6 líneas): texto, línea final y resto de esa línea. */
function annotationAt(lines: string[], start: number, from: number): { text: string; end: number; rest: string } {
  let text = '';
  let depth = 0;
  let opened = false;
  for (let i = start; i < Math.min(lines.length, start + 6); i++) {
    const part = (i === start ? lines[i].slice(from) : lines[i]).slice(0, 1000);
    if (i === start) {
      const afterName = /^@\w+\s*/.exec(part);
      if (!afterName || part[afterName[0].length] !== '(') return { text: afterName ? afterName[0] : part, end: i, rest: afterName ? part.slice(afterName[0].length) : '' };
    }
    for (let c = 0; c < part.length; c++) {
      const ch = part[c];
      text += ch;
      if (ch === '(') {
        depth++;
        opened = true;
      } else if (ch === ')') {
        depth--;
        if (opened && depth <= 0) return { text, end: i, rest: part.slice(c + 1) };
      }
    }
    text += '\n';
  }
  return { text, end: Math.min(lines.length - 1, start + 5), rest: '' };
}

/** Ruta (expresión sin resolver) y método HTTP de los argumentos de una anotación `@XMapping(...)`. */
function mappingArgs(annotation: string): { expr: string; method: string | null } {
  const open = annotation.indexOf('(');
  const close = annotation.lastIndexOf(')');
  if (open < 0 || close < open) return { expr: '', method: null };
  const inner = annotation.slice(open + 1, close);
  const method = /RequestMethod\s*\.\s*(GET|POST|PUT|PATCH|DELETE)\b/.exec(inner)?.[1] ?? null;
  const named = /\b(?:value|path)\s*=\s*[{[]?\s*/.exec(inner);
  if (named) return { expr: takeExpr(inner.slice(named.index + named[0].length)), method };
  const first = inner.trimStart().replace(/^[{[]\s*/, '');
  if (!first || /^[A-Za-z_]\w*\s*=(?!=)/.test(first)) return { expr: '', method };
  return { expr: takeExpr(first), method };
}

const EXPR_ATOM = '(?:"[^"\\n]{0,300}"|\'[^\'\\n]{0,300}\'|[A-Za-z_$][\\w$.]{0,120})';
const EXPR_START = new RegExp(`^\\s*${EXPR_ATOM}(?:\\s*\\+\\s*${EXPR_ATOM}){0,8}`);

/** Primera expresión de ruta (literales y constantes unidos con `+`) al inicio del texto. */
function takeExpr(text: string): string {
  const m = EXPR_START.exec(text);
  return m ? m[0].trim() : '';
}

/** Endpoints de un archivo del back (Spring, NestJS, Express, Flask/FastAPI). Solo regex acotadas sobre el contenido ya leído. */
function extractRouteDecls(path: string, content: string, ext: string): RouteDecl[] {
  if (!ROUTE_MARKERS.test(content)) return [];
  const out: RouteDecl[] = [];
  const lines = content.split(/\r?\n/, MAX_ROUTE_LINES);
  const push = (decl: Omit<RouteDecl, 'path'>): void => {
    if (out.length < 200) out.push({ path, ...decl });
  };
  if (ext === 'java' || ext === 'kt') {
    if (!SPRING_CONTROLLER.test(content)) return out;
    const classIdx = lines.findIndex((line) => !isCommentLine(line) && /\b(?:class|interface|object)\s+[A-Za-z_]\w*/.test(line));
    if (classIdx < 0) return out;
    let classExpr: string | null = null;
    for (let i = 0; i <= classIdx && classExpr === null; i++) {
      if (isCommentLine(lines[i])) continue;
      const m = /@RequestMapping\b/.exec(lines[i]);
      if (m) classExpr = mappingArgs(annotationAt(lines, i, m.index).text).expr;
    }
    for (let i = classIdx; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      const m = SPRING_MAPPING.exec(lines[i]);
      if (!m || (i === classIdx && m.index < (lines[i].search(/\b(?:class|interface|object)\s/) || 0))) continue;
      const ann = annotationAt(lines, i, m.index);
      const { expr, method } = mappingArgs(ann.text);
      let handler: string | null = null;
      for (let j = ann.end; j < Math.min(lines.length, ann.end + 9); j++) {
        const candidate = j === ann.end ? ann.rest : lines[j];
        if (j > ann.end && SPRING_MAPPING.test(candidate)) break;
        const h = SPRING_HANDLER.exec(candidate);
        if (h) {
          handler = h[1];
          break;
        }
      }
      push({ httpMethod: m[1] === 'Request' ? method ?? 'ANY' : m[1].toUpperCase(), exprs: classExpr === null ? [expr] : [classExpr, expr], handler, line: i });
    }
    return out;
  }
  if (ext === 'ts' || ext === 'js') {
    if (content.includes('@angular/')) return out;
    const ctrl = NEST_CONTROLLER.exec(content);
    if (ctrl) {
      const prefix = JSON.stringify(ctrl[2] ?? '');
      for (let i = 0; i < lines.length; i++) {
        const m = NEST_MAPPING.exec(lines[i]);
        if (!m || isCommentLine(lines[i])) continue;
        let handler: string | null = null;
        for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
          if (lines[j].trimStart().startsWith('@')) continue;
          const h = NEST_HANDLER.exec(lines[j]);
          if (h) handler = h[1];
          break;
        }
        push({ httpMethod: verbOf(m[1]), exprs: [prefix, JSON.stringify(m[3] ?? '')], handler, line: i });
      }
      return out;
    }
    for (let i = 0; i < lines.length; i++) {
      const m = EXPRESS_ROUTE.exec(lines[i]);
      if (m && !isCommentLine(lines[i])) push({ httpMethod: verbOf(m[1]), exprs: [JSON.stringify(m[3])], handler: null, line: i });
    }
    return out;
  }
  if (ext === 'py') {
    for (let i = 0; i < lines.length; i++) {
      const m = PY_ROUTE.exec(lines[i]);
      if (!m) continue;
      let httpMethod = verbOf(m[1]);
      if (m[1] === 'route') httpMethod = /methods\s*=\s*\[\s*['"](GET|POST|PUT|PATCH|DELETE)/i.exec(m[4])?.[1].toUpperCase() ?? 'ANY';
      let handler: string | null = null;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        const h = PY_HANDLER.exec(lines[j]);
        if (h) {
          handler = h[1];
          break;
        }
      }
      push({ httpMethod, exprs: [JSON.stringify(m[3])], handler, line: i });
    }
  }
  return out;
}

/**
 * Constantes de texto con ruta (`static final String LOGIN = "/login"`, `const val`, `export const`): `NAME` y
 * `Archivo.NAME` → expresión sin resolver. Solo las que contienen `/` o concatenan.
 */
function extractStringConstants(content: string, ext: string, fileBase: string): Map<string, string> {
  const out = new Map<string, string>();
  const patterns = ext === 'java' ? [JAVA_CONST, JAVA_IFACE_CONST] : ext === 'kt' ? [KOTLIN_CONST] : ext === 'ts' || ext === 'js' ? [TS_CONST] : [];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let found = 0;
    for (let m = pattern.exec(content); m && found < 200; m = pattern.exec(content)) {
      found++;
      const expr = m[2].trim();
      if (!/["'`]/.test(expr) || !(expr.includes('/') || expr.includes('+'))) continue;
      out.set(`${fileBase}.${m[1]}`, expr);
      if (!out.has(m[1])) out.set(m[1], expr);
    }
  }
  return out;
}

/** Resuelve una expresión de ruta (literales y constantes unidos con `+`); `null` si alguna constante no se conoce. */
function resolveRouteExpr(expr: string, constants: Map<string, string>, depth = 0): string | null {
  const text = expr.trim();
  if (!text) return '';
  if (depth > 3) return null;
  let out = '';
  for (const rawPart of text.split('+')) {
    const part = rawPart.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim();
    if (!part) return null;
    const quote = part[0];
    if ((quote === '"' || quote === "'" || quote === '`') && part.length >= 2 && part.endsWith(quote)) {
      out += part.slice(1, -1);
      continue;
    }
    if (!/^[A-Za-z_$][\w$.]{0,120}$/.test(part)) return null;
    const ids = part.split('.');
    const last = ids[ids.length - 1];
    const found = constants.get(part) ?? constants.get(`${ids[0]}.${last}`) ?? constants.get(last);
    if (found === undefined) return null;
    const value = resolveRouteExpr(found, constants, depth + 1);
    if (value === null) return null;
    out += value;
  }
  return out;
}

/** Segmentos de una ruta en minúsculas; `{x}`, `:x`, `*` y `${…}` son comodines (`*`). */
function routeSegments(path: string): string[] {
  return path.split('/').map((s) => s.trim()).filter(Boolean)
    .map((s) => (/[{}]/.test(s) || s.startsWith(':') || s === '*' || s.includes('${') ? '*' : s.toLowerCase()));
}

/** Expande `${campo}` / `${this.campo}` con los inicializadores del mismo archivo (hasta 2 niveles). */
function expandFields(template: string, fields: Map<string, string>, depth = 0): string {
  if (depth >= 2) return template;
  return template.replace(/\$\{\s*(?:this\.)?([A-Za-z_$][\w$]{0,60})\s*\}/g, (all: string, name: string) => {
    const value = fields.get(name);
    return value === undefined ? all : expandFields(value, fields, depth + 1);
  });
}

/** Peticiones HTTP de un archivo TS/JS (HttpClient, fetch, axios) con su ruta ya reducida a segmentos. Como mucho `MAX_HTTP_CALLS`. */
function extractHttpCalls(content: string): HttpCall[] {
  if (!HTTP_CLIENT_MARKERS.test(content)) return [];
  const fields = new Map<string, string>();
  const lines = content.split(/\r?\n/, MAX_ROUTE_LINES);
  for (const line of lines) {
    if (line.length > 600 || !line.includes('=')) continue;
    const literal = FIELD_LITERAL.exec(line);
    if (literal) {
      if (!fields.has(literal[1])) fields.set(literal[1], literal[3]);
      continue;
    }
    const plus = FIELD_PLUS.exec(line);
    if (plus && !fields.has(plus[1])) fields.set(plus[1], `\${${plus[2]}}${plus[4]}`);
  }
  const lineAt = (index: number): number => {
    let n = 0;
    for (let i = content.indexOf('\n'); i >= 0 && i < index; i = content.indexOf('\n', i + 1)) n++;
    return n;
  };
  const calls: HttpCall[] = [];
  const seen = new Set<string>();
  const add = (verb: string, template: string, index: number): void => {
    if (calls.length >= MAX_HTTP_CALLS) return;
    let value = expandFields(template, fields);
    let partial = false;
    const lead = /^(?:\$\{[^}]{0,120}\})+/.exec(value);
    if (lead) {
      value = value.slice(lead[0].length);
      partial = true;
    }
    value = value.replace(/^https?:\/\/[^/]{1,200}/i, '');
    const cut = value.search(/[?#]/);
    if (cut >= 0) value = value.slice(0, cut);
    if (!value.includes('/') || /^\.{1,2}\//.test(value)) return;
    const segments = routeSegments(value);
    if (!segments.length) return;
    const httpMethod = verbOf(verb);
    const key = `${httpMethod}|${segments.join('/')}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ httpMethod, segments, partial, line: lineAt(index) });
  };
  const scan = (regex: RegExp, handle: (m: RegExpExecArray) => void): void => {
    regex.lastIndex = 0;
    let n = 0;
    for (let m = regex.exec(content); m && n < MAX_HTTP_MATCHES && calls.length < MAX_HTTP_CALLS; m = regex.exec(content)) {
      n++;
      handle(m);
    }
  };
  scan(HTTP_CALL_LITERAL, (m) => add(m[1], m[3], m.index));
  scan(HTTP_CALL_PLUS, (m) => add(m[1], `\${${m[2].replace(/^this\./, '')}}${m[4]}`, m.index));
  scan(HTTP_CALL_IDENT, (m) => {
    const value = fields.get(m[2]);
    if (value !== undefined) add(m[1], value, m.index);
  });
  scan(FETCH_CALL, (m) => add('request', m[2], m.index));
  return calls;
}

/** Puntuación de un endpoint del back para una petición del front: 0 = no encaja; 2–3 por la ruta, +1 si coincide el método. */
function matchScore(front: HttpCall, back: BridgeRoute): number {
  const f = front.segments;
  const b = back.segments;
  if (!f.length || !b.length) return 0;
  const same = (x: string, y: string): boolean => x === y || x === '*' || y === '*';
  const aligned = (long: string[], short: string[]): boolean => short.every((s, i) => same(long[long.length - short.length + i], s));
  let base = 0;
  let literal = false;
  if (f.length === b.length && aligned(f, b)) {
    base = 3;
    literal = f.some((s, i) => s !== '*' && s === b[i]);
  } else if (front.partial && b.length > f.length && aligned(b, f)) {
    base = 2;
    literal = f.some((s, i) => s !== '*' && s === b[b.length - f.length + i]);
  } else if (f.length > b.length && aligned(f, b)) {
    // El front incluye el contexto del servidor (`/Nexo/api/x`) que el controlador no declara.
    base = 2;
    literal = b.some((s, i) => s !== '*' && s === f[f.length - b.length + i]);
  }
  if (!base || !literal) return 0;
  return base + (front.httpMethod === back.httpMethod ? 1 : 0);
}

/* ------------------------------- roles de carpeta ------------------------------- */

/** Capa a la que pertenece una ruta (relativa a su carpeta) por nombre y extensión; `null` si no encaja. */
export function layerOfPath(path: string): FolderLayer | null {
  const name = baseName(path);
  const ext = codeExtension(name);
  if (ext === 'sql' || ext === 'prisma') return 'datos';
  if (/(Repository|Repo|Dao|Entity)\.(java|kt|ts|js|py|cs)$/.test(name)) return 'datos';
  if (/(^|\/)(repository|repositories|dao|entity|entities|migrations?|changelog)\//i.test(path)) return 'datos';
  if (['java', 'kt', 'scala', 'py', 'cs', 'go', 'rb', 'php'].includes(ext) || /\.controller\.(ts|js)$/i.test(name)) return 'back';
  if (['html', 'tsx', 'jsx', 'vue', 'svelte', 'css', 'scss'].includes(ext) || /\.(component|service|guard|interceptor|pipe|store)\.ts$/i.test(name)) return 'front';
  return null;
}

/** Roles (front, back, datos) y tecnologías de cada carpeta, en una sola pasada por los nombres de archivo. */
export function detectFolderRoles(files: ProjectFileInfo[], mountIds: string[], prefixed: boolean): FolderRole[] {
  interface Acc { roles: Set<FolderLayer>; tech: Set<string>; build: boolean; jvm: boolean }
  const acc = new Map<string, Acc>();
  for (const id of mountIds) acc.set(id, { roles: new Set(), tech: new Set(), build: false, jvm: false });
  for (const file of files) {
    const mount = prefixed ? mountOf(file.path, true) : mountIds[0];
    const a = acc.get(mount);
    if (!a) continue;
    const rel = relPath(file.path, prefixed);
    const name = file.name;
    const ext = codeExtension(name);
    if (layerOfPath(rel) === 'datos') a.roles.add('datos');
    if (name === 'angular.json' || /\.component\.ts$/i.test(name)) {
      a.roles.add('front');
      a.tech.add('Angular');
    } else if (/^(vite|next|nuxt|svelte|astro)\.config\./i.test(name)) {
      a.roles.add('front');
      if (/^svelte/i.test(name)) a.tech.add('Svelte');
    } else if (ext === 'tsx' || ext === 'jsx') {
      a.roles.add('front');
      a.tech.add('React');
    } else if (ext === 'vue') {
      a.roles.add('front');
      a.tech.add('Vue');
    } else if (ext === 'svelte') {
      a.roles.add('front');
      a.tech.add('Svelte');
    }
    if (name === 'pom.xml' || /^build\.gradle(\.kts)?$/.test(name)) {
      a.roles.add('back');
      a.build = true;
    } else if (name === 'manage.py') {
      a.roles.add('back');
      a.tech.add('Django');
    } else if (name === 'go.mod') {
      a.roles.add('back');
      a.tech.add('Go');
    } else if (ext === 'csproj') {
      a.roles.add('back');
      a.tech.add('.NET');
    } else if (/Controller\.(java|kt|cs)$/.test(name)) {
      a.roles.add('back');
      if (ext === 'cs') a.tech.add('.NET');
      else a.jvm = true;
    } else if (/\.controller\.ts$/i.test(name)) {
      a.roles.add('back');
      a.tech.add('NestJS');
    }
    if (ext === 'java' || ext === 'kt') a.jvm = true;
  }
  const out: FolderRole[] = [];
  for (const [mount, a] of acc) {
    if (a.build && a.jvm) a.tech.add('Spring Boot');
    if (!a.roles.size) continue;
    const order: FolderLayer[] = ['front', 'back', 'datos'];
    out.push({ mount, roles: order.filter((r) => a.roles.has(r)), tech: [...a.tech] });
  }
  return out;
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
  const roles = detectFolderRoles(candidates, snapshot.mounts.map((m) => m.id), snapshot.mounts.length > 1);
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
  /** Endpoints del back y constantes de ruta vistos durante el escaneo (puente HTTP front → back). */
  const routeDecls: RouteDecl[] = [];
  const constants = new Map<string, string>();
  const collectBridge = (file: ProjectFileInfo, content: string): void => {
    const ext = codeExtension(file.name);
    if (!ROUTE_EXTENSIONS.includes(ext) || isTestPath(file.path)) return;
    for (const [key, value] of extractStringConstants(content, ext, file.name.replace(/\.[^.]+$/, ''))) {
      if (!constants.has(key)) constants.set(key, value);
    }
    if (routeDecls.length >= MAX_ROUTE_DECLS) return;
    routeDecls.push(...extractRouteDecls(file.path, content, ext).slice(0, MAX_ROUTE_DECLS - routeDecls.length));
  };
  if (terms.length) {
    report('Buscando en el código…');
    await pool(toScan, SCAN_CONCURRENCY, async (file) => {
      const content = await readText(file, MAX_SCAN_BYTES);
      if (content === null) return;
      collectBridge(file, content);
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
    // FLOW recorre varias capas (front → back → datos): umbral más permisivo y más archivos por carpeta.
    const crossLayer = !prioritize;
    const relevance = crossLayer ? FLOW_MOUNT_RELEVANCE : 0.5;
    const topPerMount = crossLayer ? KEYWORD_TOP_PER_MOUNT_FLOW : KEYWORD_TOP_PER_MOUNT;
    for (const mount of mountInfos) {
      const relevant = mentioned.size > 0
        ? mentioned.has(mount.id)
        : globalBest > 0 && (best.get(mount.id) ?? 0) >= globalBest * relevance;
      if (!relevant) continue;
      let taken = 0;
      for (const { file, score } of ranked) {
        if (taken >= topPerMount || score <= 0) break;
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

  // Puente HTTP: cada petición del front seleccionado se empareja con el endpoint del back (método + ruta, resolviendo
  // constantes); el controlador entra detrás de su origen y su handler se ancla para seguir Controller → Service → Repository.
  let bridged = 0;
  const bridgeAnchors: { path: string; handler: string | null }[] = [];
  const bridgeHints: BridgeHint[] = [];
  if (terms.length && routeDecls.length) {
    const routes: BridgeRoute[] = [];
    for (const decl of routeDecls) {
      let joined = '';
      let resolved = true;
      for (const expr of decl.exprs) {
        const part = resolveRouteExpr(expr, constants);
        if (part === null) {
          resolved = false;
          break;
        }
        joined += `/${part}`;
      }
      const segments = resolved ? routeSegments(joined) : [];
      if (segments.length) routes.push({ path: decl.path, httpMethod: decl.httpMethod, segments, handler: decl.handler });
    }
    const sources = finalPaths
      .filter((path) => /\.(?:ts|tsx|js|jsx)$/i.test(path) && !isTestPath(path))
      .slice(0, MAX_BRIDGE_SOURCES);
    const found: { source: string; call: HttpCall; relevance: number }[] = [];
    if (routes.length) {
      for (const source of sources) {
        cancelled(token);
        const file = byPath.get(source);
        if (!file) continue;
        const content = await contentOf(file);
        if (content === null) continue;
        const calls = extractHttpCalls(content);
        if (!calls.length) continue;
        const lines = content.split(/\r?\n/);
        for (const call of calls) {
          const around = foldAccents(lines.slice(Math.max(0, call.line - 3), call.line + 4).join('\n')).toLowerCase();
          found.push({ source, call, relevance: terms.reduce((n, term) => n + (around.includes(term) ? 1 : 0), 0) });
        }
      }
    }
    const relevantCalls = found.filter((f) => f.relevance > 0);
    const picked = (relevantCalls.length ? relevantCalls : found).sort((a, b) => b.relevance - a.relevance).slice(0, MAX_HTTP_CALLS);
    const targets = new Map<string, { source: string; handlers: Set<string> }>();
    for (const item of picked) {
      let bestRoute: BridgeRoute | null = null;
      let bestScore = 0;
      for (const route of routes) {
        if (route.path === item.source) continue;
        const score = matchScore(item.call, route);
        if (score > bestScore) {
          bestScore = score;
          bestRoute = route;
        }
      }
      if (!bestRoute) continue;
      if (bridgeHints.length < MAX_BRIDGE_HINTS) {
        bridgeHints.push({ front: item.source, line: item.call.line, method: item.call.httpMethod, back: bestRoute.path, handler: bestRoute.handler });
      }
      let target = targets.get(bestRoute.path);
      if (!target) {
        if (targets.size >= MAX_BRIDGE_FILES) continue;
        target = { source: item.source, handlers: new Set() };
        targets.set(bestRoute.path, target);
      }
      if (bestRoute.handler && target.handlers.size < 4) target.handlers.add(bestRoute.handler);
    }
    const present = new Set(finalPaths);
    const lastAfter = new Map<string, string>();
    for (const [backPath, target] of targets) {
      if (!present.has(backPath)) {
        if (finalPaths.length >= MAX_FILES) continue;
        const anchor = lastAfter.get(target.source) ?? target.source;
        finalPaths.splice(finalPaths.indexOf(anchor) + 1, 0, backPath);
        present.add(backPath);
        lastAfter.set(target.source, backPath);
      }
      for (const handler of target.handlers) bridgeAnchors.push({ path: backPath, handler });
      bridged++;
    }
  }

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
  // Se recorre intercalando carpetas y con cuota por carpeta: los servicios del front no agotan las referencias del back.
  const queue = interleaveByMount(finalPaths, multi).map((path) => ({ path, depth: 0 }));
  const refsByMount = new Map<string, number>();
  const refCap = multi ? MAX_REF_FILES_PER_MOUNT : MAX_REF_FILES;
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
    const mountKey = mountOf(path, prefixed);
    const byKey = index.get(mountKey);
    let offset = 0;
    for (const key of keys) {
      if (refsAdded >= MAX_REF_FILES || finalPaths.length >= MAX_FILES || (refsByMount.get(mountKey) ?? 0) >= refCap) break;
      const list = byKey?.get(key);
      if (!list || list.some((f) => included.has(f.path))) continue;
      const target = list[0];
      finalPaths.splice(finalPaths.indexOf(path) + 1 + offset, 0, target.path);
      included.add(target.path);
      queue.push({ path: target.path, depth: depth + 1 });
      offset++;
      refsAdded++;
      refsByMount.set(mountKey, (refsByMount.get(mountKey) ?? 0) + 1);
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
    for (const anchor of bridgeAnchors) {
      const scan = scanByPath.get(anchor.path);
      if (scan && anchor.handler) setCalled(`${scan.mount}|${scan.key}`, anchor.handler, 2);
    }
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
  // Carpetas intercaladas: ninguna se queda sin fragmentos por el tope global (cada archivo tiene su cuota de fragmentos).
  if (multi) {
    const rank = new Map(interleaveByMount(entries.map((e) => e.path), true).map((p, i) => [p, i] as const));
    entries.sort((a, b) => (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0));
  }
  const countShares = fairShares(entries.map((e) => e.fragments.length), MAX_FRAGMENTS);
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
    const ordered = [...entries[i].fragments].sort((a, b) => b.priority - a.priority || a.startLine - b.startLine);
    for (const fragment of ordered) {
      if (kept.length >= countShares[i]) break;
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
  }

  options.log?.info(
    `Contexto · carpetas=${mountInfos.length} · listados=${listed} · excluidos=${excluded} · candidatos ${perMount(countBy(candidates.map((f) => f.path)))}`
    + ` · escaneados ${perMount(countBy(toScan.map((f) => f.path)))} · forzados=${forced.length} · IA=${aiPicked} · claves=${ids.length}`
    + ` · referencias=${refsAdded} · puente=${bridged} · anclas=${anchorCount} · archivos ${perMount(countBy(new Set(fragmentFiles)))} · fragmentos=${fragments.length} (${total} caracteres)`
    + (prioritize ? ` · foco=${focusCount} · hermanos=${siblings.length}` : ''),
  );
  return {
    mounts,
    mapText: mapText(mapRanked, MAP_FLOW_CHARS),
    fragments,
    ...(activeInfo ? { active: activeInfo.active } : {}),
    ...(activeInfo?.selection ? { selection: activeInfo.selection } : {}),
    ...(roles.length ? { roles } : {}),
    ...(bridgeHints.length ? { bridge: bridgeHints } : {}),
  };
}
