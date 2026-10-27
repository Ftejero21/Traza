import type { NexoProjectService } from '../../project/nexo-project.service';
import { WorkspaceCodeFile, isCodeFileReady, isSensitiveCodeFile, normalizeCodePath } from '../workspace-code.types';
import { CodeRef, CodeSnippet, FlowCodeSnapshot, FlowDiagnosis, FlowDiagram, FlowStep, SnippetView } from './nexo-ia.types';
import { SNAPSHOT_MAX_LINES, SNAPSHOT_MAX_LINE_CHARS } from './workspace-code-flow-sanitize';

export interface VerifiedRef {
  ref: CodeRef;
  file: WorkspaceCodeFile | null;
  lines: string[] | null;
  /**
   * El archivo existe en el proyecto (y está permitido) pero ahora no se pueden leer sus líneas (carpeta local sin
   * conectar o fallo de lectura): la referencia conserva la verificación previa en lugar de rebajarse.
   */
  unreadable?: boolean;
}

export interface ValidatedFlow {
  flow: FlowDiagram;
  /** Fragmento releído del archivo real por id de paso. */
  snippets: Map<string, SnippetView>;
  /** Id de archivo del proyecto por referencia (`refKey`). */
  fileIds: Map<string, string>;
}

/** Fragmento del código de un método: líneas máximas y archivos candidatos máximos. */
const METHOD_SNIPPET_MAX_LINES = 40;
const METHOD_SNIPPET_MAX_FILES = 8;
const MAX_TEXT_CHARS = 3 * 1024 * 1024;
const DECLARATION_LINE = /^\s*(?:(?:public|private|protected|internal|static|async|override|abstract|final|synchronized|readonly|virtual|function)\s+)*(?:[\w$<>\[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const NOT_DECLARATION = /^\s*(?:return|await|if|else|while|for|switch|throw|new|yield|case|const|let|var|this|super|catch)\b/;
const NOT_DECLARATION_NAME = new Set(['return', 'await', 'if', 'else', 'while', 'for', 'switch', 'throw', 'new', 'yield', 'case', 'const', 'let', 'var', 'this', 'super', 'catch']);
const BRACE_LANGS =new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'cs', 'go', 'scala', 'swift', 'dart', 'php', 'c', 'cpp', 'h', 'hpp', 'rs']);

export function refKey(ref: Pick<CodeRef, 'mountId' | 'file'>): string {
  return `${ref.mountId}\u0000${ref.file}`;
}

/** `functionName` de un decorador o anotación de clase (`@Component`). */
export function isDecoratorFunctionName(fn: string | null | undefined): boolean {
  return /^@/.test(String(fn ?? '').trim());
}

/** Etiqueta de la función: `@Component` tal cual; el resto como `nombre()`. */
export function functionLabel(fn: string): string {
  return isDecoratorFunctionName(fn) ? fn : `${fn}()`;
}

/** Etiqueta de símbolo: `Clase @Decorador` o `Clase.funcion()`. */
export function refSymbolLabel(ref: Pick<CodeRef, 'className' | 'functionName'>): string {
  return isDecoratorFunctionName(ref.functionName) ? `${ref.className} ${ref.functionName}` : `${ref.className}.${ref.functionName}()`;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Comprueba cada `CodeRef` de la IA contra el archivo real antes de mostrarla, sin juzgar su contenido: solo se mira que
 * el archivo exista (y esté permitido) y que la línea caiga dentro del archivo. No se reubica por `anchor` ni se reescribe
 * `functionName`. Los fragmentos se vuelven a leer siempre del archivo real.
 * Los archivos sensibles, excluidos o ignorados nunca se leen: sus referencias quedan `unverified`.
 */
export class FlowRefValidator {
  /** Caché de texto por pasada (id de archivo → líneas, o `null` si no se pudo leer). */
  private readonly texts = new Map<string, Promise<string[] | null>>();

  constructor(
    private project: NexoProjectService,
    private isAllowed: (file: WorkspaceCodeFile) => boolean,
  ) {}

  /** Archivo del proyecto al que apunta la referencia: montaje + ruta, ruta virtual o sufijo único. */
  resolveFile(ref: Pick<CodeRef, 'mountId' | 'file'>): WorkspaceCodeFile | null {
    const rel = normalizeCodePath(String(ref.file ?? '').replace(/\\/g, '/').replace(/^\.?\//, ''));
    if (!rel) return null;
    const mounts = this.project.project.mounts;
    const mount = ref.mountId ? mounts.find((m) => m.id === ref.mountId) : null;
    if (mount) {
      const joined = mount.path ? `${mount.path}/${rel}` : rel;
      const hit = this.project.fileByPath(joined);
      if (hit) return hit;
    }
    const direct = this.project.fileByPath(rel);
    if (direct) return direct;
    const suffix = `/${rel}`;
    const matches = this.project.project.files.filter((f) => f.path.endsWith(suffix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
    // Prefijo incorrecto de la IA: se quitan segmentos iniciales hasta dar con un sufijo que identifique un único archivo.
    const parts = rel.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const tail = parts.slice(i).join('/');
      const hits = this.project.project.files.filter((f) => f.path === tail || f.path.endsWith(`/${tail}`));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null;
    }
    return null;
  }

  /** Archivo legible para Nexo IA (no sensible, no binario, permitido). */
  usable(file: WorkspaceCodeFile | null): file is WorkspaceCodeFile {
    return !!file && !file.binary && !isSensitiveCodeFile(file.name) && this.isAllowed(file);
  }

  /** Líneas del archivo real (estado del editor o disco local); `null` si no se puede leer o no está permitido. */
  linesOf(file: WorkspaceCodeFile | null): Promise<string[] | null> {
    if (!this.usable(file)) return Promise.resolve(null);
    const cached = this.texts.get(file.id);
    if (cached) return cached;
    const task = (async (): Promise<string[] | null> => {
      if (isCodeFileReady(file)) return file.content.length > MAX_TEXT_CHARS ? null : file.content.split(/\r?\n/);
      if (!this.project.canRead(file)) return null;
      try {
        const read = await this.project.readLocalFile(file);
        if (!read.ok || read.binary || read.content.length > MAX_TEXT_CHARS) return null;
        return read.content.split(/\r?\n/);
      } catch {
        return null;
      }
    })();
    this.texts.set(file.id, task);
    return task;
  }

  /**
   * Comprueba y corrige una referencia. Si el archivo se puede leer, nunca confía en `verification` de entrada. Si el
   * archivo existe pero ahora no se puede leer (`unreadable`), conserva la verificación y la línea previas (o
   * `unverified` si no había ninguna). Con el archivo legible, la ref es `exact` si su línea cae dentro del archivo y
   * `unverified` si no.
   */
  async verify(input: CodeRef): Promise<VerifiedRef> {
    const previous = input.verification;
    const ref: CodeRef = { ...input };
    delete ref.verification;
    const file = this.resolveFile(ref);
    const lines = await this.linesOf(file);
    if (!file || !lines) {
      const usable = this.usable(file);
      if (usable) return { ref: { ...ref, verification: previous ?? 'unverified' }, file, lines: null, unreadable: true };
      return { ref: { ...ref, verification: 'unverified' }, file: null, lines: null };
    }

    const inside = Number.isInteger(ref.line) && ref.line >= 1 && ref.line <= lines.length;
    return { ref: { ...ref, verification: inside ? 'exact' : 'unverified' }, file, lines };
  }

  /** Rangos [inicio, fin] (1-based) del cuerpo de cada declaración de la función; vacío si no se localiza. */
  functionBodies(lines: string[], fn: string, ext: string): [number, number][] {
    if (!fn) return [];
    const name = escapeRe(fn);
    if (ext === 'py') {
      const decl = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+${name}\\b`);
      const out: [number, number][] = [];
      lines.forEach((l, i) => {
        const m = l.match(decl);
        if (!m) return;
        const indent = m[1].length;
        let end = i + 1;
        for (let j = i + 1; j < lines.length; j++) {
          const t = lines[j];
          if (!t.trim()) continue;
          if (t.length - t.trimStart().length <= indent) break;
          end = j + 1;
        }
        out.push([i + 1, end]);
      });
      return out;
    }
    if (!BRACE_LANGS.has(ext)) return [];
    const call = new RegExp(`(^|[^.\\w$])${name}\\s*(<[^>]*>)?\\s*\\(`);
    const assigned = new RegExp(`(^|[^.\\w$])${name}\\s*[=:]\\s*(async\\s*)?(function\\b|\\(|[\\w$]+\\s*=>)`);
    const statement = /^\s*(return|await|if|else|while|for|switch|throw|new|yield)\b/;
    const out: [number, number][] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!(call.test(l) || assigned.test(l)) || statement.test(l)) continue;
      const range = this.braceBody(lines, i);
      if (!range) continue;
      // Anotaciones y decoradores pegados a la declaración (`@MessageMapping(...)`, `@HostListener`) forman parte de ella.
      let start = range[0];
      while (start > 1 && /^\s*@[\w.]+/.test(lines[start - 2])) start--;
      out.push([start, range[1]]);
    }
    return out;
  }

  /**
   * Método más externo (≤ `maxLines` líneas) que contiene las líneas [from, to] (1-based), buscando hacia arriba hasta
   * 300 líneas. Solo lenguajes con llaves; `null` si no se localiza. Con callbacks anidados (`setTimeout(`) gana el método.
   */
  enclosingFunction(lines: string[], from: number, to: number, ext: string, maxLines: number): [number, number] | null {
    if (!BRACE_LANGS.has(ext) || from < 1 || to < from || from > lines.length) return null;
    const last = Math.min(to, lines.length);
    let best: [number, number] | null = null;
    for (let n = Math.min(from, lines.length); n >= Math.max(1, from - 300); n--) {
      const m = lines[n - 1].match(DECLARATION_LINE);
      if (!m || NOT_DECLARATION.test(lines[n - 1]) || NOT_DECLARATION_NAME.has(m[1])) continue;
      const range = this.braceBody(lines, n - 1);
      if (!range) continue;
      let start = range[0];
      while (start > 1 && /^\s*@[\w.]+/.test(lines[start - 2])) start--;
      if (start > from || range[1] < last || range[1] - start + 1 > maxLines) continue;
      if (!best || range[1] - start > best[1] - best[0]) best = [start, range[1]];
    }
    return best;
  }

  /** Desde la declaración en `start` (0-based), cuerpo por conteo de llaves (sin cadenas ni comentarios de línea). */
  private braceBody(lines: string[], start: number): [number, number] | null {
    let depth = 0;
    let opened = false;
    for (let i = start; i < lines.length && (opened || i < start + 8); i++) {
      const clean = lines[i].replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""').replace(/\/\/.*$/, '');
      for (const ch of clean) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') {
          depth--;
          if (opened && depth <= 0) return [start + 1, i + 1];
        } else if (ch === ';' && !opened) {
          return null;
        }
      }
    }
    return opened ? [start + 1, lines.length] : null;
  }

  /** Fragmento releído del archivo real alrededor de la referencia (3–8 líneas, empezando 2 antes). */
  /**
   * Si el archivo no se puede leer ahora y hay `snapshot` (código guardado al generar el flujo), el fragmento se
   * construye desde él con la verificación conservada y la marca `cached`.
   */
  async snippetFor(ref: CodeRef | null, snippet?: CodeSnippet | null, snapshot?: FlowCodeSnapshot | null): Promise<SnippetView | null> {
    if (!ref) return null;
    // Una referencia ya verificada en esta pasada no se vuelve a comprobar (conserva «corrected»).
    let checked: VerifiedRef;
    if (ref.verification) {
      const file = this.resolveFile(ref);
      const usable = this.usable(file);
      const lines = await this.linesOf(file);
      checked = { ref, file: usable ? file : null, lines, unreadable: usable && !lines };
    } else {
      checked = await this.verify(ref);
    }
    const r = checked.ref;
    if (checked.unreadable && snapshot && snapshot.lines.length && r.verification && r.verification !== 'unverified') {
      return {
        file: checked.file ? checked.file.path : snapshot.file,
        fileId: checked.file ? checked.file.id : null,
        startLine: snapshot.startLine,
        lines: [...snapshot.lines],
        highlightLine: snapshot.highlightLine,
        language: snapshot.language || checked.file?.extension || snippet?.language || '',
        verification: r.verification,
        cached: true,
      };
    }
    const length = Math.min(8, Math.max(3, snippet?.length ?? 5));
    if (checked.lines && checked.lines.length) {
      // Con el archivo legible se muestra siempre el fragmento real, también si la línea de la IA no se pudo verificar.
      const total = checked.lines.length;
      const line = Number.isFinite(r.line) ? Math.min(total, Math.max(1, Math.floor(r.line))) : 1;
      const first = Math.max(1, Math.min(line - 2, total - length + 1));
      return {
        file: checked.file ? checked.file.path : r.file,
        fileId: checked.file ? checked.file.id : null,
        startLine: first,
        lines: checked.lines.slice(first - 1, first - 1 + length),
        highlightLine: line,
        language: checked.file?.extension || snippet?.language || '',
        verification: r.verification ?? 'unverified',
      };
    }
    const startLine = Math.max(1, r.line - 2);
    const lines: string[] = [];
    return {
      file: checked.file ? checked.file.path : r.file,
      fileId: checked.file && r.verification !== 'unverified' ? checked.file.id : null,
      startLine,
      lines,
      highlightLine: r.line,
      language: checked.file?.extension || snippet?.language || '',
      verification: r.verification ?? 'unverified',
    };
  }

  /**
   * Código de un método (`Clase.método`) releído de los archivos reales del proyecto: primero el archivo de `hint`
   * (si encaja con la clase) y después los archivos cuyo nombre coincide con `className`. `null` si no se localiza.
   * Los identificadores se validan antes de usarse en una expresión regular.
   */
  async methodSnippet(className: string, functionName: string, hint: CodeRef | null): Promise<SnippetView | null> {
    const ident = /^[A-Za-z_$][\w$]*$/;
    if (!ident.test(functionName) || (className !== '' && !ident.test(className))) return null;
    const candidates: WorkspaceCodeFile[] = [];
    const add = (f: WorkspaceCodeFile | null) => {
      if (f && this.usable(f) && !candidates.includes(f) && candidates.length < METHOD_SNIPPET_MAX_FILES) candidates.push(f);
    };
    let hintFile: WorkspaceCodeFile | null = null;
    if (hint && (className === '' || hint.className === className)) {
      hintFile = this.resolveFile(hint);
      if (this.usable(hintFile)) add(hintFile);
      else hintFile = null;
    }
    if (className) {
      const flat = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      const wanted = flat(className);
      for (const f of this.project.project.files) {
        if (candidates.length >= METHOD_SNIPPET_MAX_FILES) break;
        if (!this.usable(f)) continue;
        const base = f.name.replace(/\.[^.]+$/, '');
        if (base === className || flat(base) === wanted) add(f);
      }
    }
    const call = new RegExp(`(^|[^.\\w$])${escapeRe(functionName)}\\s*(<[^>]*>)?\\s*\\(`);
    const statement = /^\s*(return|await|if|else|while|for|switch|throw|new|yield)\b/;
    for (const file of candidates) {
      const lines = await this.linesOf(file);
      if (!lines || !lines.length) continue;
      const ext = file.extension.toLowerCase();
      const bodies = this.functionBodies(lines, functionName, ext);
      let range: [number, number] | null = null;
      if (bodies.length) {
        range = bodies[0];
        if (bodies.length > 1 && hint && file === hintFile) {
          range = bodies.reduce((best, b) => (Math.abs(b[0] - hint.line) < Math.abs(best[0] - hint.line) ? b : best), bodies[0]);
        }
      } else {
        // Sin cuerpo (p. ej. método de una interfaz): la declaración con sus anotaciones, hasta `;` o `{`.
        const at = lines.findIndex((l) => call.test(l) && !statement.test(l));
        if (at < 0) continue;
        let start = at;
        while (start > 0 && at - start < 5 && /^\s*@/.test(lines[start - 1])) start--;
        let end = at;
        while (end < lines.length - 1 && end - start < 5 && !/[;{]\s*$/.test(lines[end])) end++;
        range = [start + 1, end + 1];
      }
      const first = range[0];
      const last = Math.min(range[1], first + METHOD_SNIPPET_MAX_LINES - 1, lines.length);
      const shown = lines.slice(first - 1, last);
      if (!shown.length) continue;
      let decl = first;
      while (decl < last && /^\s*@/.test(lines[decl - 1])) decl++;
      return {
        file: file.path,
        fileId: file.id,
        startLine: first,
        lines: shown,
        highlightLine: decl,
        language: file.extension,
        verification: 'exact',
      };
    }
    return null;
  }

  /** Para pasos sql/http/generated: el código generado por la IA sustituye a la lectura del archivo. */
  generatedSnippet(step: FlowStep, ref: CodeRef | null, fileId: string | null): SnippetView | null {
    const g = step.generatedCode;
    if (!g || !(step.kind === 'sql' || step.kind === 'http' || step.kind === 'generated')) return null;
    const lines = g.code.split(/\r?\n/).slice(0, 60);
    return {
      file: g.title || (ref ? ref.file : ''),
      fileId: ref && ref.verification !== 'unverified' ? fileId : null,
      startLine: 1,
      lines,
      highlightLine: Math.min(lines.length, Math.max(0, g.highlightIndex)) + 1,
      language: g.language || step.kind,
      verification: ref?.verification ?? 'unverified',
      generated: true,
    };
  }

  /** Valida `steps[].ref`, `steps[].snippet.ref` y `files[]`; devuelve el flujo corregido y los fragmentos por paso. */
  async validateFlow(input: FlowDiagram): Promise<ValidatedFlow> {
    const snippets = new Map<string, SnippetView>();
    const fileIds = new Map<string, string>();
    const remember = (v: VerifiedRef) => {
      if (v.file && v.ref.verification !== 'unverified') fileIds.set(refKey(v.ref), v.file.id);
    };
    const steps: FlowStep[] = [];
    for (const step of input.steps) {
      const next: FlowStep = { ...step };
      let fileId: string | null = null;
      if (step.ref) {
        const v = await this.verify(step.ref);
        next.ref = v.ref;
        remember(v);
        fileId = v.file && v.ref.verification !== 'unverified' ? v.file.id : null;
      }
      if (step.snippet) {
        const v = await this.verify(step.snippet.ref);
        remember(v);
        next.snippet = { ...step.snippet, ref: v.ref, highlightLine: v.ref.line, startLine: Math.max(1, v.ref.line - 2) };
      }
      const view = this.generatedSnippet(next, next.ref, fileId)
        ?? await this.snippetFor(next.ref ?? next.snippet?.ref ?? null, next.snippet, step.codeSnapshot ?? null);
      if (view) snippets.set(step.id, view);
      // Código mostrado: se guarda en el paso si se leyó del archivo real; si ahora no se pudo leer, se conserva el previo.
      if (view && !view.generated && !view.cached && view.verification !== 'unverified' && view.lines.length) {
        next.codeSnapshot = this.snapshotOf(view);
      } else if (!view?.cached && !(await this.stepUnreadable(next))) {
        delete next.codeSnapshot;
      }
      steps.push(next);
    }
    const files: CodeRef[] = [];
    for (const ref of input.files) {
      const v = await this.verify(ref);
      remember(v);
      files.push(v.ref);
    }
    return { flow: { ...input, steps, files }, snippets, fileIds };
  }

  /** Copia acotada (≤ 8 líneas de ≤ 400 caracteres) del fragmento leído del archivo real. */
  private snapshotOf(view: SnippetView): FlowCodeSnapshot {
    return {
      file: view.file.slice(0, 600),
      startLine: view.startLine,
      lines: view.lines.slice(0, SNAPSHOT_MAX_LINES).map((l) => (l.length > SNAPSHOT_MAX_LINE_CHARS ? l.slice(0, SNAPSHOT_MAX_LINE_CHARS) : l)),
      highlightLine: view.highlightLine,
      language: view.language.slice(0, 40),
    };
  }

  /** El archivo de la referencia principal del paso existe pero ahora no se puede leer (usa la caché de la pasada). */
  private async stepUnreadable(step: FlowStep): Promise<boolean> {
    const ref = step.ref ?? step.snippet?.ref ?? null;
    if (!ref) return false;
    const file = this.resolveFile(ref);
    return this.usable(file) && !(await this.linesOf(file));
  }

  /** Valida `where` y `snippet` del diagnóstico y devuelve el fragmento releído de la línea que falla. */
  async validateDiagnosis<T extends FlowDiagnosis>(input: T): Promise<{ diagnosis: T; snippet: SnippetView | null }> {
    const d: T = { ...input };
    if (d.where) d.where = (await this.verify(d.where)).ref;
    if (d.snippet) {
      const v = await this.verify(d.snippet.ref);
      d.snippet = { ...d.snippet, ref: v.ref, highlightLine: v.ref.line, startLine: Math.max(1, v.ref.line - 2) };
    }
    const snippet = await this.snippetFor(d.where ?? d.snippet?.ref ?? null, d.snippet);
    return { diagnosis: d, snippet };
  }
}
