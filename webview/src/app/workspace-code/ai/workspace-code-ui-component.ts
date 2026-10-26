/**
 * Vista de pantalla (Nexo IA, fase 2.2): análisis estático y puro de un componente Angular (sin ejecutar nada). Lee
 * los metadatos de `@Component`, las etiquetas hijas de la plantilla, los valores por defecto de los campos y prepara
 * el texto que se envía a la IA cuando hay que recortar.
 */

export interface ComponentMeta {
  className: string;
  selector: string;
  templateUrl?: string;
  /** Plantilla inline (solo si es un literal sin interpolación `${`). */
  template?: string;
  styleUrls: string[];
  styles: string[];
}

/** Índice tras la cadena que empieza en `i` (comillas simples, dobles o plantilla). */
function skipString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j++;
    j++;
  }
  return Math.min(j + 1, src.length);
}

/** Índice tras el comentario que empieza en `i` (o `i` si no hay). */
function skipComment(src: string, i: number): number {
  if (src[i] !== '/') return i;
  if (src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return i;
}

/** Grupo equilibrado desde `i` (que apunta a `open`), respetando cadenas y comentarios. */
function balanced(src: string, i: number, open: string, close: string): { inner: string; end: number } | null {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(src, j);
      continue;
    }
    const k = skipComment(src, j);
    if (k !== j) {
      j = k;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: src.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

/** Literal de cadena JS (`'…'`, `"…"` o `` `…` `` sin `${`) → texto; `null` si no es un literal simple. */
function stringLiteral(raw: string): string | null {
  const text = raw.trim();
  if (text.length < 2) return null;
  const q = text[0];
  if ((q !== '"' && q !== "'" && q !== '`') || text[text.length - 1] !== q) return null;
  if (skipString(text, 0) !== text.length) return null;
  const body = text.slice(1, -1);
  if (q === '`' && body.includes('${')) return null;
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, e: string) => {
    if (e[0] === 'u' && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === 'n') return '\n';
    if (e === 't') return '\t';
    if (e === 'r') return '\r';
    if (e === '\n') return '';
    return e;
  });
}

/** Divide por comas de nivel superior (respeta cadenas, paréntesis, corchetes y llaves). */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      cur += src.slice(i, end);
      i = end;
      continue;
    }
    const k = skipComment(src, i);
    if (k !== i) {
      i = k;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
    i++;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Propiedades de nivel superior de un literal de objeto `{ a: …, b: … }`. */
function objectProps(inner: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const part of splitTopLevel(inner)) {
    const m = /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:/.exec(part);
    if (!m) continue;
    props.set(m[1], part.slice(m[0].length).trim());
  }
  return props;
}

/** Cadena o array de cadenas literales. */
function stringOrArray(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  const text = raw.trim();
  if (text.startsWith('[')) {
    const g = balanced(text, 0, '[', ']');
    if (!g) return null;
    const out: string[] = [];
    for (const item of splitTopLevel(g.inner)) {
      if (!item.trim()) continue;
      const s = stringLiteral(item);
      if (s === null) return null;
      out.push(s);
    }
    return out;
  }
  const s = stringLiteral(text);
  return s === null ? null : [s];
}

