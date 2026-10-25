import { Injectable } from '@angular/core';
import { NexoBridge } from '../../bridge/nexo-bridge';
import { NexoProjectService } from '../../project/nexo-project.service';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { shortType } from '../workspace-code-db/workspace-code-db.util';
import { DbExplainAiResponse, DbExplainScript, buildLocalExplainScript, mergeAiScript } from '../workspace-code-db/workspace-code-db-explain';
import { WorkspaceCodeFile, encodeUtf8Base64, isCodeFileReady, isSensitiveCodeFile } from '../workspace-code.types';
import { WorkspaceCodeDatabaseMetadata, WorkspaceCodeDbTable } from './workspace-code-runtime.types';

const CODE_EXTENSIONS = new Set(['java', 'kt', 'ts', 'js', 'py', 'php', 'cs', 'sql']);
const EXCLUDED_PATH = /(^|\/)(node_modules|target|build|dist|\.git)(\/|$)/i;
const MAX_CANDIDATES = 60;
const MAX_READS = 40;
const READ_CONCURRENCY = 6;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_HINTS = 8;
const MAX_HINT_CHARS = 14000;
const ENTITY_LINES = 120;
const ENTITY_CHARS = 2500;
const WINDOW_LINES = 5;
const WINDOW_COUNT = 3;
const WINDOW_CHARS = 1200;
const MAX_RELATED = 12;
const MAX_RELATED_COLUMNS = 20;
const MAX_TARGET_COLUMNS = 60;
const MAX_BASE64_CHARS = 78000;
const HINTS_TTL_MS = 60_000;
const CACHE_LIMIT = 40;

interface CodeHint { path: string; snippet: string }
interface CodeHints { hints: CodeHint[]; endpoint: string | null }

