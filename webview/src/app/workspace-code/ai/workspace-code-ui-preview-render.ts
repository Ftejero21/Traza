/**
 * Vista de pantalla (Nexo IA, fase 2.2): funciones puras, sin Angular. A partir de un `UiPreviewPlan` (plan compacto
 * que devuelve la IA, nunca HTML/CSS) se resuelve la plantilla Angular real del proyecto de forma mínima y SIN
 * ejecutarla (evaluador propio limitado, sin `eval`/`Function`), se emula la encapsulación de estilos de Angular, se
 * marca el elemento afectado, se sanea el DOM y el CSS y se construye el `srcdoc` de un iframe con `sandbox=""` y CSP
 * estricta.
 */
import { DiffLine, DiffLineKind, FileChange } from './nexo-ia.changes.types';
import { UiPreviewPlan, UiPreviewState } from './nexo-ia.types';

export type UiPreviewVariant = 'now' | 'after';
export type UiPreviewTone = 'amber' | 'red' | 'green';

/* ============================================================
 *  Diff
 * ============================================================ */

/** Cambio inverso (para reconstruir el contenido anterior de una propuesta ya aplicada). */
export function reverseFileChange(change: FileChange): FileChange {
  const swap = (k: DiffLineKind): DiffLineKind => (k === 'add' ? 'del' : k === 'del' ? 'add' : 'context');
  return {
    ...change,
    status: change.status === 'added' ? 'deleted' : change.status === 'deleted' ? 'added' : 'modified',
    additions: change.deletions,
    deletions: change.additions,
    hunks: change.hunks.map((h) => ({
      ...h,
      oldStart: h.newStart,
      newStart: h.oldStart,
      lines: h.lines.map((l): DiffLine => ({ kind: swap(l.kind), text: l.text, oldLine: l.newLine, newLine: l.oldLine })),
    })),
  };
}

/* ============================================================
 *  Evaluador seguro de expresiones Angular
 * ============================================================ */

const UNRESOLVED: unique symbol = Symbol('nx-unresolved');
type Value = unknown;

function hasOwn(o: unknown, key: string): boolean {
  return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, key);
}

function normalizeExpr(expr: string): string {
  return String(expr ?? '').trim().replace(/\s+/g, ' ');
}

function truthy(v: Value): boolean {
  return !!v;
}

/** Divide por `sep` en el nivel superior (fuera de comillas, paréntesis, corchetes y llaves). */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === sep) {
      if (sep === '|' && (text[i + 1] === '|' || text[i - 1] === '|')) continue;
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

interface Tok { t: 'num' | 'str' | 'id' | 'op'; v: string; s: number; e: number }

const OPS = ['===', '!==', '?.', '??', '==', '!=', '<=', '>=', '&&', '||', '!', '<', '>', '?', ':', '.', '(', ')', '[', ']', ',', '{', '}', '-', '+'];

function tokenize(src: string): Tok[] | null {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      const v = m ? m[0] : c;
      toks.push({ t: 'id', v, s: i, e: i + v.length });
      i += v.length;
      continue;
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i));
      const v = m ? m[0] : c;
      toks.push({ t: 'num', v, s: i, e: i + v.length });
      i += v.length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') return null;
        value += src[j++];
      }
      if (j >= src.length) return null;
      toks.push({ t: 'str', v: value, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) return null;
    // `?.` seguido de un dígito es un ternario con un número decimal.
    if (op === '?.' && /\d/.test(src[i + 2] ?? '')) {
      toks.push({ t: 'op', v: '?', s: i, e: i + 1 });
      i += 1;
      continue;
    }
    toks.push({ t: 'op', v: op, s: i, e: i + op.length });
    i += op.length;
  }
  return toks;
}

type Locals = Map<string, Value>;

class ExprParser {
  private i = 0;

  constructor(private toks: Tok[], private src: string, private locals: Locals, private bindings: Record<string, unknown>) {}

  parse(): Value {
    const v = this.ternary();
    if (this.i !== this.toks.length) throw new Error('trailing');
    return v;
  }

  private peek(v?: string): Tok | null {
    const t = this.toks[this.i] ?? null;
    if (!t) return null;
    if (v !== undefined && !(t.t === 'op' && t.v === v)) return null;
    return t;
  }

  private eat(v: string): boolean {
    if (this.peek(v)) {
      this.i++;
      return true;
    }
    return false;
  }

  private expect(v: string): Tok {
    const t = this.peek(v);
    if (!t) throw new Error(`expected ${v}`);
    this.i++;
    return t;
  }

  private ternary(): Value {
    const cond = this.nullish();
    if (this.eat('?')) {
      const a = this.ternary();
      this.expect(':');
      const b = this.ternary();
      if (cond === UNRESOLVED) return UNRESOLVED;
      return truthy(cond) ? a : b;
    }
    return cond;
  }

  private nullish(): Value {
    let l = this.or();
    while (this.eat('??')) {
      const r = this.or();
      if (l === UNRESOLVED) continue;
      l = l === null || l === undefined ? r : l;
    }
    return l;
  }

  private or(): Value {
    let l = this.and();
    while (this.eat('||')) {
      const r = this.and();
      if (l !== UNRESOLVED && truthy(l)) continue;
      if (l === UNRESOLVED) l = r !== UNRESOLVED && truthy(r) ? r : UNRESOLVED;
      else l = r;
    }
    return l;
  }

  private and(): Value {
    let l = this.equality();
    while (this.eat('&&')) {
      const r = this.equality();
      if (l !== UNRESOLVED && !truthy(l)) continue;
      if (l === UNRESOLVED) l = r !== UNRESOLVED && !truthy(r) ? r : UNRESOLVED;
      else l = r;
    }
    return l;
  }

  private equality(): Value {
    let l = this.relational();
    for (;;) {
      const t = this.peek('===') ?? this.peek('!==') ?? this.peek('==') ?? this.peek('!=');
      if (!t) return l;
      this.i++;
      const r = this.relational();
      if (l === UNRESOLVED || r === UNRESOLVED) {
        l = UNRESOLVED;
        continue;
      }
      if (t.v === '===') l = l === r;
      else if (t.v === '!==') l = l !== r;
      else if (t.v === '==') l = looseEqual(l, r);
      else l = !looseEqual(l, r);
    }
  }

  private relational(): Value {
    let l = this.additive();
    for (;;) {
      const t = this.peek('<=') ?? this.peek('>=') ?? this.peek('<') ?? this.peek('>');
      if (!t) return l;
      this.i++;
      const r = this.additive();
      if (l === UNRESOLVED || r === UNRESOLVED) {
        l = UNRESOLVED;
        continue;
      }
      const both = typeof l === 'string' && typeof r === 'string';
      const a = both ? (l as string) : Number(l);
      const b = both ? (r as string) : Number(r);
      l = t.v === '<' ? a < b : t.v === '>' ? a > b : t.v === '<=' ? a <= b : a >= b;
    }
  }

  private additive(): Value {
    let l = this.unary();
    for (;;) {
      const t = this.peek('+') ?? this.peek('-');
      if (!t) return l;
      this.i++;
      const r = this.unary();
      if (l === UNRESOLVED || r === UNRESOLVED) {
        l = UNRESOLVED;
        continue;
      }
      if (t.v === '+') {
        if (typeof l === 'number' && typeof r === 'number') l = l + r;
        else if (typeof l === 'string' || typeof r === 'string') l = `${toText(l)}${toText(r)}`;
        else l = UNRESOLVED;
      } else {
        l = typeof l === 'number' && typeof r === 'number' ? l - r : UNRESOLVED;
      }
    }
  }

