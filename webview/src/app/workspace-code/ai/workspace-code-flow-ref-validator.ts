import type { NexoProjectService } from '../../project/nexo-project.service';
import { WorkspaceCodeFile, isCodeFileReady, isSensitiveCodeFile, normalizeCodePath } from '../workspace-code.types';
import { CodeRef, CodeSnippet, FlowCodeSnapshot, FlowDiagnosis, FlowDiagram, FlowStep, SnippetView } from './nexo-ia.types';
import { SNAPSHOT_MAX_LINES, SNAPSHOT_MAX_LINE_CHARS } from './workspace-code-flow-sanitize';

type Verification = 'exact' | 'corrected' | 'unverified';

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

const NEAR_WINDOW = 30;
const MAX_TEXT_CHARS = 3 * 1024 * 1024;
const NO_CLASS_LANGS = new Set(['html', 'htm', 'sql', 'xml', 'json', 'yml', 'yaml', 'properties']);
/** Plantillas, estilos y datos: no tienen funciones, así que `functionName` («template», «styles»…) no se busca en el texto. */
const NO_FUNCTION_LANGS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'json', 'yml', 'yaml', 'properties']);
const BRACE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'cs', 'go', 'scala', 'swift', 'dart', 'php', 'c', 'cpp', 'h', 'hpp', 'rs']);

export function refKey(ref: Pick<CodeRef, 'mountId' | 'file'>): string {
  return `${ref.mountId}\u0000${ref.file}`;
}

function norm(text: string): string {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineMatches(line: string | undefined, anchor: string): boolean {
  if (line === undefined) return false;
  const l = norm(line);
  if (!l) return false;
  return l === anchor || (anchor.length >= 12 && l.includes(anchor));
}

/**
 * Valida cada `CodeRef` de la IA contra el archivo real antes de mostrarla: el archivo existe (y está permitido), la
 * línea contiene `anchor` (o se corrige buscándolo cerca y en todo el archivo), la clase y la función aparecen en el
 * archivo y la línea cae dentro del cuerpo de la función. Los fragmentos se vuelven a leer siempre del archivo real.
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
    return matches.length === 1 ? matches[0] : null;
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
   * `unverified` si no había ninguna).
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

    const anchor = norm(ref.anchor);
    const ext = file.extension.toLowerCase();
    const text = lines.join('\n');
    let verification: Verification = 'unverified';
    let line = ref.line;
    if (anchor) {
      if (lineMatches(lines[ref.line - 1], anchor)) {
        verification = 'exact';
      } else {
        const found = this.findAnchor(lines, anchor, ref.line);
        if (found !== null) {
          verification = 'corrected';
          line = found;
        }
      }
    }
    // Símbolos: la función (y la clase, salvo en lenguajes sin clases) deben aparecer en el archivo.
    if (verification !== 'unverified') {
      const fnOk = NO_FUNCTION_LANGS.has(ext) || !!ref.functionName && new RegExp(`(^|[^\\w$])${escapeRe(ref.functionName)}([^\\w$]|$)`).test(text);
      const classOk = NO_CLASS_LANGS.has(ext) || (!!ref.className && new RegExp(`(^|[^\\w$])${escapeRe(ref.className)}([^\\w$]|$)`).test(text));
      if (!fnOk || !classOk) verification = 'unverified';
    }
    // La línea tiene que caer dentro del cuerpo de la función (si su declaración se localiza).
    if (verification !== 'unverified') {
      const bodies = this.functionBodies(lines, ref.functionName, ext);
      if (bodies.length && !bodies.some(([s, e]) => line >= s && line <= e)) {
        const inside = this.anchorInBodies(lines, anchor, bodies, line);
        if (inside !== null) {
          line = inside;
          verification = 'corrected';
        } else {
          verification = 'unverified';
        }
      }
    }
    return { ref: { ...ref, line, verification }, file, lines };
  }

  /** Busca `anchor` en ±30 líneas (la más cercana) y después en todo el archivo (única o la más cercana). */
  private findAnchor(lines: string[], anchor: string, around: number): number | null {
    const from = Math.max(1, around - NEAR_WINDOW);
    const to = Math.min(lines.length, around + NEAR_WINDOW);
    let best: number | null = null;
    for (let n = from; n <= to; n++) {
      if (lineMatches(lines[n - 1], anchor) && (best === null || Math.abs(n - around) < Math.abs(best - around))) best = n;
    }
    if (best !== null) return best;
    for (let n = 1; n <= lines.length; n++) {
      if (lineMatches(lines[n - 1], anchor) && (best === null || Math.abs(n - around) < Math.abs(best - around))) best = n;
    }
    return best;
  }

  private anchorInBodies(lines: string[], anchor: string, bodies: [number, number][], around: number): number | null {
    if (!anchor) return null;
    let best: number | null = null;
    for (const [s, e] of bodies) {
      for (let n = s; n <= e; n++) {
        if (lineMatches(lines[n - 1], anchor) && (best === null || Math.abs(n - around) < Math.abs(best - around))) best = n;
      }
    }
    return best;
  }

  /** Rangos [inicio, fin] (1-based) del cuerpo de cada declaración de la función; vacío si no se localiza. */
  private functionBodies(lines: string[], fn: string, ext: string): [number, number][] {
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
    const startLine = Math.max(1, r.line - 2);
    const lines = checked.lines ? checked.lines.slice(startLine - 1, startLine - 1 + length) : [];
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