/**
 * Datos para el modo «Explicar» del diagrama de una tabla: guion local a partir del esquema, endpoint real del proyecto
 * (si se encuentra en el código) y mejora opcional con la IA de Nexo. Copia de chatFront adaptada a la extensión: el
 * esquema siempre lo da el modo «Base de datos» del flujo (`override`) y la petición a la IA la hace el host.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeDbExplainService {
  private readonly hintCache = new Map<string, { at: number; promise: Promise<CodeHints> }>();
  private readonly aiCache = new Map<string, DbExplainScript>();

  constructor(
    private project: NexoProjectService,
    private i18n: WorkspaceCodeI18nService,
    private bridge: NexoBridge,
  ) {}

  /**
   * Guion inmediato a partir de la metadata ya cargada; `null` si la tabla no existe. `override`: esquema propio (modo
   * «Base de datos» del flujo) en lugar de la metadata de la conexión.
   */
  local(_key: string, table: string, override?: WorkspaceCodeDatabaseMetadata): DbExplainScript | null {
    const meta = override ?? null;
    if (!meta) return null;
    return buildLocalExplainScript(meta.tables, table, (k, p) => this.i18n.t(k, p));
  }

  /** `POST /api/...` real de la entidad si se detecta en un controlador del proyecto. */
  async endpointHint(key: string, table: string): Promise<string | null> {
    try {
      return (await this.hintsFor(key, table)).endpoint;
    } catch (error: unknown) {
      console.warn('[Nexo] No se pudo buscar el endpoint de la tabla.', error instanceof Error ? error.name : '');
      return null;
    }
  }

  /** Pide a la IA un guion mejor. Lanza un error con el mensaje a mostrar si no se puede. */
  async enhance(key: string, table: string, base: DbExplainScript, override?: WorkspaceCodeDatabaseMetadata): Promise<DbExplainScript> {
    const meta = override ?? null;
    const target = meta?.tables.find((x) => x.name === table);
    if (!meta || !target) throw new Error(this.i18n.t('dbw.tableMissing'));
    const language = this.i18n.language;
    const cacheKey = `${key}|${table}|${language}|${this.schemaSig(target)}`;
    const cached = this.aiCache.get(cacheKey);
    if (cached) return cached;

    let hints: CodeHint[] = [];
    try {
      hints = (await this.hintsFor(key, table)).hints;
    } catch (error: unknown) {
      console.warn('[Nexo] No se pudieron reunir las pistas de código.', error instanceof Error ? error.name : '');
      hints = [];
    }
    const context = this.context(meta.provider, target, meta.tables, hints, base);
    let contextBase64 = encodeUtf8Base64(JSON.stringify(context));
    while (contextBase64.length > MAX_BASE64_CHARS && context.codeHints.length) {
      context.codeHints.pop();
      contextBase64 = encodeUtf8Base64(JSON.stringify(context));
    }
    const response = await this.bridge.request<DbExplainAiResponse>({ op: 'dbExplain', body: { language, contextBase64 } });
    if (!response?.success) throw new Error(response?.mensaje || this.i18n.t('dbw.explain.aiFailed'));
    const merged = mergeAiScript(base, meta.tables, response);
    if (!merged) throw new Error(this.i18n.t('dbw.explain.aiFailed'));
    this.aiCache.set(cacheKey, merged);
    if (this.aiCache.size > CACHE_LIMIT) this.aiCache.delete(this.aiCache.keys().next().value as string);
    return merged;
  }

  /* ---------------------------- contexto para la IA ---------------------------- */

  private schemaSig(table: WorkspaceCodeDbTable): string {
    return JSON.stringify([
      table.columns.map((c) => [c.name, shortType(c)]),
      table.foreignKeys.map((f) => [f.columns, f.refTable, f.refColumns]),
      table.referencedBy.map((r) => [r.table, r.columns]),
    ]);
  }

  private context(provider: string, target: WorkspaceCodeDbTable, tables: WorkspaceCodeDbTable[], hints: CodeHint[], base: DbExplainScript) {
    const byName = new Map(tables.map((x) => [x.name, x]));
    const related: { name: string; type: string; role: 'parent' | 'child'; columns: { name: string; type: string; pk: boolean }[] }[] = [];
    const add = (name: string, role: 'parent' | 'child') => {
      if (name === target.name || related.length >= MAX_RELATED || related.some((r) => r.name === name)) return;
      const t = byName.get(name);
      if (!t) return;
      related.push({
        name, type: t.type, role,
        columns: t.columns.slice(0, MAX_RELATED_COLUMNS).map((c) => ({ name: c.name, type: shortType(c), pk: c.primaryKey })),
      });
    };
    target.foreignKeys.forEach((fk) => add(fk.refTable, 'parent'));
    target.referencedBy.forEach((r) => add(r.table, 'child'));
    return {
      provider,
      target: {
        name: target.name, type: target.type, comment: target.comment,
        columns: target.columns.slice(0, MAX_TARGET_COLUMNS).map((c) => ({
          name: c.name, type: shortType(c), nullable: c.nullable, pk: c.primaryKey, unique: c.unique, auto: c.autoIncrement,
          default: c.defaultValue, extra: c.extra, comment: c.comment,
        })),
        foreignKeys: target.foreignKeys.map((f) => ({ name: f.name, columns: f.columns, refTable: f.refTable, refColumns: f.refColumns, onDelete: f.onDelete, onUpdate: f.onUpdate })),
        referencedBy: target.referencedBy.map((r) => ({ table: r.table, columns: r.columns, refColumns: r.refColumns })),
      },
      related,
      codeHints: hints.map((h) => ({ path: h.path, snippet: h.snippet })),
      localSteps: base.steps.map((s) => ({ kind: s.kind, from: s.from, to: s.to, title: s.title })),
    };
  }


  /* ---------------------------- pistas de código ---------------------------- */

  private hintsFor(key: string, table: string): Promise<CodeHints> {
    const cacheKey = `${key}|${table}`;
    const cached = this.hintCache.get(cacheKey);
    if (cached && Date.now() - cached.at < HINTS_TTL_MS) return cached.promise;
    const promise = this.collectHints(table).catch((error: unknown): CodeHints => {
      console.warn('[Nexo] No se pudieron reunir las pistas de código.', error instanceof Error ? error.name : '');
      return { hints: [], endpoint: null };
    });
    this.hintCache.set(cacheKey, { at: Date.now(), promise });
    if (this.hintCache.size > CACHE_LIMIT) this.hintCache.delete(this.hintCache.keys().next().value as string);
    return promise;
  }

  /** `mensaje_programado` -> `MensajeProgramado`. */
  private pascal(name: string): string {
    return name.split(/[_\-\s]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  }

  private variants(table: string): string[] {
    const names = new Set<string>([table]);
    if (table.endsWith('es') && table.length > 4) names.add(table.slice(0, -2));
    if (table.endsWith('s') && table.length > 3) names.add(table.slice(0, -1));
    return [...names];
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async readContent(file: WorkspaceCodeFile): Promise<string | null> {
    if (file.binary) return null;
    if (file.size !== undefined && file.size > MAX_FILE_BYTES) return null;
    let content: string | null = null;
    if (isCodeFileReady(file)) content = file.content;
    else if (this.project.canRead(file)) {
      const read = await this.project.readLocalFile(file);
      if (read.ok && !read.binary) content = read.content;
    }
    return content !== null && content.length <= MAX_FILE_BYTES ? content : null;
  }

  private async collectHints(table: string): Promise<CodeHints> {
    const prefix = '';
    const names = this.variants(table);
    const classNames = [...new Set(names.map((n) => this.pascal(n)).filter((n) => n.length >= 3))];
    const tableRegexes = names.map((n) => {
      const e = this.escapeRegex(n);
      return new RegExp(
        `@Table\\s*\\(\\s*name\\s*=\\s*"${e}"|@Entity\\s*\\(\\s*['"]${e}['"]|tableName:\\s*['"]${e}['"]|db_table\\s*=\\s*['"]${e}['"]|@@map\\("${e}"\\)|INSERT\\s+INTO\\s+[\`"]?${e}\\b|CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"]?${e}\\b`, 'i');
    });
    const matchesTable = (content: string) => tableRegexes.some((r) => r.test(content));
    const mentionsClass = (content: string) => classNames.some((c) => new RegExp(`\\b${this.escapeRegex(c)}\\b`).test(content));

    const eligible = this.project.project.files.filter((f) =>
      !f.binary && CODE_EXTENSIONS.has(f.extension) && f.path.startsWith(prefix) && !EXCLUDED_PATH.test(f.path) && !isSensitiveCodeFile(f.name));
    if (!eligible.length) return { hints: [], endpoint: null };

    // Candidatos por nombre de archivo o por contenido ya cargado.
    const scored = new Map<WorkspaceCodeFile, number>();
    for (const file of eligible) {
      const byClass = classNames.some((c) => file.name.includes(c));
      const byKind = file.extension === 'sql' || /entity|model|schema/i.test(file.path);
      const byContent = isCodeFileReady(file) && matchesTable(file.content);
      if (byClass || byContent) scored.set(file, byContent ? 3 : 2);
      else if (byKind) scored.set(file, 1);
    }
    const candidates = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES).map(([file]) => file);

    // Lectura con concurrencia limitada, sin tocar el estado del proyecto.
    const contents = new Map<WorkspaceCodeFile, string>();
    const queue = candidates.slice(0, MAX_READS);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const file = queue[cursor++];
        try {
          const content = await this.readContent(file);
          if (content !== null) contents.set(file, content);
        } catch (error: unknown) {
          // Un archivo que no se puede leer simplemente no aporta pistas.
          console.warn('[Nexo] No se pudo leer un archivo para las pistas.', error instanceof Error ? error.name : '');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, () => worker()));

    const entities: CodeHint[] = [];
    const controllers: CodeHint[] = [];
    const services: CodeHint[] = [];
    let endpoint: string | null = null;

    for (const file of queue) {
      const content = contents.get(file);
      if (content === undefined) continue;
      const byClass = classNames.some((c) => file.name.includes(c));
      const tableMatch = matchesTable(content);
      const isController = /Controller/.test(file.name);
      const isService = /Service|Repository|Dao/.test(file.name);

      if (isController && classNames.some((c) => file.name.startsWith(c)) && endpoint === null) endpoint = this.endpointOf(content);

      if (file.extension === 'sql') {
        if (!tableMatch) continue;
        const lines = content.split(/\r?\n/);
        const at = lines.findIndex((l) => names.some((n) => new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"]?${this.escapeRegex(n)}\\b`, 'i').test(l)));
        if (at < 0) continue;
        entities.push({ path: file.path, snippet: lines.slice(at, at + 40).join('\n').slice(0, ENTITY_CHARS) });
      } else if (!isController && !isService && (tableMatch || (byClass && /@Entity|@Table|class\s+\w+/.test(content)))) {
        entities.push({ path: file.path, snippet: content.split(/\r?\n/).slice(0, ENTITY_LINES).join('\n').slice(0, ENTITY_CHARS) });
      } else if ((isController || isService) && (byClass || mentionsClass(content))) {
        const snippet = this.windows(content);
        if (!snippet) continue;
        (isController ? controllers : services).push({ path: file.path, snippet });
      }
    }

    const hints: CodeHint[] = [];
    let chars = 0;
    for (const hint of [...entities, ...controllers, ...services]) {
      if (hints.length >= MAX_HINTS) break;
      const room = MAX_HINT_CHARS - chars;
      if (room < 200) break;
      const snippet = hint.snippet.slice(0, room);
      hints.push({ path: hint.path, snippet });
      chars += snippet.length + hint.path.length;
    }
    return { hints, endpoint };
  }

  /** Ventanas de ±5 líneas alrededor de las líneas que crean o guardan registros. */
  private windows(content: string): string {
    const lines = content.split(/\r?\n/);
    const trigger = /@PostMapping|@PutMapping|@RequestMapping|\.save\(|saveAndFlush|insert|create/i;
    const taken: string[] = [];
    let until = -1;
    for (let i = 0; i < lines.length && taken.length < WINDOW_COUNT; i++) {
      if (i <= until || !trigger.test(lines[i])) continue;
      const from = Math.max(0, i - WINDOW_LINES);
      const to = Math.min(lines.length - 1, i + WINDOW_LINES);
      taken.push(lines.slice(from, to + 1).join('\n'));
      until = to;
    }
    return taken.join('\n// ...\n').slice(0, WINDOW_CHARS);
  }

  /** `POST /base/ruta` de un controlador Spring; `null` si usa constantes o no hay `@PostMapping`. */
  private endpointOf(content: string): string | null {
    if (!/@PostMapping/.test(content)) return null;
    const base = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]+)"/.exec(content)?.[1] ?? '';
    const post = /@PostMapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)")?/.exec(content)?.[1] ?? '';
    let path = base;
    if (post) path += post.startsWith('/') || path.endsWith('/') ? post : '/' + post;
    if (!path) return null;
    if (!path.startsWith('/')) path = '/' + path;
    return /^\/[\w\-/{}.:]*$/.test(path) ? `POST ${path}` : null;
  }
}