  private unary(): Value {
    if (this.eat('!')) {
      const v = this.unary();
      return v === UNRESOLVED ? UNRESOLVED : !truthy(v);
    }
    if (this.eat('-')) {
      const v = this.unary();
      return typeof v === 'number' ? -v : UNRESOLVED;
    }
    if (this.eat('+')) {
      const v = this.unary();
      return v === UNRESOLVED ? UNRESOLVED : Number(v);
    }
    return this.postfix();
  }

  private textFrom(start: number, end: number): string {
    return normalizeExpr(this.src.slice(start, end));
  }

  private postfix(): Value {
    const startTok = this.toks[this.i];
    if (!startTok) throw new Error('eof');
    const start = startTok.s;
    // `$any(x)` → x.
    if (startTok.t === 'id' && startTok.v === '$any' && this.toks[this.i + 1]?.v === '(') {
      this.i += 2;
      const inner = this.ternary();
      this.expect(')');
      return inner;
    }
    let v = this.primary();
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'op') return v;
      if (t.v === '.' || t.v === '?.') {
        this.i++;
        const name = this.toks[this.i];
        if (!name || name.t !== 'id') throw new Error('member');
        this.i++;
        const key = this.textFrom(start, name.e);
        if (hasOwn(this.bindings, key)) v = this.bindings[key];
        else v = member(v, name.v);
      } else if (t.v === '[') {
        this.i++;
        const k = this.ternary();
        const close = this.expect(']');
        const key = this.textFrom(start, close.e);
        if (hasOwn(this.bindings, key)) v = this.bindings[key];
        else if (v === UNRESOLVED || k === UNRESOLVED) v = UNRESOLVED;
        else v = member(v, typeof k === 'number' ? String(k) : String(k));
      } else if (t.v === '!') {
        // Aserción de no nulo (`a!.b`).
        this.i++;
      } else if (t.v === '(') {
        this.i++;
        if (!this.peek(')')) {
          do this.ternary(); while (this.eat(','));
        }
        const close = this.expect(')');
        const key = this.textFrom(start, close.e);
        v = hasOwn(this.bindings, key) ? this.bindings[key] : UNRESOLVED;
      } else {
        return v;
      }
    }
  }

  private primary(): Value {
    const t = this.toks[this.i++];
    if (!t) throw new Error('eof');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (t.v === 'undefined') return undefined;
      if (t.v === 'this') return this.bindings;
      if (this.locals.has(t.v)) return this.locals.get(t.v);
      if (hasOwn(this.bindings, t.v)) return this.bindings[t.v];
      return UNRESOLVED;
    }
    if (t.v === '(') {
      const v = this.ternary();
      this.expect(')');
      return v;
    }
    if (t.v === '[') {
      const out: Value[] = [];
      if (!this.peek(']')) {
        do out.push(this.ternary()); while (this.eat(','));
      }
      this.expect(']');
      return out;
    }
    if (t.v === '{') {
      const out: Record<string, Value> = {};
      if (!this.peek('}')) {
        do {
          const k = this.toks[this.i++];
          if (!k || (k.t !== 'id' && k.t !== 'str' && k.t !== 'num')) throw new Error('key');
          this.expect(':');
          const value = this.ternary();
          if (k.v !== '__proto__') out[k.v] = value;
        } while (this.eat(','));
      }
      this.expect('}');
      return out;
    }
    throw new Error('primary');
  }
}

function looseEqual(a: Value, b: Value): boolean {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  if (typeof a === typeof b) return a === b;
  if ((typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'string' || typeof b === 'boolean')) {
    return Number(a) === Number(b);
  }
  return false;
}

function member(v: Value, name: string): Value {
  if (v === UNRESOLVED) return UNRESOLVED;
  if (v === null || v === undefined) return undefined;
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') return UNRESOLVED;
  if (name === 'length' && (Array.isArray(v) || typeof v === 'string')) return v.length;
  if (typeof v === 'object') return hasOwn(v, name) ? (v as Record<string, unknown>)[name] : undefined;
  return UNRESOLVED;
}

function toText(v: Value): string {
  if (v === null || v === undefined || v === UNRESOLVED) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(toText).join(',');
  return String(v);
}

function applyPipe(v: Value, pipe: string): Value {
  const name = pipe.split(':')[0].trim();
  if (v === UNRESOLVED) return v;
  if (name === 'uppercase') return toText(v).toUpperCase();
  if (name === 'lowercase') return toText(v).toLowerCase();
  if (name === 'titlecase') return toText(v).replace(/\b\w/g, (c) => c.toUpperCase());
  if (name === 'json') {
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  }
  return v;
}

/* ============================================================
 *  Resolución de la plantilla
 * ============================================================ */

export interface ResolveTemplateContext {
  bindings?: Record<string, unknown>;
  state: UiPreviewState;
  markSelector: string;
  variant: UiPreviewVariant;
}

interface Run {
  doc: Document;
  bindings: Record<string, unknown>;
  state: UiPreviewState;
  markSelector: string;
  exprs: string[];
  approximate: boolean;
}

/** Valor de una expresión de plantilla (bindings exactos primero, después evaluador limitado). */
function evaluate(expr: string, locals: Locals, run: Run): Value {
  const norm = normalizeExpr(expr);
  if (!norm) return UNRESOLVED;
  const parts = splitTop(norm, '|').map((p) => p.trim());
  const base = parts[0];
  const pipes = parts.slice(1);
  let value: Value;
  if (hasOwn(run.bindings, base)) value = run.bindings[base];
  else if (pipes.length && hasOwn(run.bindings, norm)) return run.bindings[norm];
  else {
    const toks = tokenize(base);
    if (!toks || !toks.length) return UNRESOLVED;
    try {
      value = new ExprParser(toks, base, locals, run.bindings).parse();
    } catch {
      return UNRESOLVED;
    }
  }
  for (const pipe of pipes) value = applyPipe(value, pipe);
  return value;
}

function evalOrFlag(expr: string, locals: Locals, run: Run): { ok: boolean; value: Value } {
  const value = evaluate(expr, locals, run);
  if (value === UNRESOLVED) {
    run.approximate = true;
    return { ok: false, value: undefined };
  }
  return { ok: true, value };
}

function interpolate(text: string, locals: Locals, run: Run): string {
  return text.replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr: string) => {
    const r = evalOrFlag(expr, locals, run);
    return r.ok ? toText(r.value) : '';
  });
}

/* ---------- control de flujo (@if, @for, @switch, @defer) → marcadores <template> ---------- */

function skipWs(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function readGroup(src: string, i: number, open: string, close: string): { inner: string; end: number } | null {
  if (src[i] !== open) return null;
  let depth = 0;
  let quote: string | null = null;
  const quoted = open === '(';
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (quoted && (c === '"' || c === "'")) quote = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: src.slice(i + 1, j), end: j + 1 };
    }
  }
  return null;
}

function pushExpr(exprs: string[], expr: string): number {
  exprs.push(expr);
  return exprs.length - 1;
}