/** Metadatos de `@Component({...})` + nombre de la clase exportada que le sigue. `null` si no es un componente. */
export function parseComponentMeta(ts: string): ComponentMeta | null {
  const src = String(ts ?? '');
  const at = src.search(/@Component\s*\(/);
  if (at < 0) return null;
  const open = src.indexOf('(', at);
  const args = balanced(src, open, '(', ')');
  if (!args) return null;
  const objStart = args.inner.indexOf('{');
  if (objStart < 0) return null;
  const objGroup = balanced(args.inner, objStart, '{', '}');
  if (!objGroup) return null;
  const props = objectProps(objGroup.inner);
  const cls = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(src.slice(args.end));
  if (!cls) return null;
  const selectorRaw = props.get('selector');
  const selector = selectorRaw !== undefined ? stringLiteral(selectorRaw) : null;
  const meta: ComponentMeta = { className: cls[1], selector: (selector ?? '').trim(), styleUrls: [], styles: [] };
  const templateUrl = props.get('templateUrl');
  if (templateUrl !== undefined) {
    const url = stringLiteral(templateUrl);
    if (url) meta.templateUrl = url;
  }
  const template = props.get('template');
  if (template !== undefined) {
    const tpl = stringLiteral(template);
    if (tpl !== null) meta.template = tpl;
  }
  const urls = [...(stringOrArray(props.get('styleUrl')) ?? []), ...(stringOrArray(props.get('styleUrls')) ?? [])];
  meta.styleUrls = [...new Set(urls.filter((u) => !!u.trim()))];
  meta.styles = (stringOrArray(props.get('styles')) ?? []).filter((s) => !!s.trim());
  return meta;
}

const NOT_CHILD = new Set(['ng-container', 'ng-template', 'ng-content']);

/** Etiquetas de componentes hijos (con `-`) usadas en la plantilla: únicas, ≤ 8. */
export function childTags(html: string): string[] {
  const out: string[] = [];
  const re = /<([a-zA-Z][\w]*-[\w-]*)[\s/>]/g;
  let m: RegExpExecArray | null;
  const text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
  while ((m = re.exec(text))) {
    const tag = m[1].toLowerCase();
    if (NOT_CHILD.has(tag) || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 8) break;
  }
  return out;
}

/** Literal TS tipo JSON → valor (`undefined` si no es un literal plano). */
function literalValue(raw: string): unknown {
  const text = raw.trim().replace(/\s+as\s+const\s*$/, '').replace(/\s+as\s+[\w<>[\]|, ]+$/, '').trim();
  if (!text) return undefined;
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) return Number(text);
  const s = stringLiteral(text);
  if (s !== null) return s;
  if (text.startsWith('[') || text.startsWith('{')) {
    const close = text[0] === '[' ? ']' : '}';
    const g = balanced(text, 0, text[0], close);
    if (!g || g.end !== text.length) return undefined;
    if (text[0] === '[') {
      const out: unknown[] = [];
      for (const item of splitTopLevel(g.inner)) {
        if (!item.trim()) continue;
        const v = literalValue(item);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const part of splitTopLevel(g.inner)) {
      if (!part.trim()) continue;
      const m = /^\s*(?:['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))\s*:/.exec(part);
      if (!m) return undefined;
      const v = literalValue(part.slice(m[0].length));
      if (v === undefined) return undefined;
      out[m[1] ?? m[2]] = v;
    }
    return out;
  }
  return undefined;
}

/** Inicializador de un campo hasta `;` o fin de línea de nivel superior. */
function readInitializer(src: string, i: number): string {
  let j = i;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(src, j);
      continue;
    }
    const k = skipComment(src, j);
    if (k !== j) {
      j = k;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if ((c === ';' || c === '\n') && depth === 0) break;
    j++;
  }
  return src.slice(i, j);
}

/**
 * Valores por defecto de los campos con inicializador literal (string, número, booleano, null, arrays/objetos tipo
 * JSON) y de los `@Input()`. `x = signal(lit)` registra `x` y `x()`.
 */
export function extractTsDefaults(ts: string): Record<string, unknown> {
  const src = String(ts ?? '');
  const out: Record<string, unknown> = {};
  const re = /(?:^|[\s;{}])(?:@Input\([^)]*\)\s*)?(?:(?:public|private|protected|readonly|override|static)\s+)*([A-Za-z_$][\w$]*)\s*[!?]?\s*(?::\s*[^=;\n]+?)?\s*=\s*(?!=|>)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    if (/^(?:const|let|var|return|if|else|this|new|typeof|case|export|import|type)$/.test(name)) continue;
    const init = readInitializer(src, re.lastIndex).trim();
    const sig = /^(?:signal|model|input)\s*(?:<[^>]*>)?\s*\(([\s\S]*)\)$/.exec(init);
    if (sig) {
      const args = splitTopLevel(sig[1]);
      const v = args.length ? literalValue(args[0]) : undefined;
      if (v !== undefined) {
        if (!(name in out)) out[name] = v;
        out[`${name}()`] = v;
      }
      continue;
    }
    const v = literalValue(init);
    if (v !== undefined && !(name in out)) out[name] = v;
  }
  return out;
}

