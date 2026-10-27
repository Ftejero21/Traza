/**
 * Herramientas privadas de solo lectura del modo agente (`traza_search`, `traza_read`, `traza_list`): la IA investiga
 * por su cuenta TODAS las carpetas abiertas del workspace. No se registran con `lm.registerTool`: las ejecuta el bucle
 * de `HostAi`. Respetan las exclusiones del contexto (`allowed`, archivos sensibles, claves privadas) y enmascaran los
 * secretos. Los límites son solo de presupuesto; nunca restringen qué carpetas o archivos puede mirar la IA.
 * Nunca escriben, y nunca registran rutas ni contenido en el log.
 */
import * as vscode from 'vscode';
import type { NexoLanguage, ProjectFileInfo } from '../webview/src/app/bridge/protocol';
import { maskConfigSecrets } from '../webview/src/app/workspace-code/ai/workspace-code-ai-mask';
import { cut, isObj, numbered } from './ai/semantics';
import { allowed, interleaveByMount, pool, PRIVATE_KEY, readText } from './host-context';
import { listFiles } from './host-files';
import { normalizeCodePath } from './host-guards';

const SEARCH_FILE_BYTES = 512 * 1024;
const READ_FILE_BYTES = 3 * 1024 * 1024;
const SEARCH_TIME_MS = 8000;
const SEARCH_DEFAULT = 40;
const SEARCH_MAX = 80;
const MATCHES_PER_FILE = 4;
const LINE_CHARS = 240;
const READ_DEFAULT_LINES = 200;
const READ_WHOLE_LINES = 300;
const READ_MAX_LINES = 400;
const READ_MAX_CHARS = 20_000;
const LIST_MAX = 200;
const CACHE_MAX_CHARS = 40_000_000;
const SCAN_CONCURRENCY = 8;
const QUERY_MAX = 200;
const REGEX_LINE_CHARS = 2000;
const OVERVIEW_DIRS = 20;
const OVERVIEW_DEPTH = 3;
const OVERVIEW_MAX_CHARS = 6000;
const PROGRESS_MAX = 80;
const AMBIGUOUS_OPTIONS = 5;
const SYMBOL_NAME = /^[\w$]{1,80}$/;
const WIN32 = process.platform === 'win32';

export const AGENT_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'traza_search',
    description: 'Read-only search of text, regex or symbol declarations in ALL open workspace folders. Returns folder/path:line matches. Use it to find endpoints, services, repositories, constants and callers in any folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `Text, regex or symbol name to search for (1-${QUERY_MAX} characters).` },
        mode: { type: 'string', enum: ['text', 'regex', 'symbol'], description: 'text (default): case-insensitive literal; regex: a regular expression; symbol: class/function/method declaration by name.' },
        path: { type: 'string', description: 'Optional folder name or directory prefix (as in the map) to restrict the search. Omit to search every folder.' },
        pattern: { type: 'string', description: 'Optional file glob such as *.java or src/**/*.ts.' },
        maxResults: { type: 'integer', description: `Maximum matching lines (1-${SEARCH_MAX}, default ${SEARCH_DEFAULT}).` },
      },
      required: ['query'],
    },
  },
  {
    name: 'traza_read',
    description: 'Read-only: returns a file (or a line range) of the workspace with line numbers. Path uses the format of the project map (folder/path in multi-root).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path as shown in the map or in search results.' },
        startLine: { type: 'integer', description: 'First line to read (1-based, minimum 1).' },
        endLine: { type: 'integer', description: 'Last line to read (minimum 1).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'traza_list',
    description: 'Read-only: lists the workspace files of any folder, optionally filtered by directory and glob. Without arguments returns an overview of every open folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional folder name or directory prefix.' },
        pattern: { type: 'string', description: 'Optional file glob such as *.java or **/*Controller*.' },
      },
    },
  },
];

type Resolved = { file: ProjectFileInfo } | { error: string };

function isCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === 'cancelled';
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function int(input: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = input[key];
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function optionalInt(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : NaN);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** Glob a RegExp sin distinguir mayúsculas: doble asterisco y barra = carpetas opcionales, doble asterisco = todo, * y ? = un segmento, {a,b} = alternativa. */
function globToRegExp(glob: string): RegExp | null {
  const g = glob.trim().replace(/\\/g, '/');
  if (!g || g.length > QUERY_MAX) return null;
  let out = '';
  let braces = 0;
  for (let i = 0; i < g.length; i++) {
    if (g.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (g.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (g[i] === '*') out += '[^/]*';
    else if (g[i] === '?') out += '[^/]';
    else if (g[i] === '{') {
      braces++;
      out += '(?:';
    } else if (g[i] === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (g[i] === ',' && braces > 0) out += '|';
    else out += escapeRegExp(g[i]);
  }
  out += ')'.repeat(braces);
  try {
    return new RegExp(`^${out}$`, 'i');
  } catch (error: unknown) {
    console.warn('[Traza] Glob no válido.', error instanceof Error ? error.name : '');
    return null;
  }
}

/** Texto recortado a `max` caracteres con aviso (el aviso cuenta dentro del límite). */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const note = '\n…(recortado)';
  return cut(value, Math.max(0, max - note.length)) + note;
}

export class AgentToolSession {
  private readonly byPath = new Map<string, ProjectFileInfo>();
  private readonly byLower = new Map<string, string[]>();
  private readonly byUri = new Map<string, string>();
  private mounts: string[] = [];
  private multi = false;
  private readonly contents = new Map<string, string | null>();
  private readonly failedAt = new Map<string, number>();
  private readonly denied = new Set<string>();
  private cachedChars = 0;
  private readonly ranges = new Map<string, [number, number][]>();
  private readonly readPaths = new Set<string>();
  private readonly calls = { search: 0, read: 0, list: 0 };
  private returned = 0;

  constructor(private readonly opts: { token: vscode.CancellationToken; lang: NexoLanguage; progress?: (m: string) => void }) {}

  /* ------------------------------ ciclo de vida ------------------------------ */

  async init(): Promise<void> {
    const snapshot = await listFiles();
    this.check();
    if (!snapshot.mounts.length) throw new Error('No hay carpetas abiertas en el workspace.');
    this.mounts = snapshot.mounts.map((m) => m.id);
    this.multi = this.mounts.length > 1;
    for (const file of snapshot.files.filter(allowed)) {
      this.byPath.set(file.path, file);
      const lower = file.path.toLowerCase();
      const same = this.byLower.get(lower);
      if (same) same.push(file.path);
      else this.byLower.set(lower, [file.path]);
      this.byUri.set(WIN32 ? file.id.toLowerCase() : file.id, file.path);
    }
  }

  private check(): void {
    if (this.opts.token.isCancellationRequested) throw new Error('cancelled');
  }

  private say(es: string, en: string): void {
    this.opts.progress?.(this.opts.lang === 'en' ? en : es);
  }

  private mountOf(path: string): string {
    if (!this.multi) return this.mounts[0] ?? '';
    const index = path.indexOf('/');
    return index < 0 ? path : path.slice(0, index);
  }

  private relOf(path: string): string {
    if (!this.multi) return path;
    const index = path.indexOf('/');
    return index < 0 ? path : path.slice(index + 1);
  }

  /* ------------------------------ lectura de rangos ------------------------------ */

  private rangeKey(path: string): string {
    const normalized = normalizeCodePath(path) ?? path;
    return WIN32 ? normalized.toLowerCase() : normalized;
  }

  markRead(path: string, start: number, end: number): void {
    const key = this.rangeKey(path);
    const list = this.ranges.get(key);
    const range: [number, number] = [Math.min(start, end), Math.max(start, end)];
    if (list) list.push(range);
    else this.ranges.set(key, [range]);
  }

  /** Ruta del mapa de un archivo del workspace por su URI; `null` si no está entre los archivos permitidos. */
  pathOfUri(uri: vscode.Uri): string | null {
    const id = uri.toString();
    return this.byUri.get(WIN32 ? id.toLowerCase() : id) ?? null;
  }

  /* ------------------------------ resumen ------------------------------ */

  overview(): string {
    const lines: string[] = [];
    for (const mount of this.mounts) {
      const dirs = new Map<string, number>();
      let total = 0;
      for (const file of this.byPath.values()) {
        if (this.mountOf(file.path) !== mount) continue;
        total++;
        const segments = this.relOf(file.path).split('/');
        segments.pop();
        const dir = segments.slice(0, OVERVIEW_DEPTH).join('/') || '(raiz)';
        dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
      }
      const top = [...dirs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, OVERVIEW_DIRS);
      lines.push(`- ${mount} (${total} archivos): ${top.map(([dir, n]) => `${dir} (${n})`).join(', ')}`);
    }
    return cut(lines.join('\n'), OVERVIEW_MAX_CHARS);
  }

  /** Solo contadores (nunca rutas ni contenido de archivos). */
  summary(): string {
    const perMount = new Map<string, number>(this.mounts.map((m) => [m, 0]));
    for (const path of this.readPaths) {
      const mount = this.mountOf(path);
      perMount.set(mount, (perMount.get(mount) ?? 0) + 1);
    }
    const read = [...perMount.entries()].map(([mount, n]) => `${mount}=${n}`).join(' ');
    return `llamadas buscar=${this.calls.search} leer=${this.calls.read} listar=${this.calls.list} · archivos leídos ${read} · caracteres=${this.returned}`;
  }

  /* ------------------------------ invocación ------------------------------ */

  async invoke(name: string, input: unknown, maxChars: number): Promise<string> {
    this.check();
    const args: Record<string, unknown> = isObj(input) ? input : {};
    let out: string;
    try {
      switch (name) {
        case 'traza_search':
          this.calls.search++;
          out = await this.search(args);
          break;
        case 'traza_read':
          this.calls.read++;
          out = await this.read(args);
          break;
        case 'traza_list':
          this.calls.list++;
          out = this.list(args);
          break;
        default:
          out = 'Herramienta desconocida: usa traza_search, traza_read o traza_list.';
      }
    } catch (error: unknown) {
      if (isCancelledError(error)) throw error;
      console.warn('[Traza] Fallo en una herramienta del agente.', error instanceof Error ? error.name : '');
      out = 'Error al ejecutar la herramienta; prueba con otra consulta.';
    }
    this.check();
    const result = clip(out, Math.max(0, maxChars));
    this.returned += result.length;
    return result;
  }

  /* ------------------------------ caché de contenido ------------------------------ */

  /** Contenido enmascarado; `null` si no se puede leer, supera `maxBytes` o lleva una clave privada. */
  private async load(file: ProjectFileInfo, maxBytes: number): Promise<string | null> {
    const key = file.path;
    const hit = this.contents.get(key);
    if (typeof hit === 'string') return hit.length > maxBytes ? null : hit;
    if (hit === null && (this.denied.has(key) || maxBytes <= (this.failedAt.get(key) ?? 0))) return null;
    const raw = await readText(file, maxBytes);
    this.check();
    if (raw === null) {
      this.failedAt.set(key, maxBytes);
      this.contents.set(key, null);
      return null;
    }
    if (PRIVATE_KEY.test(raw)) {
      this.denied.add(key);
      this.contents.set(key, null);
      return null;
    }
    const masked = maskConfigSecrets(file.path, raw);
    if (this.cachedChars + masked.length > CACHE_MAX_CHARS) {
      this.contents.clear();
      this.cachedChars = 0;
    }
    this.contents.set(key, masked);
    this.cachedChars += masked.length;
    return masked;
  }

  /* ------------------------------ resolución de rutas ------------------------------ */

  private resolve(raw: string): Resolved {
    const notFound: Resolved = { error: 'La ruta no existe o no está permitida.' };
    const slashed = raw.trim().replace(/\\/g, '/');
    if (!slashed || slashed.length > 520) return { error: 'Ruta no válida.' };
    const drive = /^[a-zA-Z]:\//.test(slashed);
    if (drive || slashed.startsWith('/')) {
      const found = this.pathOfUri(vscode.Uri.file(slashed));
      const file = found ? this.byPath.get(found) : undefined;
      if (file) return { file };
      if (drive) return notFound;
    }
    const rel = normalizeCodePath(slashed.replace(/^(?:\.\/)+/, '').replace(/^\/+/, ''));
    if (!rel) return { error: 'Ruta no válida.' };
    const exact = this.byPath.get(rel);
    if (exact) return { file: exact };
    const lower = rel.toLowerCase();
    const same = this.byLower.get(lower);
    if (same?.length === 1) return { file: this.byPath.get(same[0]) as ProjectFileInfo };
    if (same && same.length > 1) return this.ambiguous(same);
    if (this.multi) {
      const prefixed = this.mounts.flatMap((m) => this.byLower.get(`${m}/${rel}`.toLowerCase()) ?? []);
      if (prefixed.length === 1) return { file: this.byPath.get(prefixed[0]) as ProjectFileInfo };
      if (prefixed.length > 1) return this.ambiguous(prefixed);
    }
    const suffix: string[] = [];
    for (const [key, paths] of this.byLower) {
      if (key.endsWith(`/${lower}`)) suffix.push(...paths);
    }
    if (suffix.length === 1) return { file: this.byPath.get(suffix[0]) as ProjectFileInfo };
    if (suffix.length > 1) return this.ambiguous(suffix);
    return notFound;
  }

  private ambiguous(paths: string[]): Resolved {
    const options = paths.slice(0, AMBIGUOUS_OPTIONS).join(', ');
    return { error: `Ruta ambigua; indica la carpeta. Opciones: ${options}${paths.length > AMBIGUOUS_OPTIONS ? ` (+${paths.length - AMBIGUOUS_OPTIONS})` : ''}` };
  }

  /* ------------------------------ filtros ------------------------------ */

  /** Archivos que cumplen `path` (carpeta o directorio) y `pattern` (glob); `error` si algún filtro no es válido. */
  private filter(pathRaw: string, patternRaw: string): { files: ProjectFileInfo[]; error?: string; folders: string[] } {
    let prefix = '';
    if (pathRaw) {
      const normalized = normalizeCodePath(pathRaw.replace(/^(?:\.\/)+/, '').replace(/^\/+/, ''));
      if (normalized === null) return { files: [], error: 'path no válido.', folders: [] };
      prefix = normalized.toLowerCase();
      if (!this.multi && prefix === (this.mounts[0] ?? '').toLowerCase()) prefix = '';
    }
    let glob: RegExp | null = null;
    if (patternRaw) {
      glob = globToRegExp(patternRaw);
      if (!glob) return { files: [], error: 'pattern no válido.', folders: [] };
    }
    const baseOnly = !patternRaw.includes('/');
    const under = (value: string): boolean => value === prefix || value.startsWith(`${prefix}/`);
    const files: ProjectFileInfo[] = [];
    const folders = new Set<string>();
    for (const file of this.byPath.values()) {
      if (prefix) {
        const lower = file.path.toLowerCase();
        if (!under(lower) && !(this.multi && under(this.relOf(lower)))) continue;
      }
      if (glob) {
        const matched = baseOnly
          ? glob.test(file.name)
          : glob.test(file.path) || (this.multi && glob.test(this.relOf(file.path)));
        if (!matched) continue;
      }
      files.push(file);
      folders.add(this.mountOf(file.path));
    }
    const ordered = interleaveByMount(files.map((f) => f.path).sort((a, b) => a.localeCompare(b)), this.multi);
    return { files: ordered.map((p) => this.byPath.get(p) as ProjectFileInfo), folders: [...folders] };
  }

  private folderLabel(pathRaw: string): string {
    const normalized = pathRaw ? normalizeCodePath(pathRaw) : null;
    if (normalized && this.multi) {
      const first = normalized.split('/')[0].toLowerCase();
      const mount = this.mounts.find((m) => m.toLowerCase() === first);
      if (mount) return mount;
    }
    return cut(this.mounts.join(', '), PROGRESS_MAX);
  }

  /* ------------------------------ traza_search ------------------------------ */

  private matcher(query: string, mode: string): { test: (line: string) => boolean; prefilter?: (content: string) => boolean } | string {
    if (mode === 'regex') {
      try {
        const re = new RegExp(query, 'i');
        return { test: (line) => re.test(line.length > REGEX_LINE_CHARS ? line.slice(0, REGEX_LINE_CHARS) : line) };
      } catch (error: unknown) {
        return `Regex no válida (${error instanceof Error ? cut(error.message, 120) : 'error'}).`;
      }
    }
    if (mode === 'symbol') {
      if (!SYMBOL_NAME.test(query)) return 'En modo symbol, query debe ser un nombre (letras, dígitos, _ o $; máx. 80).';
      const name = escapeRegExp(query);
      const type = new RegExp(`\\b(?:class|interface|enum|record|type|function|def|fun|struct|trait|object)\\s+${name}\\b`, 'i');
      const method = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|override|final|abstract|export|default|readonly|synchronized)\\s+)*[\\w<>\\[\\],.?\\s]*\\b${name}\\s*\\(`, 'i');
      const lowerName = query.toLowerCase();
      return {
        test: (line) => {
          const l = line.length > REGEX_LINE_CHARS ? line.slice(0, REGEX_LINE_CHARS) : line;
          return type.test(l) || method.test(l);
        },
        prefilter: (content) => content.toLowerCase().includes(lowerName),
      };
    }
    const lower = query.toLowerCase();
    return { test: (line) => line.toLowerCase().includes(lower), prefilter: (content) => content.toLowerCase().includes(lower) };
  }

  private async search(input: Record<string, unknown>): Promise<string> {
    const query = text(input, 'query');
    if (!query || query.length > QUERY_MAX) return `query debe tener entre 1 y ${QUERY_MAX} caracteres.`;
    const modeRaw = text(input, 'mode');
    const mode = modeRaw === 'regex' || modeRaw === 'symbol' ? modeRaw : 'text';
    const matcher = this.matcher(query, mode);
    if (typeof matcher === 'string') return matcher;
    const maxResults = int(input, 'maxResults', 1, SEARCH_MAX, SEARCH_DEFAULT);
    const pathRaw = text(input, 'path');
    const filtered = this.filter(pathRaw, text(input, 'pattern'));
    if (filtered.error) return filtered.error;
    if (!filtered.files.length) return 'Ningún archivo permitido cumple path/pattern.';
    this.say(`Buscando en ${this.folderLabel(pathRaw)}…`, `Searching in ${this.folderLabel(pathRaw)}…`);

    const files = filtered.files;
    const hits: ({ line: number; text: string }[] | null)[] = files.map(() => null);
    const deadline = Date.now() + SEARCH_TIME_MS;
    let found = 0;
    let scanned = 0;
    let skipped = 0;
    let stopped = false;
    const index = new Map(files.map((f, i) => [f.path, i]));
    await pool(files, SCAN_CONCURRENCY, async (file) => {
      if (stopped) return;
      if (Date.now() > deadline || found >= maxResults) {
        stopped = true;
        return;
      }
      const content = await this.load(file, SEARCH_FILE_BYTES);
      if (content === null) {
        skipped++;
        return;
      }
      scanned++;
      if (matcher.prefilter && !matcher.prefilter(content)) return;
      const lines = content.split(/\r?\n/);
      const list: { line: number; text: string }[] = [];
      let all = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) continue;
        all++;
        if (list.length < MATCHES_PER_FILE) list.push({ line: i + 1, text: cut(lines[i].trim(), LINE_CHARS) });
      }
      if (!all) return;
      hits[index.get(file.path) as number] = list;
      found += list.length;
    }, this.opts.token);
    this.check();

    const perFolder = new Map<string, number>(this.mounts.map((m) => [m, 0]));
    const body: string[] = [];
    let shown = 0;
    let filesWithHits = 0;
    for (let i = 0; i < files.length; i++) {
      const list = hits[i];
      if (!list) continue;
      const take = list.slice(0, Math.max(0, maxResults - shown));
      if (!take.length) break;
      const path = files[i].path;
      filesWithHits++;
      const mount = this.mountOf(path);
      perFolder.set(mount, (perFolder.get(mount) ?? 0) + 1);
      body.push(path);
      for (const hit of take) {
        body.push(`  ${hit.line}| ${hit.text}`);
        this.markRead(path, hit.line, hit.line);
      }
      shown += take.length;
    }
    const counts = [...perFolder.entries()].map(([mount, n]) => `${mount}=${n} archivos`).join(' ');
    let out = `${shown} coincidencias en ${filesWithHits} archivos · ${counts}\n${body.join('\n')}`;
    if (!shown) out = `0 coincidencias · ${counts}`;
    if (stopped && found >= maxResults) out += '\n(límite de resultados alcanzado: refina con path o pattern)';
    else if (stopped) out += `\n(búsqueda parcial: ${scanned + skipped} de ${files.length} archivos)`;
    if (skipped) out += `\n(${skipped} archivos omitidos por tamaño o no legibles)`;
    return out;
  }

  /* ------------------------------ traza_read ------------------------------ */

  private async read(input: Record<string, unknown>): Promise<string> {
    const rawPath = text(input, 'path');
    if (!rawPath) return 'path es obligatorio.';
    const resolved = this.resolve(rawPath);
    if ('error' in resolved) return resolved.error;
    const file = resolved.file;
    this.say(`Leyendo ${cut(file.name, PROGRESS_MAX)}…`, `Reading ${cut(file.name, PROGRESS_MAX)}…`);
    const content = await this.load(file, READ_FILE_BYTES);
    if (content === null) return this.denied.has(file.path) ? 'Archivo no permitido.' : 'No se pudo leer el archivo (binario, ilegible o demasiado grande).';
    const lines = content.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const startIn = optionalInt(input, 'startLine');
    const endIn = optionalInt(input, 'endLine');
    let start: number;
    let end: number;
    if (startIn === null && endIn === null) {
      start = 1;
      end = total <= READ_WHOLE_LINES ? total : READ_DEFAULT_LINES;
    } else if (startIn !== null) {
      start = Math.max(1, startIn);
      end = endIn !== null ? endIn : start + READ_DEFAULT_LINES - 1;
    } else {
      end = Math.max(1, endIn as number);
      start = Math.max(1, end - READ_DEFAULT_LINES + 1);
    }
    if (start > total) return `El archivo tiene ${total} líneas; startLine ${start} está fuera de rango.`;
    if (end < start) return 'endLine debe ser mayor o igual que startLine.';
    end = Math.min(end, total, start + READ_MAX_LINES - 1);
    let slice = lines.slice(start - 1, end);
    let chars = 0;
    let keep = 0;
    for (const line of slice) {
      if (keep > 0 && chars + line.length + 1 > READ_MAX_CHARS) break;
      chars += line.length + 1;
      keep++;
    }
    slice = slice.slice(0, keep);
    if (slice.length === 1 && slice[0].length > READ_MAX_CHARS) slice = [cut(slice[0], READ_MAX_CHARS)];
    end = start + slice.length - 1;
    this.markRead(file.path, start, end);
    this.readPaths.add(file.path);
    let out = `### ${file.path}:L${start}-L${end} (de ${total} lineas)\n${numbered(slice.join('\n'), start)}`;
    if (end < total) out += `\n(quedan líneas hasta la ${total}: pide otro rango con startLine/endLine)`;
    return out;
  }

  /* ------------------------------ traza_list ------------------------------ */

  private list(input: Record<string, unknown>): string {
    const pathRaw = text(input, 'path');
    const patternRaw = text(input, 'pattern');
    if (!pathRaw && !patternRaw) {
      this.say(`Explorando ${cut(this.mounts.join(', '), PROGRESS_MAX)}…`, `Exploring ${cut(this.mounts.join(', '), PROGRESS_MAX)}…`);
      return this.overview();
    }
    const filtered = this.filter(pathRaw, patternRaw);
    if (filtered.error) return filtered.error;
    const label = this.folderLabel(pathRaw);
    this.say(`Explorando ${label}…`, `Exploring ${label}…`);
    if (!filtered.files.length) return 'Ningún archivo permitido cumple path/pattern.';
    const shown = filtered.files.slice(0, LIST_MAX);
    return `${filtered.files.length} archivos (mostrando ${shown.length}); refina con path o pattern\n${shown.map((f) => f.path).join('\n')}`;
  }
}