function convertControlFlow(src: string, exprs: string[]): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const at = src.indexOf('@', i);
    if (at < 0) {
      out += src.slice(i);
      break;
    }
    out += src.slice(i, at);
    const prev = at > 0 ? src[at - 1] : '';
    const m = /^@(if|for|switch|defer)\b/.exec(src.slice(at, at + 8));
    const parsed = m && !/[\w.]/.test(prev) ? parseBlockAt(src, at, m[1], exprs) : null;
    if (!parsed) {
      out += '@';
      i = at + 1;
      continue;
    }
    out += parsed.html;
    i = parsed.end;
  }
  return out;
}

function parseBlockAt(src: string, at: number, kw: string, exprs: string[]): { html: string; end: number } | null {
  let i = skipWs(src, at + 1 + kw.length);
  let param: string | null = null;
  if (src[i] === '(') {
    const g = readGroup(src, i, '(', ')');
    if (!g) return null;
    param = g.inner;
    i = skipWs(src, g.end);
  }
  const body = readGroup(src, i, '{', '}');
  if (!body) return null;
  i = body.end;

  if (kw === 'if') {
    if (param === null) return null;
    const branches: { expr: string | null; body: string }[] = [{ expr: param, body: body.inner }];
    for (;;) {
      const j = skipWs(src, i);
      if (!src.startsWith('@else', j)) break;
      let k = skipWs(src, j + 5);
      if (src.startsWith('if', k) && /[\s(]/.test(src[k + 2] ?? '')) {
        k = skipWs(src, k + 2);
        const p = readGroup(src, k, '(', ')');
        if (!p) break;
        const b = readGroup(src, skipWs(src, p.end), '{', '}');
        if (!b) break;
        branches.push({ expr: p.inner, body: b.inner });
        i = b.end;
      } else {
        const b = readGroup(src, k, '{', '}');
        if (!b) break;
        branches.push({ expr: null, body: b.inner });
        i = b.end;
        break;
      }
    }
    const html = branches
      .map((b) => `<template data-nx-when="${b.expr === null ? '' : pushExpr(exprs, b.expr)}">${convertControlFlow(b.body, exprs)}</template>`)
      .join('');
    return { html: `<template data-nx-chain="">${html}</template>`, end: i };
  }

  if (kw === 'for') {
    if (param === null) return null;
    let empty = '';
    const j = skipWs(src, i);
    if (src.startsWith('@empty', j)) {
      const b = readGroup(src, skipWs(src, j + 6), '{', '}');
      if (b) {
        empty = b.inner;
        i = b.end;
      }
    }
    const idx = pushExpr(exprs, param);
    return {
      html: `<template data-nx-for="${idx}"><template data-nx-part="body">${convertControlFlow(body.inner, exprs)}</template>`
        + `<template data-nx-part="empty">${convertControlFlow(empty, exprs)}</template></template>`,
      end: i,
    };
  }

  if (kw === 'switch') {
    if (param === null) return null;
    const inner = body.inner;
    let cases = '';
    let k = 0;
    while (k < inner.length) {
      k = skipWs(inner, k);
      if (inner.startsWith('@case', k)) {
        const p = readGroup(inner, skipWs(inner, k + 5), '(', ')');
        const b = p ? readGroup(inner, skipWs(inner, p.end), '{', '}') : null;
        if (!p || !b) break;
        cases += `<template data-nx-case="${pushExpr(exprs, p.inner)}">${convertControlFlow(b.inner, exprs)}</template>`;
        k = b.end;
      } else if (inner.startsWith('@default', k)) {
        const b = readGroup(inner, skipWs(inner, k + 8), '{', '}');
        if (!b) break;
        cases += `<template data-nx-case="">${convertControlFlow(b.inner, exprs)}</template>`;
        k = b.end;
      } else {
        k++;
      }
    }
    return { html: `<template data-nx-switch="${pushExpr(exprs, param)}">${cases}</template>`, end: i };
  }

  // @defer: solo el contenido principal; se descartan @placeholder/@loading/@error.
  for (;;) {
    const j = skipWs(src, i);
    const sub = /^@(placeholder|loading|error)\b/.exec(src.slice(j, j + 13));
    if (!sub) break;
    let k = skipWs(src, j + sub[0].length);
    if (src[k] === '(') {
      const p = readGroup(src, k, '(', ')');
      if (!p) break;
      k = skipWs(src, p.end);
    }
    const b = readGroup(src, k, '{', '}');
    if (!b) break;
    i = b.end;
  }
  return { html: convertControlFlow(body.inner, exprs), end: i };
}

/* ---------- DOM ---------- */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const BOOL_PROPS = new Set(['disabled', 'hidden', 'checked', 'readonly', 'required', 'selected']);
const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;

/** `<app-x />` → `<app-x></app-x>` (el parser HTML no cierra los elementos no vacíos autocerrados). */
function expandSelfClosing(html: string): string {
  return html.replace(/<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g, (m, tag: string, attrs: string) =>
    VOID_TAGS.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`);
}

function matchesSafe(el: Element | null, selector: string): boolean {
  if (!el || !selector) return false;
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

function withLocal(locals: Locals, entries: [string, Value][]): Locals {
  const next = new Map(locals);
  for (const [k, v] of entries) next.set(k, v);
  return next;
}

/** `expr as alias` / `expr; as alias` → partes. */
function splitAlias(expr: string): { expr: string; alias: string | null } {
  const parts = splitTop(expr, ';');
  let main = parts[0];
  let alias: string | null = null;
  const inline = /\s+as\s+([\w$]+)\s*$/.exec(main);
  if (inline) {
    alias = inline[1];
    main = main.slice(0, inline.index);
  }
  for (const p of parts.slice(1)) {
    const m = /^\s*as\s+([\w$]+)\s*$/.exec(p);
    if (m) alias = m[1];
  }
  return { expr: main, alias };
}

interface ForSpec { alias: string; of: string; lets: [string, string][] }

/** `let x of xs; let i = index; trackBy: f` (ngFor) o `x of xs; track x.id; let i = $index` (@for). */
function parseForSpec(spec: string): ForSpec | null {
  const parts = splitTop(spec, ';');
  const head = /^\s*(?:let\s+)?([\w$]+)\s+of\s+([\s\S]+)$/.exec(parts[0]);
  if (!head) return null;
  const lets: [string, string][] = [];
  for (const p of parts.slice(1)) {
    for (const seg of splitTop(p, ',')) {
      const a = /^\s*(?:let\s+)?([\w$]+)\s*=\s*\$?([\w$]+)\s*$/.exec(seg);
      if (a) {
        lets.push([a[1], a[2].replace(/^\$/, '')]);
        continue;
      }
      const b = /^\s*\$?([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(seg);
      if (b) lets.push([b[2], b[1].replace(/^\$/, '')]);
    }
  }
  return { alias: head[1], of: head[2].trim(), lets };
}

function forLocals(locals: Locals, spec: ForSpec, item: Value, index: number, count: number): Locals {
  const ctx: Record<string, Value> = {
    index, first: index === 0, last: index === count - 1, even: index % 2 === 0, odd: index % 2 === 1, count,
  };
  const entries: [string, Value][] = [[spec.alias, item], ['$index', index], ['$first', ctx['first']], ['$last', ctx['last']], ['$count', count]];
  for (const [name, src] of spec.lets) entries.push([name, hasOwn(ctx, src) ? ctx[src] : UNRESOLVED]);
  return withLocal(locals, entries);
}

function insertFragment(run: Run, frag: DocumentFragment, before: Node, locals: Locals): void {
  const parent = before.parentNode;
  if (!parent) return;
  const imported = run.doc.importNode(frag, true);
  const nodes = Array.from(imported.childNodes);
  parent.insertBefore(imported, before);
  for (const n of nodes) processNode(n, locals, run);
}

function childTemplates(tpl: HTMLTemplateElement): HTMLTemplateElement[] {
  return Array.from(tpl.content.children).filter((c): c is HTMLTemplateElement => c.localName === 'template');
}

function processMarker(tpl: HTMLTemplateElement, locals: Locals, run: Run): void {
  if (tpl.hasAttribute('data-nx-chain')) {
    for (const branch of childTemplates(tpl)) {
      const raw = branch.getAttribute('data-nx-when') ?? '';
      if (raw === '') {
        insertFragment(run, branch.content, tpl, locals);
        break;
      }
      const { expr, alias } = splitAlias(run.exprs[Number(raw)] ?? '');
      const r = evalOrFlag(expr, locals, run);
      if (r.ok && truthy(r.value)) {
        insertFragment(run, branch.content, tpl, alias ? withLocal(locals, [[alias, r.value]]) : locals);
        break;
      }
    }
  } else if (tpl.hasAttribute('data-nx-for')) {
    const spec = parseForSpec(run.exprs[Number(tpl.getAttribute('data-nx-for'))] ?? '');
    const parts = childTemplates(tpl);
    const body = parts.find((p) => p.getAttribute('data-nx-part') === 'body');
    const empty = parts.find((p) => p.getAttribute('data-nx-part') === 'empty');
    if (spec && body) {
      const r = evalOrFlag(spec.of, locals, run);
      if (r.ok && Array.isArray(r.value)) {
        const items = r.value;
        if (!items.length && empty) insertFragment(run, empty.content, tpl, locals);
        items.slice(0, 3).forEach((item, k) => insertFragment(run, body.content, tpl, forLocals(locals, spec, item, k, items.length)));
      } else {
        run.approximate = true;
        insertFragment(run, body.content, tpl, forLocals(locals, spec, UNRESOLVED, 0, 1));
      }
    }
  } else if (tpl.hasAttribute('data-nx-switch')) {
    const value = evalOrFlag(run.exprs[Number(tpl.getAttribute('data-nx-switch'))] ?? '', locals, run);
    let chosen: HTMLTemplateElement | null = null;
    let fallback: HTMLTemplateElement | null = null;
    for (const c of childTemplates(tpl)) {
      const raw = c.getAttribute('data-nx-case') ?? '';
      if (raw === '') {
        fallback = fallback ?? c;
        continue;
      }
      const r = evalOrFlag(run.exprs[Number(raw)] ?? '', locals, run);
      if (value.ok && r.ok && r.value === value.value) {
        chosen = c;
        break;
      }
    }
    const pick = chosen ?? fallback;
    if (pick) insertFragment(run, pick.content, tpl, locals);
  }
  tpl.remove();
}

function findNgTemplate(run: Run, name: string): Element | null {
  const key = `#${name.toLowerCase()}`;
  return Array.from(run.doc.getElementsByTagName('ng-template')).find((t) => t.hasAttribute(key)) ?? null;
}

function insertNgTemplate(run: Run, tpl: Element, before: Node, locals: Locals): void {
  const parent = before.parentNode;
  if (!parent) return;
  const nodes = Array.from(tpl.childNodes).map((n) => n.cloneNode(true));
  for (const n of nodes) parent.insertBefore(n, before);
  for (const n of nodes) processNode(n, locals, run);
}

/** `*ngIf`: devuelve los locales con el alias, o `null` si el elemento se quitó. */
function applyNgIf(el: Element, locals: Locals, run: Run): Locals | null {
  const spec = el.getAttribute('*ngif') ?? '';
  el.removeAttribute('*ngif');
  const parts = splitTop(spec, ';');
  const { expr, alias } = splitAlias(spec);
  let elseName: string | null = null;
  let thenName: string | null = null;
  for (const p of parts.slice(1)) {
    const e = /^\s*else\s+([\w$]+)\s*$/.exec(p);
    if (e) elseName = e[1];
    const t = /^\s*then\s+([\w$]+)\s*$/.exec(p);
    if (t) thenName = t[1];
  }
  return applyIfResult(el, expr, alias, elseName, thenName, locals, run);
}

function applyIfResult(el: Element, expr: string, alias: string | null, elseName: string | null, thenName: string | null,
  locals: Locals, run: Run): Locals | null {
  const r = evalOrFlag(expr, locals, run);
  const next = alias && r.ok ? withLocal(locals, [[alias, r.value]]) : locals;
  if (r.ok && truthy(r.value)) {
    if (!thenName) return next;
    const tpl = findNgTemplate(run, thenName);
    if (tpl) insertNgTemplate(run, tpl, el, next);
    el.remove();
    return null;
  }
  const tpl = elseName ? findNgTemplate(run, elseName) : null;
  if (tpl) insertNgTemplate(run, tpl, el, locals);
  el.remove();
  return null;
}

function expandNgFor(el: Element, locals: Locals, run: Run): void {
  const spec = parseForSpec(el.getAttribute('*ngfor') ?? '');
  el.removeAttribute('*ngfor');
  const parent = el.parentNode;
  if (!spec || !parent) {
    run.approximate = true;
    el.remove();
    return;
  }
  const r = evalOrFlag(spec.of, locals, run);
  if (r.ok && Array.isArray(r.value)) {
    const items = r.value;
    items.slice(0, 3).forEach((item, k) => {
      const clone = el.cloneNode(true);
      parent.insertBefore(clone, el);
      processNode(clone, forLocals(locals, spec, item, k, items.length), run);
    });
  } else {
    run.approximate = true;
    const clone = el.cloneNode(true);
    parent.insertBefore(clone, el);
    processNode(clone, forLocals(locals, spec, UNRESOLVED, 0, 1), run);
  }
  el.remove();
}

function applyNgSwitch(el: Element, locals: Locals, run: Run): void {
  const value = evalOrFlag(el.getAttribute('[ngswitch]') ?? '', locals, run);
  let matched = false;
  const defaults: Element[] = [];
  for (const child of Array.from(el.children)) {
    if (child.hasAttribute('*ngswitchcase')) {
      const r = evalOrFlag(child.getAttribute('*ngswitchcase') ?? '', locals, run);
      child.removeAttribute('*ngswitchcase');
      if (value.ok && r.ok && r.value === value.value && !matched) matched = true;
      else child.remove();
    } else if (child.hasAttribute('*ngswitchdefault')) {
      child.removeAttribute('*ngswitchdefault');
      defaults.push(child);
    }
  }
  if (matched) defaults.forEach((d) => d.remove());
}

function addClasses(el: Element, v: Value, run: Run): void {
  const add = (names: string) => names.split(/\s+/).filter(Boolean).forEach((n) => {
    try {
      el.classList.add(n);
    } catch {
      /* nombre de clase inválido */
    }
  });
  if (typeof v === 'string') add(v);
  else if (Array.isArray(v)) v.forEach((x) => (typeof x === 'string' ? add(x) : x === UNRESOLVED ? (run.approximate = true) : null));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === UNRESOLVED) run.approximate = true;
      else if (truthy(x)) add(k);
    }
  }
}