/** Quita comentarios (fuera de cadenas), líneas `console.*`, líneas `import` y líneas en blanco repetidas. */
export function stripTsForAi(ts: string): string {
  const src = String(ts ?? '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    const k = skipComment(src, i);
    if (k !== i) {
      i = k;
      continue;
    }
    out += c;
    i++;
  }
  const lines: string[] = [];
  let inImport = false;
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (inImport) {
      if (/;\s*$/.test(t) || /\bfrom\s+['"]/.test(t)) inImport = false;
      continue;
    }
    if (/^import\b/.test(t)) {
      if (!/;\s*$/.test(t) && !/\bfrom\s+['"][^'"]*['"]\s*;?\s*$/.test(t)) inImport = true;
      continue;
    }
    if (/^console\.\w+\(.*\);?\s*$/.test(t)) continue;
    if (!t && (!lines.length || !lines[lines.length - 1].trim())) continue;
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n').trim();
}

/** Clases, ids y etiquetas que aparecen en las plantillas (para `trimGlobalCss`). */
export function templateTokens(htmls: string[]): Set<string> {
  const used = new Set<string>();
  for (const html of htmls) {
    const text = String(html ?? '');
    for (const m of text.matchAll(/<([a-zA-Z][\w-]*)/g)) used.add(m[1].toLowerCase());
    for (const m of text.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)) for (const c of m[1].split(/\s+/)) if (c) used.add(`.${c}`);
    for (const m of text.matchAll(/\[class\.([\w-]+)\]/g)) used.add(`.${m[1]}`);
    for (const m of text.matchAll(/\[ngClass\]\s*=\s*["']([^"']*)["']/g)) {
      for (const c of m[1].matchAll(/['"]?([a-zA-Z_][\w-]*)['"]?\s*:/g)) used.add(`.${c[1]}`);
      for (const c of m[1].matchAll(/'([a-zA-Z_][\w -]*)'/g)) for (const x of c[1].split(/\s+/)) if (x) used.add(`.${x}`);
    }
    for (const m of text.matchAll(/\bid\s*=\s*["']([^"']*)["']/g)) if (m[1]) used.add(`#${m[1]}`);
  }
  return used;
}

/**
 * Recorta el CSS global a las at-rules y las reglas cuyo selector contiene alguna clase (`.x`), id (`#x`) o etiqueta
 * usada, además de `:root`, `html`, `body` y `*`. Las at-rules de agrupación se recortan por dentro.
 */
export function trimGlobalCss(css: string, usedTokens: Set<string>): string {
  const text = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const keepSelector = (prelude: string): boolean => {
    if (/(^|[\s,>+~(])(?::root|html|body|\*)(?=$|[\s,>+~:.[#)])/i.test(prelude)) return true;
    for (const m of prelude.matchAll(/([.#])(-?[_a-zA-Z][\w-]*)/g)) if (usedTokens.has(`${m[1]}${m[2]}`)) return true;
    for (const m of prelude.matchAll(/(?:^|[\s,>+~(])([a-zA-Z][\w-]*)/g)) if (usedTokens.has(m[1].toLowerCase())) return true;
    return false;
  };
  const walk = (src: string): string => {
    let out = '';
    let i = 0;
    let start = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '"' || c === "'") {
        i = skipString(src, i);
        continue;
      }
      if (c === ';') {
        out += src.slice(start, i + 1);
        start = ++i;
        continue;
      }
      if (c === '{') {
        const g = balanced(src, i, '{', '}');
        if (!g) return out + src.slice(start);
        const prelude = src.slice(start, i).trim();
        if (prelude.startsWith('@')) {
          if (/^@(?:-[\w]+-)?(?:media|supports|container|layer|document)\b/i.test(prelude)) {
            const inner = walk(g.inner);
            if (inner.trim()) out += `${prelude}{${inner}}\n`;
          } else {
            out += `${prelude}{${g.inner}}\n`;
          }
        } else if (keepSelector(prelude)) {
          out += `${prelude}{${g.inner}}\n`;
        }
        i = g.end;
        start = i;
        continue;
      }
      i++;
    }
    return out;
  };
  try {
    return walk(text);
  } catch (error: unknown) {
    console.warn('[Traza] No se pudo recortar el CSS global.', error instanceof Error ? error.name : '');
    return text;
  }
}

/* ---------- Recorte de plantillas y TS grandes ---------- */

/** Mismas etiquetas vacías que el render. */
const TEMPLATE_VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

interface TplNode {
  tag: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  /** `false` si no tiene `</tag>` propio (y no es vacío ni autocerrado). */
  closed: boolean;
  children: TplNode[];
  parent: TplNode | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefijo de `html` ≤ `max` cortado tras el último `>`. */
function htmlPrefix(html: string, max: number): string {
  const cut = html.slice(0, max);
  const at = cut.lastIndexOf('>');
  return at > 0 ? cut.slice(0, at + 1) : cut;
}

/** Árbol de elementos por escaneo de texto (no altera mayúsculas ni expresiones). Nunca lanza por HTML mal formado. */
function scanTemplate(src: string): TplNode {
  const root: TplNode = { tag: '', start: 0, openEnd: 0, closeStart: src.length, end: src.length, closed: true, children: [], parent: null };
  const stack: TplNode[] = [root];
  const nameRe = /[a-zA-Z][\w:.-]*/y;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const next = src[lt + 1];
    if (next === '/') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) break;
      const name = src.slice(lt + 2, gt).trim().toLowerCase();
      let k = stack.length - 1;
      while (k > 0 && stack[k].tag !== name) k--;
      if (k > 0) {
        // Los abiertos sin cierre terminan donde termina el contenido de su padre.
        for (let s = stack.length - 1; s > k; s--) {
          stack[s].closeStart = lt;
          stack[s].end = lt;
          stack[s].closed = false;
        }
        stack[k].closeStart = lt;
        stack[k].end = gt + 1;
        stack.length = k;
      }
      i = gt + 1;
      continue;
    }
    if (next === '!' || next === '?') {
      const gt = src.indexOf('>', lt);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    nameRe.lastIndex = lt + 1;
    const nm = nameRe.exec(src);
    if (!nm) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1 + nm[0].length;
    while (j < src.length && src[j] !== '>') {
      const c = src[j];
      if (c === '"' || c === "'") {
        const q = src.indexOf(c, j + 1);
        j = q < 0 ? src.length : q + 1;
        continue;
      }
      j++;
    }
    if (j >= src.length) break;
    const tag = nm[0].toLowerCase();
    const parent = stack[stack.length - 1];
    const node: TplNode = { tag, start: lt, openEnd: j + 1, closeStart: j + 1, end: j + 1, closed: true, children: [], parent };
    parent.children.push(node);
    if (!TEMPLATE_VOID_TAGS.has(tag) && src[j - 1] !== '/') {
      node.closeStart = src.length;
      node.end = src.length;
      stack.push(node);
    }
    i = j + 1;
  }
  for (let s = stack.length - 1; s > 0; s--) {
    stack[s].closeStart = src.length;
    stack[s].end = src.length;
    stack[s].closed = false;
  }
  return root;
}

/** Texto directo del nodo (sin el de sus hijos). */
function directText(src: string, node: TplNode): string {
  let out = '';
  let at = node.openEnd;
  for (const child of node.children) {
    out += src.slice(at, child.start);
    at = child.end;
  }
  return out + src.slice(at, node.closeStart);
}

function closeTagOf(src: string, node: TplNode): string {
  if (node.closed) return src.slice(node.closeStart, node.end);
  return `</${node.tag}>`;
}

function blockText(src: string, node: TplNode): string {
  const text = src.slice(node.start, node.end);
  return node.closed ? text : `${text}</${node.tag}>`;
}

/** Relleno alrededor de los hits: tope de intentos de emisión. */
const FILL_MAX_ATTEMPTS = 600;
/** Hits por término secundario. */
const SECONDARY_HITS_PER_TERM = 3;
/** Fracción máxima de `max` para bloques secundarios. */
const SECONDARY_SHARE = 0.35;
/** Niveles de relleno recursivo de esqueletos. */
const FILL_DEPTH = 2;

const FORCED_IF_ATTR = /\s\*ng(?:If|SwitchCase)\s*=\s*(?:"[^"]*"|'[^']*')/gi;
const FORCED_DEFAULT_ATTR = /\s\*ngSwitchDefault\b(?:\s*=\s*(?:"[^"]*"|'[^']*'))?/gi;

/** Apertura forzada visible: sin `*ngIf`/`*ngSwitchCase`/`*ngSwitchDefault`; `ng-template` → `<ng-container>`. */
function forcedOpen(src: string, node: TplNode): string {
  if (node.tag === 'ng-template') return '<ng-container>';
  return src.slice(node.start, node.openEnd).replace(FORCED_IF_ATTR, '').replace(FORCED_DEFAULT_ATTR, '');
}

function forcedClose(src: string, node: TplNode): string {
  return node.tag === 'ng-template' ? '</ng-container>' : closeTagOf(src, node);
}

function isInside(node: TplNode, outer: TplNode): boolean {
  for (let p: TplNode | null = node; p; p = p.parent) if (p === outer) return true;
  return false;
}

function depthOf(node: TplNode): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) d++;
  return d;
}

/** Como `blockText`, sustituyendo apertura y cierre de los nodos de `forced` del bloque por su versión forzada. */
function blockTextForced(src: string, node: TplNode, forced: Set<TplNode>): string {
  const inBlock = [...forced].filter((f) => isInside(f, node));
  if (!inBlock.length) return blockText(src, node);
  type Repl = { from: number; to: number; text: string; depth: number };
  const repl: Repl[] = [];
  for (const f of inBlock) {
    const depth = depthOf(f);
    repl.push({ from: f.start, to: f.openEnd, text: forcedOpen(src, f), depth });
    if (f === node && !node.closed) continue;
    if (f.closed) repl.push({ from: f.closeStart, to: f.end, text: forcedClose(src, f), depth });
    else repl.push({ from: f.end, to: f.end, text: forcedClose(src, f), depth });
  }
  repl.sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from) || b.depth - a.depth);
  let out = '';
  let at = node.start;
  for (const r of repl) {
    if (r.from < at) continue;
    out += src.slice(at, r.from) + r.text;
    at = r.to;
  }
  out += src.slice(at, node.end);
  if (!node.closed) out += forced.has(node) ? forcedClose(src, node) : `</${node.tag}>`;
  return out;
}

/** Ancestros de bloques y esqueletos (más los propios esqueletos). */
function keptNodes(blocks: Set<TplNode>, shells: Set<TplNode>): Set<TplNode> {
  const keep = new Set<TplNode>();
  for (const n of [...blocks, ...shells]) {
    let p = n.parent;
    while (p && !keep.has(p)) {
      keep.add(p);
      p = p.parent;
    }
  }
  for (const s of shells) keep.add(s);
  return keep;
}

/**
 * Emite los bloques completos (con los nodos de `forced` limpiados) y, de sus ancestros y esqueletos, solo las
 * etiquetas de apertura y cierre forzadas visibles.
 */
function emitTemplate(src: string, root: TplNode, blocks: Set<TplNode>, shells: Set<TplNode>, forced: Set<TplNode> = new Set()): string {
  const keep = keptNodes(blocks, shells);
  const out = (node: TplNode): string => {
    if (blocks.has(node)) return blockTextForced(src, node, forced);
    const inner = node.children.filter((c) => blocks.has(c) || keep.has(c)).map(out).join('\n');
    if (node === root) return inner;
    return `${forcedOpen(src, node)}${inner ? `\n${inner}\n` : ''}${forcedClose(src, node)}`;
  };
  return out(root);
}

/** Sin coincidencias: orden de documento; lo que cabe entero, entero; lo demás como esqueleto. */
function emitPrefix(src: string, nodes: TplNode[], budget: number): string {
  let out = '';
  for (const node of nodes) {
    const left = budget - out.length - (out ? 1 : 0);
    if (left <= 0) break;
    const whole = blockText(src, node);
    if (whole.length <= left) {
      out += (out ? '\n' : '') + whole;
      continue;
    }
    const open = src.slice(node.start, node.openEnd);
    const close = closeTagOf(src, node);
    if (open.length + close.length + 2 > left) break;
    const inner = emitPrefix(src, node.children, left - open.length - close.length - 2);
    out += (out ? '\n' : '') + `${open}\n${inner}\n${close}`;
    break;
  }
  return out;
}

/**
 * Recorta una plantilla grande a la región de los términos (métodos/propiedades de los pasos): bloques completos
 * (≤ `blockMax`) que los contienen y, de sus ancestros, solo apertura y cierre. Siempre por elementos completos y
 * ≤ `max`. Si `html` ya cabe, se devuelve igual.
 */
export function trimTemplateForAi(
  html: string,
  terms: string[],
  max: number,
  blockMax: number,
  secondary: string[] = [],
): { html: string; trimmed: boolean } {
  const source = String(html ?? '');
  if (source.length <= max) return { html: source, trimmed: false };
  try {
    const src = source.replace(/<!--[\s\S]*?-->/g, '');
    const root = scanTemplate(src);
    const all: TplNode[] = [];
    const collect = (n: TplNode): void => {
      for (const c of n.children) {
        all.push(c);
        collect(c);
      }
    };
    collect(root);
    const uniqueTerms = [...new Set(terms.filter((t) => !!t))];
    const secTerms = [...new Set((secondary ?? []).filter((t) => !!t && !uniqueTerms.includes(t)))];
    const toReg = (t: string): RegExp => new RegExp(`(?<![\\w$])${escapeRegExp(t)}(?![\\w$])`);
    const regs = uniqueTerms.map(toReg);
    const secRegs = secTerms.map(toReg);
    const hitsByTerm: TplNode[][] = uniqueTerms.map(() => []);
    const secHitsByTerm: TplNode[][] = secTerms.map(() => []);
    if (regs.length || secRegs.length) {
      for (const node of all) {
        const probe = src.slice(node.start, node.openEnd) + directText(src, node);
        regs.forEach((re, ti) => {
          if (re.test(probe)) hitsByTerm[ti].push(node);
        });
        secRegs.forEach((re, ti) => {
          if (re.test(probe)) secHitsByTerm[ti].push(node);
        });
      }
    }
    const blocks = new Set<TplNode>();
    const shells = new Set<TplNode>();
    /** Hits primarios/callers aceptados: ellos y sus ancestros dentro de un bloque se emiten forzados visibles. */
    const forcedHits = new Set<TplNode>();
    const forced = new Set<TplNode>();
    const anchors: TplNode[] = [];
    const covered = (node: TplNode): boolean => {
      for (let p: TplNode | null = node; p; p = p.parent) if (blocks.has(p)) return true;
      return false;
    };
    const emit = (): string => {
      forced.clear();
      for (const hit of forcedHits) {
        if (!covered(hit)) continue;
        for (let p: TplNode | null = hit; p && p !== root; p = p.parent) {
          forced.add(p);
          if (blocks.has(p)) break;
        }
      }
      return emitTemplate(src, root, blocks, shells, forced);
    };
    const addAnchor = (node: TplNode): void => {
      if (!anchors.includes(node)) anchors.push(node);
    };
    const climb = (hit: TplNode): TplNode => {
      let best = hit;
      for (let p = hit.parent; p && p !== root && p.end - p.start <= blockMax; p = p.parent) best = p;
      return best;
    };

    // 1) Primarios + callers.
    let tried = 0;
    for (const hits of hitsByTerm) {
      for (const hit of hits) {
        if (++tried > 400) break;
        if (covered(hit)) {
          if (!forcedHits.has(hit)) {
            forcedHits.add(hit);
            if (emit().length > max) forcedHits.delete(hit);
          }
          continue;
        }
        const newHit = !forcedHits.has(hit);
        if (hit.end - hit.start <= blockMax) {
          const best = climb(hit);
          const removed = [...blocks].filter((b) => isInside(b, best));
          for (const b of removed) blocks.delete(b);
          blocks.add(best);
          forcedHits.add(hit);
          if (emit().length <= max) {
            addAnchor(best);
            continue;
          }
          blocks.delete(best);
          for (const b of removed) blocks.add(b);
          if (newHit) forcedHits.delete(hit);
        }
        if (!shells.has(hit)) {
          shells.add(hit);
          forcedHits.add(hit);
          if (emit().length > max) {
            shells.delete(hit);
            if (newHit) forcedHits.delete(hit);
          } else {
            addAnchor(hit);
          }
        }
      }
    }

    // 2) Secundarios: solo bloques completos, sin forzar, con cuota de `max`.
    let curLen = blocks.size || shells.size ? emit().length : 0;
    let secAdded = 0;
    let triedSec = 0;
    for (const hits of secHitsByTerm) {
      let accepted = 0;
      for (const hit of hits) {
        if (++triedSec > 400 || accepted >= SECONDARY_HITS_PER_TERM) break;
        if (covered(hit) || hit.end - hit.start > blockMax) continue;
        const best = climb(hit);
        const removed = [...blocks].filter((b) => isInside(b, best));
        for (const b of removed) blocks.delete(b);
        blocks.add(best);
        const len = emit().length;
        const delta = len - curLen;
        if (len <= max && secAdded + delta <= max * SECONDARY_SHARE) {
          secAdded += Math.max(0, delta);
          curLen = len;
          accepted++;
          continue;
        }
        blocks.delete(best);
        for (const b of removed) blocks.add(b);
      }
    }

    // 3) Relleno round-robin por nivel alrededor de los anchors, luego esqueletos recursivos.
    if (anchors.length) {
      curLen = emit().length;
      let attempts = 0;
      const fillShells: { node: TplNode; depth: number }[] = [];
      const exhausted = (): boolean => attempts >= FILL_MAX_ATTEMPTS || max - curLen <= 0;
      const tryAdd = (s: TplNode, depth: number): void => {
        if (exhausted()) return;
        const left = max - curLen;
        const whole = blockText(src, s);
        if (whole.length <= blockMax && whole.length + 1 <= left) {
          attempts++;
          blocks.add(s);
          const len = emit().length;
          if (len <= max) {
            curLen = len;
            return;
          }
          blocks.delete(s);
        }
        if (exhausted()) return;
        const shellCost = forcedOpen(src, s).length + forcedClose(src, s).length + 1;
        if (shellCost > left) return;
        attempts++;
        shells.add(s);
        const len = emit().length;
        if (len <= max) {
          curLen = len;
          fillShells.push({ node: s, depth });
          return;
        }
        shells.delete(s);
      };
      const levels = anchors.map((a) => {
        const list: TplNode[] = shells.has(a) ? [a] : [];
        for (let p = a.parent; p; p = p.parent) list.push(p);
        return list;
      });
      const seen = new Set<TplNode>();
      const maxLevels = Math.max(0, ...levels.map((l) => l.length));
      for (let k = 0; k < maxLevels && !exhausted(); k++) {
        for (const list of levels) {
          if (exhausted()) break;
          const p = list[k];
          if (!p || seen.has(p)) continue;
          seen.add(p);
          if (covered(p)) continue;
          const keep = keptNodes(blocks, shells);
          const emitted = (c: TplNode): boolean => blocks.has(c) || shells.has(c) || keep.has(c);
          const kids = p.children;
          const marks: number[] = [];
          kids.forEach((c, i) => {
            if (emitted(c)) marks.push(i);
          });
          const cands = kids
            .map((c, i) => ({ c, i, d: marks.length ? Math.min(...marks.map((m) => Math.abs(m - i))) : i }))
            .filter((x) => !emitted(x.c))
            .sort((a, b) => a.d - b.d || a.i - b.i);
          for (const x of cands) {
            if (exhausted()) break;
            tryAdd(x.c, 1);
          }
        }
      }
      for (let q = 0; q < fillShells.length && !exhausted() && max - curLen > 200; q++) {
        const { node, depth } = fillShells[q];
        if (depth > FILL_DEPTH || covered(node)) continue;
        const keep = keptNodes(blocks, shells);
        for (const c of node.children) {
          if (exhausted() || max - curLen <= 200) break;
          if (blocks.has(c) || shells.has(c) || keep.has(c)) continue;
          tryAdd(c, depth + 1);
        }
      }
    }

    let out = blocks.size || shells.size ? emit() : '';
    if (!out.trim()) out = emitPrefix(src, root.children, max);
    if (!out.trim() || out.length > max) out = htmlPrefix(src, max);
    return { html: out, trimmed: true };
  } catch (error: unknown) {
    console.warn('[Traza] No se pudo recortar la plantilla.', error instanceof Error ? error.name : '');
    return { html: htmlPrefix(source, max), trimmed: true };
  }
}

const CLASS_OPEN = /\bclass\s+[A-Za-z_$][\w$]*[^{]*\{/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return']);

/** Índice de la `{` del cuerpo tras `)` (salta el tipo de retorno); `-1` si antes hay `;` o `=>`. */
function methodBodyStart(ts: string, from: number): number {
  let depth = 0;
  let j = from;
  while (j < ts.length) {
    const c = ts[j];
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(ts, j);
      continue;
    }
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || (c === '>' && ts[j - 1] !== '=')) depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ';') return -1;
    else if (depth === 0 && c === '=' && ts[j + 1] === '>') return -1;
    else if (c === '{') {
      const prev = ts.slice(from, j).replace(/\s+$/, '');
      const last = prev[prev.length - 1];
      // `{` en posición de tipo (`: { a: T }`, `| {`, `<{`…): se salta.
      if (depth > 0 || (last && ':|&<,(['.includes(last))) {
        const g = balanced(ts, j, '{', '}');
        if (!g) return -1;
        j = g.end;
        continue;
      }
      return j;
    }
    j++;
  }
  return -1;
}

/** Métodos (incl. getters/setters y constructor) de la primera clase del TS ya limpio (`stripTsForAi`). */
export function tsMethods(ts: string): { name: string; start: number; end: number }[] {
  const src = String(ts ?? '');
  const out: { name: string; start: number; end: number }[] = [];
  const cls = CLASS_OPEN.exec(src);
  if (!cls) return out;
  const open = cls.index + cls[0].length - 1;
  const body = balanced(src, open, '{', '}');
  const classEnd = body ? body.end - 1 : src.length;
  const re = /^[ \t]*(?:(?:public|private|protected|static|async|override)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/gm;
  re.lastIndex = open + 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index >= classEnd) break;
    const name = m[1];
    const parenAt = m.index + m[0].length - 1;
    if (NOT_METHOD.has(name)) {
      re.lastIndex = parenAt + 1;
      continue;
    }
    const params = balanced(src, parenAt, '(', ')');
    if (!params) {
      re.lastIndex = parenAt + 1;
      continue;
    }
    const braceAt = methodBodyStart(src, params.end);
    if (braceAt < 0 || braceAt >= classEnd) {
      re.lastIndex = params.end;
      continue;
    }
    const block = balanced(src, braceAt, '{', '}');
    if (!block) {
      re.lastIndex = braceAt + 1;
      continue;
    }
    out.push({ name, start: m.index, end: block.end });
    re.lastIndex = block.end;
  }
  return out;
}

/**
 * TS enfocado para la IA: cabecera de la clase (≤ `max/4`), métodos de `keep` por prioridad (≤ ~70 % de `max`) y
 * declaraciones de campo (primero las de `fieldHints`). Resultado ≤ `max`.
 */
export function focusTsForAi(
  ts: string,
  methods: { name: string; start: number; end: number }[],
  keep: string[],
  fieldHints: Set<string>,
  max: number,
): string {
  const src = String(ts ?? '');
  const cls = CLASS_OPEN.exec(src);
  if (!cls) return src.slice(0, max);
  const bodyStart = cls.index + cls[0].length;
  const headMax = Math.floor(max / 4);
  let header = src.slice(0, bodyStart);
  if (header.length > headMax) {
    const decl = cls[0].slice(0, Math.max(0, headMax - 8));
    header = `${src.slice(0, Math.max(0, headMax - decl.length - 6))}\n…\n${decl}`.slice(0, headMax);
  }
  const closing = '\n}';
  let total = header.length + closing.length;
  const methodBudget = Math.floor(max * 0.7);
  const chosen: string[] = [];
  const picked = new Set<number>();
  for (const name of [...new Set(keep)]) {
    methods.forEach((m, idx) => {
      if (m.name !== name || picked.has(idx)) return;
      const text = src.slice(m.start, m.end);
      if (total + text.length + 2 > methodBudget) return;
      picked.add(idx);
      chosen.push(text);
      total += text.length + 2;
    });
  }
  // Campos: líneas de declaración en los huecos entre métodos.
  const fieldRe = /^\s*(?:@\w+\([^)]*\)\s*)?(?:(?:public|private|protected|readonly|static|override|declare)\s+)*([A-Za-z_$][\w$]*)[!?]?\s*[:=]/;
  const sorted = [...methods].sort((a, b) => a.start - b.start);
  const gaps: [number, number][] = [];
  let at = bodyStart;
  for (const m of sorted) {
    if (m.start > at) gaps.push([at, m.start]);
    at = Math.max(at, m.end);
  }
  gaps.push([at, src.length]);
  const hinted: string[] = [];
  const rest: string[] = [];
  for (const [a, b] of gaps) {
    for (const line of src.slice(a, b).split('\n')) {
      const fm = fieldRe.exec(line);
      if (!fm || NOT_METHOD.has(fm[1])) continue;
      const text = line.length > 400 ? line.slice(0, 400) : line;
      (fieldHints.has(fm[1]) ? hinted : rest).push(text);
    }
  }
  const fields: string[] = [];
  for (const line of [...hinted, ...rest]) {
    if (total + line.length + 1 > max) continue;
    fields.push(line);
    total += line.length + 1;
  }
  const out = `${header}\n${chosen.join('\n\n')}${fields.length ? `\n${fields.join('\n')}` : ''}${closing}`;
  return out.length <= max ? out : out.slice(0, max);
}