function setStyle(el: Element, name: string, value: string): void {
  const style = (el as HTMLElement).style;
  if (!style || !/^-?[a-zA-Z][\w-]*$/.test(name)) return;
  try {
    style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), value);
  } catch {
    /* propiedad inválida */
  }
}

function bindProperty(el: Element, prop: string, expr: string, locals: Locals, run: Run): void {
  if (BOOL_PROPS.has(prop)) {
    const r = evalOrFlag(expr, locals, run);
    if (r.ok) {
      if (truthy(r.value)) el.setAttribute(prop, '');
      else el.removeAttribute(prop);
    } else if (prop === 'disabled' && run.state === 'blocked' && matchesSafe(el, run.markSelector)) {
      el.setAttribute('disabled', '');
    }
    return;
  }
  if (prop.startsWith('class.')) {
    const r = evalOrFlag(expr, locals, run);
    if (r.ok && truthy(r.value)) addClasses(el, prop.slice(6), run);
    return;
  }
  if (prop === 'ngclass' || prop === 'class' || prop === 'classname') {
    const r = evalOrFlag(expr, locals, run);
    if (r.ok) addClasses(el, r.value, run);
    return;
  }
  if (prop.startsWith('style.')) {
    const [name, unit = ''] = prop.slice(6).split('.');
    const r = evalOrFlag(expr, locals, run);
    if (r.ok && r.value !== null && r.value !== undefined && r.value !== false) setStyle(el, name, `${toText(r.value)}${unit}`);
    return;
  }
  if (prop === 'ngstyle') {
    const r = evalOrFlag(expr, locals, run);
    if (r.ok && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
      for (const [k, x] of Object.entries(r.value as Record<string, unknown>)) {
        const [name, unit = ''] = k.split('.');
        if (x !== null && x !== undefined && x !== false && x !== UNRESOLVED) setStyle(el, name, `${toText(x)}${unit}`);
      }
    }
    return;
  }
  if (prop.startsWith('attr.')) {
    const name = prop.slice(5);
    const r = evalOrFlag(expr, locals, run);
    if (r.ok && r.value !== null && r.value !== undefined && r.value !== false && ATTR_NAME.test(name)) {
      try {
        el.setAttribute(name, toText(r.value));
      } catch {
        /* nombre inválido */
      }
    }
    return;
  }
  if (prop === 'innerhtml' || prop === 'textcontent' || prop === 'innertext') {
    const r = evalOrFlag(expr, locals, run);
    el.textContent = r.ok ? toText(r.value) : '';
    return;
  }
  if (prop === 'ngmodel' || prop === 'value') {
    const r = evalOrFlag(expr, locals, run);
    if (r.ok) {
      el.setAttribute('value', toText(r.value));
      if (el.localName === 'textarea') el.textContent = toText(r.value);
    }
  }
  // [src], [href], [routerLink] y cualquier otra entrada de componente: se quitan.
}

function processAttributes(el: Element, locals: Locals, run: Run): void {
  for (const name of el.getAttributeNames()) {
    const value = el.getAttribute(name) ?? '';
    if (name.startsWith('(') || name.startsWith('on-') || name.startsWith('#') || name.startsWith('let-') || name.startsWith('i18n')
      || name.startsWith('bind-') || name.startsWith('ref-') || name.startsWith('@') || name.startsWith('[@')) {
      el.removeAttribute(name);
    } else if (name.startsWith('*')) {
      el.removeAttribute(name);
      run.approximate = true;
    } else if (name.startsWith('[(') && name.endsWith(')]')) {
      el.removeAttribute(name);
      const prop = name.slice(2, -2);
      if (prop === 'ngmodel' || prop === 'value') bindProperty(el, prop, value, locals, run);
    } else if (name.startsWith('[') && name.endsWith(']')) {
      el.removeAttribute(name);
      bindProperty(el, name.slice(1, -1), value, locals, run);
    } else if (value.includes('{{')) {
      el.setAttribute(name, interpolate(value, locals, run));
    }
  }
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

function processNode(node: Node, locals: Locals, run: Run): void {
  if (node.nodeType === 3) {
    const text = node.textContent ?? '';
    if (text.includes('{{')) node.textContent = interpolate(text, locals, run);
    return;
  }
  if (node.nodeType === 8) {
    node.parentNode?.removeChild(node);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.localName;
  if (tag === 'template') {
    processMarker(el as HTMLTemplateElement, locals, run);
    return;
  }
  if (tag === 'ng-template') return;
  if (el.hasAttribute('*ngfor')) {
    expandNgFor(el, locals, run);
    return;
  }
  let scope = locals;
  if (el.hasAttribute('*ngif')) {
    const next = applyNgIf(el, locals, run);
    if (!next) return;
    scope = next;
  }
  if (el.hasAttribute('[ngswitch]')) applyNgSwitch(el, scope, run);
  processAttributes(el, scope, run);
  for (const child of Array.from(el.childNodes)) processNode(child, scope, run);
  if (tag === 'ng-container') unwrap(el);
}

/**
 * Resolución mínima de la plantilla (sin ejecutarla): control de flujo, directivas estructurales, enlaces de
 * propiedades e interpolaciones. Lo que no se puede resolver queda vacío y activa `approximate`.
 */
export function resolveTemplate(fragment: string, ctx: ResolveTemplateContext): { html: string; approximate: boolean; doc: Document } {
  const exprs: string[] = [];
  const converted = convertControlFlow(expandSelfClosing(String(fragment ?? '')), exprs);
  const doc = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${converted}</body></html>`, 'text/html');
  const run: Run = {
    doc,
    bindings: ctx.bindings ?? {},
    state: ctx.state,
    markSelector: ctx.markSelector,
    exprs,
    approximate: false,
  };
  for (const child of Array.from(doc.body.childNodes)) processNode(child, new Map(), run);
  for (const tpl of Array.from(doc.body.querySelectorAll('ng-template, template'))) tpl.remove();
  return { html: doc.body.innerHTML, approximate: run.approximate, doc };
}

/* ============================================================
 *  Marca y decoración
 * ============================================================ */

const WRAP_MARK = new Set(['input', 'img', 'select', 'textarea']);

export function uiToneOf(state: UiPreviewState): UiPreviewTone {
  return state === 'blocked' ? 'amber' : state === 'silent' ? 'red' : 'green';
}

/**
 * Marca `plan.mark.selector` (los elementos vacíos se envuelven en `.nx-wrap`); en `silent` añade además el hueco
 * `.nx-gap`. Selector inexistente o inválido → `approximate`.
 */
export function markAndDecorate(doc: Document, plan: Pick<UiPreviewPlan, 'state' | 'mark'>, variant: UiPreviewVariant): { approximate: boolean } {
  const body = doc.body;
  let approximate = false;
  body.setAttribute('data-nx-tone', uiToneOf(plan.state));
  void variant;
  const label = plan.mark.label;
  let el: Element | null = null;
  try {
    el = body.querySelector(plan.mark.selector);
  } catch {
    el = null;
  }
  if (el) {
    let target = el;
    if (WRAP_MARK.has(el.localName)) {
      const wrap = doc.createElement('span');
      wrap.className = 'nx-wrap';
      el.parentNode?.insertBefore(wrap, el);
      wrap.appendChild(el);
      target = wrap;
    }
    target.classList.add('nx');
    target.setAttribute('data-nx', label);
  } else {
    approximate = true;
  }
  if (plan.state === 'silent') {
    const gap = doc.createElement('div');
    gap.className = 'nx-gap';
    gap.setAttribute('data-nx', label);
    body.appendChild(gap);
  }
  return { approximate };
}

/* ============================================================
 *  Encapsulación emulada de Angular
 * ============================================================ */

/** Añade `_ngcontent-<id>` a `root` (salvo `body`) y a todos sus descendientes. */
export function applyContentAttr(root: Element, id: string): void {
  const attr = `_ngcontent-${id}`;
  if (root.localName !== 'body') root.setAttribute(attr, '');
  for (const el of Array.from(root.querySelectorAll('*'))) el.setAttribute(attr, '');
}

type CssNode = { kind: 'rule'; prelude: string; body: string } | { kind: 'at'; prelude: string; body: string | null } | { kind: 'raw'; text: string };

/** Índice tras la cadena o comentario que empieza en `i` (o `i` si no empieza ninguno). */
function skipCssToken(css: string, i: number): number {
  const c = css[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < css.length && css[j] !== c) {
      if (css[j] === '\\') j++;
      j++;
    }
    if (j >= css.length) throw new Error('unterminated string');
    return j + 1;
  }
  if (c === '/' && css[i + 1] === '*') {
    const end = css.indexOf('*/', i + 2);
    if (end < 0) throw new Error('unterminated comment');
    return end + 2;
  }
  return i;
}

function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

/** Bloques de primer nivel (respeta cadenas y comentarios). Lanza si las llaves no cuadran. */
function parseCssBlocks(css: string): CssNode[] {
  const nodes: CssNode[] = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const skipped = skipCssToken(css, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = css[i];
    if (c === ';') {
      const text = stripCssComments(css.slice(start, i + 1));
      if (text && text !== ';') {
        nodes.push(text.startsWith('@') ? { kind: 'at', prelude: text.slice(0, -1).trim(), body: null } : { kind: 'raw', text });
      }
      start = ++i;
      continue;
    }
    if (c === '}') throw new Error('unbalanced }');
    if (c === '{') {
      const prelude = stripCssComments(css.slice(start, i));
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        const k = skipCssToken(css, j);
        if (k !== j) {
          j = k;
          continue;
        }
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      if (depth !== 0) throw new Error('unbalanced {');
      const body = css.slice(i + 1, j - 1);
      nodes.push(prelude.startsWith('@') ? { kind: 'at', prelude, body } : { kind: 'rule', prelude, body });
      i = j;
      start = j;
      continue;
    }
    i++;
  }
  const tail = stripCssComments(css.slice(start));
  if (tail) nodes.push({ kind: 'raw', text: tail });
  return nodes;
}

/** Divide por `sep` en el nivel superior (fuera de paréntesis, corchetes y cadenas). */
function splitSelectorTop(sel: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < sel.length) cur += sel[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Lee `(...)` equilibrado desde `i` (que apunta a `(`). */
function readParens(sel: string, i: number): { inner: string; end: number } {
  let depth = 0;
  for (let j = i; j < sel.length; j++) {
    if (sel[j] === '(') depth++;
    else if (sel[j] === ')') {
      depth--;
      if (depth === 0) return { inner: sel.slice(i + 1, j), end: j + 1 };
    }
  }
  throw new Error('unbalanced (');
}

/** Inserta el atributo en un compuesto, antes de la primera pseudoclase o pseudoelemento de nivel superior. */
function scopeCompound(compound: string, attr: string): string {
  if (!compound) return compound;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '\\') i++;
    else if (c === ':' && depth === 0) return `${compound.slice(0, i)}${attr}${compound.slice(i)}`;
  }
  return `${compound}${attr}`;
}

/** Marcador interno del host (se sustituye al final por `[_nghost-id]`). */
const HOST_MARK = '\u0000H';

/** Sustituye `:host(x)` → `x<host>` y `:host` → `<host>`. */
function replaceHost(sel: string): string {
  let out = '';
  for (let i = 0; i < sel.length; i++) {
    if (sel.startsWith(':host(', i)) {
      const g = readParens(sel, i + 5);
      out += `${g.inner.trim()}${HOST_MARK}`;
      i = g.end - 1;
      continue;
    }
    if (sel.startsWith(':host', i) && !/[\w-]/.test(sel[i + 5] ?? '')) {
      out += HOST_MARK;
      i += 4;
      continue;
    }
    out += sel[i];
  }
  return out;
}

/** Selector complejo → selector(es) con `_ngcontent`/`_nghost` (`:host-context` genera dos). */
function scopeSelector(sel: string, id: string): string[] {
  const content = `[_ngcontent-${id}]`;
  const host = `[_nghost-${id}]`;
  const s0 = sel.trim();
  if (!s0) return [];
  if (s0.startsWith(':host-context(')) {
    const g = readParens(s0, ':host-context'.length);
    const x = g.inner.trim();
    const rest = replaceHost(s0.slice(g.end)).replace(/^\u0000H/, '');
    return [scopeComplex(`${x}${HOST_MARK}${rest}`, content, host), scopeComplex(`${x} ${HOST_MARK}${rest}`, content, host)];
  }
  return [scopeComplex(replaceHost(s0), content, host)];
}

/** Recorre los compuestos separados por combinadores; tras `::ng-deep` no se añade nada. */
function scopeComplex(s: string, content: string, host: string): string {
  const parts: string[] = [];
  let deep = false;
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  const flush = (): void => {
    if (!cur) return;
    if (cur.includes('::ng-deep')) {
      const before = cur.replace(/::ng-deep/g, '').trim();
      if (before) parts.push(before.includes(HOST_MARK) || deep ? before : scopeCompound(before, content));
      deep = true;
    } else if (deep || cur.includes(HOST_MARK)) {
      parts.push(cur);
    } else {
      parts.push(scopeCompound(cur, content));
    }
    cur = '';
  };
  const isComb = (p: string | undefined): boolean => p === '>' || p === '+' || p === '~' || p === ' ';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < s.length) cur += s[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (depth === 0 && !quote && (/\s/.test(c) || c === '>' || c === '+' || c === '~')) {
      flush();
      const comb = /\s/.test(c) ? ' ' : c;
      const last = parts[parts.length - 1];
      if (!parts.length) {
        if (comb !== ' ') parts.push(comb);
      } else if (last === ' ') {
        if (comb !== ' ') parts[parts.length - 1] = comb;
      } else if (!isComb(last)) {
        parts.push(comb);
      }
      continue;
    }
    cur += c;
  }
  flush();
  while (parts.length && parts[parts.length - 1] === ' ') parts.pop();
  const joined = parts.map((p) => (p === '>' || p === '+' || p === '~' ? ` ${p} ` : p)).join('').replace(/\s+/g, ' ').trim();
  return joined.split(HOST_MARK).join(host);
}

const ENCAPSULATE_RECURSE = /^@(?:-[\w]+-)?(?:media|supports|container|layer|document)\b/i;

function encapsulateBlocks(css: string, id: string): string {
  const out: string[] = [];
  for (const node of parseCssBlocks(css)) {
    if (node.kind === 'raw') {
      out.push(node.text);
    } else if (node.kind === 'at') {
      if (node.body === null) out.push(`${node.prelude};`);
      else if (ENCAPSULATE_RECURSE.test(node.prelude)) out.push(`${node.prelude}{${encapsulateBlocks(node.body, id)}}`);
      else out.push(`${node.prelude}{${node.body}}`);
    } else {
      const selectors = splitSelectorTop(node.prelude, ',').flatMap((x) => scopeSelector(x, id)).filter((x) => !!x);
      if (selectors.length) out.push(`${selectors.join(',')}{${node.body}}`);
    }
  }
  return out.join('\n');
}

/**
 * Encapsulación emulada de Angular: `[_ngcontent-id]` en cada compuesto (antes de pseudoclases), `:host` →
 * `[_nghost-id]`, `:host(x)` → `x[_nghost-id]`, `:host-context(x)` → `x[_nghost-id], x [_nghost-id]`, nada tras
 * `::ng-deep`. Entra en `@media`/`@supports`/`@container`/`@layer`; no toca `@keyframes`/`@font-face`/`@page`.
 * Si el parseo falla devuelve el CSS sin encapsular y `approximate`.
 */
export function encapsulateCss(css: string, id: string): { css: string; approximate: boolean } {
  const text = String(css ?? '');
  try {
    return { css: encapsulateBlocks(text, id), approximate: false };
  } catch (error: unknown) {
    console.warn('[Nexo IA] CSS sin encapsular.', error instanceof Error ? error.name : '');
    return { css: text, approximate: true };
  }
}

/* ============================================================
 *  Saneado
 * ============================================================ */

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'link', 'meta', 'base', 'style', 'template',
  'ng-template', 'noscript', 'foreignobject']);
const DROP_ATTRS = new Set(['href', 'xlink:href', 'action', 'formaction', 'ping', 'srcset', 'poster', 'background']);

function isDataImage(url: string): boolean {
  return /^data:image\//i.test(url.trim());
}

/** data URI de fuente: `data:font/…` o `data:application/(x-)?font-…`. */
function isDataFont(url: string): boolean {
  return /^data:(?:font\/|application\/(?:x-)?font-)/i.test(url.trim());
}

function isAllowedCssUrl(url: string): boolean {
  return isDataImage(url) || isDataFont(url);
}

const URL_RE = /url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi;

function sanitizeInlineStyle(style: string): string {
  return style.replace(URL_RE, (m, _q: string, u: string) => (isAllowedCssUrl(u) ? m : 'none')).replace(/expression\s*\(/gi, '(');
}

/** Paso final sobre el DOM: quita elementos y atributos peligrosos (y `src` que no sea `data:image/…`). */
export function sanitizeFragmentDom(doc: Document): void {
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (!el.isConnected) continue;
    if (FORBIDDEN_TAGS.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const name of el.getAttributeNames()) {
      const lower = name.toLowerCase();
      const value = el.getAttribute(name) ?? '';
      if (lower.startsWith('on') || !ATTR_NAME.test(name) || DROP_ATTRS.has(lower)) el.removeAttribute(name);
      else if (lower === 'src' && !isDataImage(value)) el.removeAttribute(name);
      else if (lower === 'style') el.setAttribute('style', sanitizeInlineStyle(value));
    }
  }
  for (const name of doc.body.getAttributeNames()) {
    if (name !== 'data-nx-tone') doc.body.removeAttribute(name);
  }
}

/** Quita los bloques `@font-face { … }` salvo los que solo usan `url()` con data URI de fuente. */
function filterFontFaces(css: string): string {
  const re = /@font-face\b/gi;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const open = css.indexOf('{', m.index);
    if (open < 0) {
      out += css.slice(last, m.index);
      last = css.length;
      break;
    }
    const g = readGroup(css, open, '{', '}');
    const end = g ? g.end : css.length;
    const block = css.slice(m.index, end);
    const urlRe = new RegExp(URL_RE.source, 'gi');
    const urls: string[] = [];
    let u: RegExpExecArray | null;
    while ((u = urlRe.exec(block))) urls.push(u[2]);
    const keep = !!g && urls.length > 0 && urls.every((x) => isDataFont(x));
    out += css.slice(last, m.index) + (keep ? block : '');
    last = end;
    re.lastIndex = end;
  }
  return out + css.slice(last);
}

/**
 * CSS seguro para el iframe: sin `@import`/`@charset`/`expression(`; `url()` solo con data URI de imagen o fuente;
 * `@font-face` solo si todas sus `url()` son data de fuente.
 */
export function sanitizeCss(css: string): string {
  let out = String(css ?? '').replace(/@charset[^;{}]*;?/gi, '').replace(/@import[^;{}]*;?/gi, '');
  out = filterFontFaces(out);
  out = out.replace(URL_RE, (m, _q: string, u: string) => (isAllowedCssUrl(u) ? m : 'none'));
  out = out.replace(/expression\s*\(/gi, '(');
  return out.replace(/<\/style/gi, '<\\/style');
}

/* ============================================================
 *  SCSS (transpilador ligero; sin `sass`)
 * ============================================================ */

export type ScssImportLoader = (spec: string, fromPath: string) => Promise<{ path: string; text: string } | null>;

interface ScssState { approximate: boolean }

function stripScssComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  let inUrl = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (inUrl) {
      out += c;
      if (c === ')') inUrl = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (text.slice(i, i + 4).toLowerCase() === 'url(') {
      inUrl = true;
      out += text.slice(i, i + 4);
      i += 3;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

async function inlineScssImports(src: string, path: string, loader: ScssImportLoader, depth: number, state: ScssState): Promise<string> {
  const re = /@(use|import|forward)\s+([^;]+);/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += src.slice(last, m.index);
    last = m.index + m[0].length;
    const args = m[2];
    if (/\bwith\s*\(/.test(args)) state.approximate = true;
    if (/url\(/i.test(args)) continue;
    const specs: string[] = [];
    const specRe = /(['"])([^'"]+)\1/g;
    let s: RegExpExecArray | null;
    while ((s = specRe.exec(args))) specs.push(s[2]);
    const list = m[1] === 'import' ? specs : specs.slice(0, 1);
    for (const spec of list) {
      if (spec.startsWith('sass:')) continue;
      if (spec.startsWith('~') || spec.includes('node_modules') || /^[a-z]+:/i.test(spec) || spec.startsWith('//') || /\.css$/i.test(spec)) continue;
      if (depth >= 3) {
        state.approximate = true;
        continue;
      }
      const loaded = await loader(spec, path);
      if (!loaded) {
        state.approximate = true;
        continue;
      }
      out += `${await inlineScssImports(stripScssComments(loaded.text), loaded.path, loader, depth + 1, state)}\n`;
    }
  }
  return out + src.slice(last);
}

function substituteScssVars(src: string, state: ScssState): string {
  const vars = new Map<string, string>();
  const declRe = /\$([\w-]+)\s*:\s*([^;{}]+?)\s*((?:!default|!global)\s*)*;/g;
  const subst = (text: string): string => {
    let out = text.replace(/#\{\s*\$([\w-]+)\s*\}/g, (m, n: string) => vars.get(n) ?? m);
    const names = [...vars.keys()].sort((a, b) => b.length - a.length);
    for (const n of names) {
      out = out.replace(new RegExp(`\\$${n.replace(/[-]/g, '\\-')}(?![\\w-])`, 'g'), () => vars.get(n) ?? '');
    }
    return out;
  };
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src))) {
    const name = m[1];
    const isDefault = /!default/.test(m[3] ?? '');
    if (isDefault && vars.has(name)) continue;
    vars.set(name, subst(m[2]));
  }
  let out = src.replace(declRe, '');
  out = subst(out);
  out = out.replace(/#\{([^}]*)\}/g, '$1');
  if (/\$[\w-]/.test(out)) state.approximate = true;
  return out;
}

/** Fin de la sentencia que empieza en `from`: `;` o bloque `{…}` (fuera de comillas y paréntesis). */
function statementEnd(src: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth <= 0 && c === ';') return i + 1;
    else if (depth <= 0 && c === '{') {
      const g = readGroup(src, i, '{', '}');
      return g ? g.end : src.length;
    } else if (depth <= 0 && c === '}') return i;
  }
  return src.length;
}

function removeScssDirectives(src: string, state: ScssState): string {
  const re = /@(mixin|function|each|for|while|if|else|include|extend|debug|warn|error|use|forward|return)\b/;
  let out = src;
  for (let guard = 0; guard < 2000; guard++) {
    const m = re.exec(out);
    if (!m) break;
    if (m[1] !== 'debug' && m[1] !== 'warn' && m[1] !== 'use' && m[1] !== 'forward') state.approximate = true;
    const end = statementEnd(out, m.index + m[0].length);
    out = out.slice(0, m.index) + out.slice(end);
  }
  return out;
}

type ScssNode = { kind: 'decl'; text: string } | { kind: 'raw'; text: string } | { kind: 'rule'; prelude: string; body: ScssNode[] };

function parseScss(src: string, start: number): { nodes: ScssNode[]; end: number } {
  const nodes: ScssNode[] = [];
  let buf = '';
  let quote: string | null = null;
  let paren = 0;
  const flush = (): void => {
    const text = buf.trim();
    if (text) nodes.push({ kind: 'decl', text });
    buf = '';
  };
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < src.length) buf += src[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === '(') paren++;
    if (c === ')') paren = Math.max(0, paren - 1);
    if (paren > 0) {
      buf += c;
      continue;
    }
    if (c === '{') {
      const prelude = buf.trim();
      buf = '';
      if (/^@(-[a-z]+-)?keyframes\b|^@font-face\b|^@page\b/i.test(prelude)) {
        const g = readGroup(src, i, '{', '}');
        nodes.push({ kind: 'raw', text: `${prelude}{${g ? g.inner : ''}}` });
        i = g ? g.end - 1 : src.length;
        continue;
      }
      const child = parseScss(src, i + 1);
      nodes.push({ kind: 'rule', prelude, body: child.nodes });
      i = child.end - 1;
      continue;
    }
    if (c === '}') {
      flush();
      return { nodes, end: i + 1 };
    }
    if (c === ';') {
      flush();
      continue;
    }
    buf += c;
  }
  flush();
  return { nodes, end: src.length };
}

function combineSelectors(parents: string[], prelude: string): string[] {
  const children = splitTop(prelude, ',').map((s) => s.trim()).filter(Boolean);
  if (!parents.length) return children.map((c) => c.replace(/&/g, '').trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parents) for (const c of children) out.push(c.includes('&') ? c.replace(/&/g, p) : `${p} ${c}`);
  return out;
}

function flattenScss(src: string): string {
  const out: string[] = [];
  const wrap = (wrappers: string[], body: string): string => wrappers.reduceRight((inner, w) => `${w}{${inner}}`, body);
  const walk = (nodes: ScssNode[], parents: string[], wrappers: string[]): void => {
    const decls = nodes.filter((n): n is { kind: 'decl'; text: string } => n.kind === 'decl').map((n) => n.text);
    if (decls.length && parents.length) out.push(wrap(wrappers, `${parents.join(',')}{${decls.join(';')}}`));
    for (const n of nodes) {
      if (n.kind === 'raw') out.push(wrap(wrappers, n.text));
      else if (n.kind === 'rule') {
        if (/^@(media|supports|container|layer)\b/i.test(n.prelude)) walk(n.body, parents, [...wrappers, n.prelude]);
        else if (n.prelude.startsWith('@')) continue;
        else walk(n.body, combineSelectors(parents, n.prelude), wrappers);
      }
    }
  };
  walk(parseScss(src, 0).nodes, [], []);
  return out.join('\n');
}

/**
 * Transpilador SCSS ligero (sin compilador): comentarios, variables (también `#{$x}`), anidamiento con `&`, `@media`
 * anidados y parciales locales (`@use`/`@import`, profundidad ≤ 3). Mixins, funciones y control de flujo se quitan y
 * marcan `approximate`.
 */
export async function scssFallback(text: string, path: string, importLoader: ScssImportLoader): Promise<{ css: string; approximate: boolean }> {
  const state: ScssState = { approximate: false };
  try {
    let src = await inlineScssImports(stripScssComments(String(text ?? '')), path, importLoader, 0, state);
    src = src.replace(/\b[\w-]+\.\$/g, '$');
    src = substituteScssVars(src, state);
    src = removeScssDirectives(src, state);
    return { css: flattenScss(src), approximate: state.approximate };
  } catch {
    return { css: '', approximate: true };
  }
}

/* ============================================================
 *  srcdoc
 * ============================================================ */

const NX_FONT = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

/** Base del documento: va ANTES de los globales (estos pueden cambiar el fondo). */
// La vista previa es una foto fija: cada animación salta a su estado final y se para (las infinitas saturaban el
// render de los iframes); así los elementos que entran con un fundido siguen visibles.
export const NEXO_BASE_CSS = 'html,body{margin:0;overflow:hidden} html{background:#fff} '
  + '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;'
  + 'animation-iteration-count:1!important;animation-fill-mode:both!important;transition:none!important;caret-color:transparent}';

export const NEXO_OVERLAY_CSS = [
  'body{--nx-c:#f59e0b}',
  'body[data-nx-tone="red"]{--nx-c:#ef4444}',
  'body[data-nx-tone="green"]{--nx-c:#22c55e}',
  '.nx{outline:2px solid var(--nx-c)!important;outline-offset:2px!important;position:relative!important}',
  `.nx::after{content:attr(data-nx);position:absolute;left:0;top:calc(100% + 6px);z-index:2147483646;padding:2px 6px;border-radius:4px;background:var(--nx-c);color:#fff;font:600 11px/1.3 ${NX_FONT};white-space:nowrap;pointer-events:none}`,
  '.nx-wrap{display:inline-block;position:relative}',
  '.nx-gap{position:fixed;top:8px;right:8px;width:170px;height:40px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:2px dashed #ef4444;border-radius:6px;background:rgba(239,68,68,.06);z-index:2147483645}',
  `.nx-gap::after{content:attr(data-nx);padding:0 6px;color:#b91c1c;font:600 11px/1.2 ${NX_FONT};text-align:center}`,
].join('\n');

const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`;

/** Documento del iframe (CSS ya saneado con `sanitizeCss`; HTML ya saneado con `sanitizeFragmentDom`). */
export function buildSrcdoc(p: { globalCss: string; componentCss: string; html: string; tone: UiPreviewTone }): string {
  const tone: UiPreviewTone = p.tone === 'red' || p.tone === 'green' ? p.tone : 'amber';
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<style>${NEXO_BASE_CSS}</style><style>${p.globalCss}</style><style>${p.componentCss}</style><style>${NEXO_OVERLAY_CSS}</style>`
    + `</head><body data-nx-tone="${tone}">${p.html}</body></html>`;
}

/** Quita los data URI (para no superar el tamaño máximo del `srcdoc`). */
export function stripInlineAssets(srcdoc: string): string {
  return srcdoc
    .replace(/url\(\s*(['"]?)data:[^)]*?\1\s*\)/gi, 'none')
    .replace(/\ssrc="data:[^"]*"/gi, '');
}
