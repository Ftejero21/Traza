/**
 * Ports literales de la validación semántica y de los textos de usuario de tejechat
 * (`WorkspaceCodeFlowDiagnosisServiceImpl`, `WorkspaceCodeAssistServiceImpl`, `WorkspaceCodeAiProviderSupport`).
 * Funciones puras sobre JSON ya parseado. Nunca registran contenido.
 */
import { validate } from './schema-validator';

type Obj = Record<string, unknown>;

const MAX_ERRORS = 20;
const MAX_CHANGE_CHARS = 20000;
const MAX_PATH_CHARS = 400;
const MAX_HUNKS = 40;
const MAX_HUNK_LINES = 400;
const MAX_LINE_TEXT = 2000;

export function isObj(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `JsonNode.path(key)`: valor de la clave o `undefined`. */
function at(value: unknown, key: string): unknown {
  return isObj(value) ? value[key] : undefined;
}

/** `JsonNode` iterable (array o vacío). */
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `asText("")`: texto, número o booleano como texto; lo demás, vacío. */
export function txt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

export function cut(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function limit(errors: string[]): string[] {
  return errors.length > MAX_ERRORS ? errors.slice(0, MAX_ERRORS) : errors;
}

function stepIds(flow: unknown): Set<string> {
  const steps = new Set<string>();
  for (const step of list(at(flow, 'steps'))) steps.add(txt(at(step, 'id')));
  return steps;
}

/* ------------------------------- parseo ------------------------------- */

/** Port de `parseJson`: quita la valla ``` y toma del primer `{` al último `}`. Lanza `Error` con un código corto. */
export function parseModelJson(content: string): Obj {
  if (!content || !content.trim()) throw new Error('contenido vacio');
  let s = content.trim();
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n');
    s = nl < 0 ? '' : s.slice(nl + 1);
    if (s.endsWith('```')) s = s.slice(0, -3);
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('sin objeto JSON');
  const raw = s.slice(start, end + 1);
  let node: unknown;
  try {
    node = JSON.parse(raw);
  } catch {
    const repaired = repairJson(raw);
    try {
      node = JSON.parse(repaired.text);
    } catch (error: unknown) {
      if (repaired.truncated) {
        throw new Error('JSON cortado: la respuesta es demasiado larga; devuelve una version mas breve (explicaciones de una frase, sin repetir codigo)');
      }
      const position = error instanceof Error ? /position (\d+)/.exec(error.message)?.[1] : undefined;
      throw new Error(position ? `JSON invalido cerca de la posicion ${position}` : 'JSON invalido');
    }
  }
  if (!isObj(node)) throw new Error('no es un objeto');
  return node;
}

/**
 * Errores habituales de los modelos al escribir JSON: caracteres de control sin escapar dentro de cadenas (saltos de
 * línea en código citado), escapes no válidos (`\'`, `\d`), comas antes de `}` o `]` y respuestas cortadas por el límite
 * de salida del modelo (se cierran las cadenas, objetos y arrays pendientes; `truncated` lo indica).
 */
function repairJson(text: string): { text: string; truncated: boolean } {
  let out = '';
  let inString = false;
  let escaped = false;
  const open: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
      } else if (ch === '\\') {
        // Escape no válido en JSON (`\'`, `\d`…): se conserva la barra como literal.
        if ('"\\/bfnrtu'.includes(text[i + 1] ?? '')) escaped = true;
        else out += '\\';
        out += ch;
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      else out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    if (ch === '{' || ch === '[') open.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (open[open.length - 1] !== ch) continue;
      open.pop();
    }
    out += ch;
  }
  const truncated = inString || open.length > 0;
  if (inString) out += '"';
  if (open.length) {
    out = out.replace(/[\s,:]+$/, '');
    // Una clave sin valor al final (`{"x"` o `,"x"`) dentro de un objeto se descarta.
    if (open[open.length - 1] === '}') out = out.replace(/([{,])\s*"(?:[^"\\]|\\.)*"$/, '$1').replace(/,\s*$/, '');
    out += open.reverse().join('');
  }
  return { text: out, truncated };
}

/* ------------------------------- textos ------------------------------- */

/** Contenido con cada línea precedida de su número (`N| texto`), para que la IA cite líneas reales. */
export function numbered(content: string | null | undefined, startLine: number | null | undefined): string {
  if (content === null || content === undefined) return '';
  const n = !startLine || startLine < 1 ? 1 : startLine;
  return content.split(/\r?\n/).map((line, i) => `${n + i}| ${line}`).join('\n');
}

/** Corta el CSS a `max` caracteres en el último '}' (o en `max` si no hay ninguno). */
export function cutCss(css: string | null | undefined, max: number): string {
  if (css === null || css === undefined || css.length <= max) return css ?? '';
  const end = css.lastIndexOf('}', max - 1) + 1;
  return css.slice(0, end > 0 ? end : max);
}

/** Diff unificado compacto del cambio propuesto: `@@ ruta:oldStart` y líneas con prefijo ' ', '+' o '-'. */
export function changeDiff(change: unknown): string | null {
  if (!isObj(change)) return null;
  let sb = '';
  const title = txt(change['title']).trim();
  const summary = txt(change['summary']).trim();
  if (title) sb += `${title}\n`;
  if (summary) sb += `${summary}\n`;
  for (const file of list(change['files'])) {
    const path = txt(at(file, 'path'));
    for (const hunk of list(at(file, 'hunks'))) {
      const oldStart = at(hunk, 'oldStart');
      sb += `@@ ${path}:${typeof oldStart === 'number' ? Math.trunc(oldStart) : 0}\n`;
      for (const line of list(at(hunk, 'lines'))) {
        const kind = txt(at(line, 'kind'));
        const prefix = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
        sb += `${prefix}${txt(at(line, 'text'))}\n`;
      }
      if (sb.length > MAX_CHANGE_CHARS) return cut(sb, MAX_CHANGE_CHARS);
    }
  }
  return cut(sb, MAX_CHANGE_CHARS);
}

/* --------------------------- SIMULATE / LOGS --------------------------- */

/**
 * Adaptación para dibujar (sin reintentos): en LOGS se quitan las evidencias con `index` fuera del número de líneas de
 * los logs. Los ids de pasos desconocidos y la coherencia kind/failStepId los tolera la webview.
 */
export function repairDiagnosis(result: Obj, logLines: number, simulate: boolean): void {
  if (simulate) return;
  const evidence = result['evidence'];
  if (!Array.isArray(evidence)) return;
  result['evidence'] = evidence.filter((e) => {
    const index = at(e, 'index');
    const n = typeof index === 'number' ? Math.trunc(index) : -1;
    return n < logLines;
  });
}

/* --------------------------------- FLOW --------------------------------- */

/** Ids de carriles y pasos únicos y no vacíos; from/to de los pasos deben ser carriles. */
export function flowSemantics(flow: unknown): string[] {
  const errors: string[] = [];
  const lanes = new Set<string>();
  list(at(flow, 'lanes')).forEach((lane, i) => {
    const id = txt(at(lane, 'id'));
    if (!id || lanes.has(id)) errors.push(`$.lanes[${i}].id: id vacio o duplicado`);
    else lanes.add(id);
  });
  const steps = new Set<string>();
  list(at(flow, 'steps')).forEach((step, i) => {
    const id = txt(at(step, 'id'));
    if (!id || steps.has(id)) errors.push(`$.steps[${i}].id: id vacio o duplicado`);
    else steps.add(id);
    if (!lanes.has(txt(at(step, 'from')))) errors.push(`$.steps[${i}].from: no es un id de lanes`);
    if (!lanes.has(txt(at(step, 'to')))) errors.push(`$.steps[${i}].to: no es un id de lanes`);
  });
  return limit(errors);
}

/**
 * "scenario" es opcional: si no cumple el esquema FlowScenario, se quita en silencio (sin invalidar el FLOW ni provocar
 * reintentos). Los ids de pasos desconocidos los ignora la webview.
 */
export function dropInvalidScenario(root: Obj): void {
  if (!('scenario' in root)) return;
  const errors = validate('FlowScenario', root['scenario']);
  if (errors.length) {
    delete root['scenario'];
    console.warn('[Traza] Escenario del flujo descartado.', errors.length);
  }
}

/* -------------------------------- PROPOSE -------------------------------- */

/** Port de `normalizePath` de tejechat: ruta relativa válida o `null`. */
export function normalizeProposalPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let p = raw.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p || p.length > MAX_PATH_CHARS || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(p)) return null;
  if (p.split('/').some((segment) => segment === '..')) return null;
  if (p.endsWith('/')) return null;
  return p;
}

/**
 * Rutas relativas válidas, pares (mountId, path) únicos, mountId de MONTAJES o "", added/deleted/modified coherentes y
 * los límites de forma que la webview exige para dibujar (40 bloques por archivo, 1-400 líneas por bloque, texto de una
 * sola línea de como mucho 2000 caracteres). En un archivo `added` se fija `oldStart = 0` (arreglo mecánico).
 */
export function proposeSemantics(change: unknown, mountIds: Set<string>): string[] {
  const errors: string[] = [];
  const pairs = new Set<string>();
  list(at(change, 'files')).forEach((file, i) => {
    const base = `$.files[${i}]`;
    const path = normalizeProposalPath(txt(at(file, 'path')));
    if (path === null) errors.push(`${base}.path: ruta no valida (relativa, sin '..' ni ruta absoluta)`);
    const mountId = txt(at(file, 'mountId')).trim();
    if (mountId && !mountIds.has(mountId)) errors.push(`${base}.mountId: no es un id de MONTAJES ni ""`);
    if (path !== null) {
      const key = `${mountId}\u0000${path}`;
      if (pairs.has(key)) errors.push(`${base}: archivo repetido (mismo mountId y path)`);
      pairs.add(key);
    }
    const status = txt(at(file, 'status'));
    let changes = false;
    const hunks = list(at(file, 'hunks'));
    if (hunks.length > MAX_HUNKS) errors.push(`${base}.hunks: como mucho ${MAX_HUNKS} bloques`);
    hunks.forEach((hunk, j) => {
      if (status === 'added' && isObj(hunk)) hunk['oldStart'] = 0;
      const lines = list(at(hunk, 'lines'));
      if (lines.length < 1 || lines.length > MAX_HUNK_LINES) errors.push(`${base}.hunks[${j}].lines: entre 1 y ${MAX_HUNK_LINES} lineas`);
      lines.forEach((line, k) => {
        const text = at(line, 'text');
        if (typeof text === 'string' && (text.length > MAX_LINE_TEXT || text.includes('\n') || text.includes('\r'))) {
          errors.push(`${base}.hunks[${j}].lines[${k}].text: una sola linea de como mucho ${MAX_LINE_TEXT} caracteres`);
        }
      });
      for (const line of lines) {
        const kind = txt(at(line, 'kind'));
        if (kind !== 'context') changes = true;
        if (status === 'added' && kind !== 'add') {
          errors.push(`${base}.hunks[${j}]: un archivo nuevo solo admite lineas "add"`);
          break;
        }
        if (status === 'deleted' && kind !== 'del') {
          errors.push(`${base}.hunks[${j}]: un archivo eliminado solo admite lineas "del"`);
          break;
        }
      }
    });
    if (status === 'modified' && !changes) errors.push(`${base}: un archivo modificado necesita al menos una linea "add" o "del"`);
  });
  return limit(errors);
}

/* -------------------------------- DB_MAP -------------------------------- */

/** Neutraliza '<' (nunca se inserta HTML). */
function defang(text: string): string {
  return text.replace(/</g, '‹');
}

function checkNoMarkup(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string' && value.includes('<')) errors.push(`${path}: no puede contener '<'`);
}

/** Máximo de claves de `values` por acceso (el esquema lo deja abierto). */
const DB_MAX_VALUES = 16;

/**
 * Repara un FlowDbMap ya válido contra el esquema: quita relaciones y accesos con tablas o pasos desconocidos, deja un
 * acceso por paso, pone via a null si no es una tabla declarada, recorta values a 16 textos de 40 caracteres y
 * neutraliza '<' (por '‹') en los textos libres para no insertar nunca marcado.
 */
export function repairDbMap(map: Obj, flow: unknown): void {
  if (typeof map['summary'] === 'string') map['summary'] = defang(map['summary']);
  const steps = stepIds(flow);
  const tables = new Set<string>();
  for (const table of list(map['tables'])) tables.add(txt(at(table, 'name')));
  map['relations'] = list(map['relations']).filter((rel) => tables.has(txt(at(rel, 'from'))) && tables.has(txt(at(rel, 'to'))));
  const seen = new Set<string>();
  const kept: unknown[] = [];
  for (const node of list(map['accesses'])) {
    const stepId = txt(at(node, 'stepId'));
    if (!isObj(node) || !steps.has(stepId) || !tables.has(txt(node['table'])) || seen.has(stepId)) continue;
    seen.add(stepId);
    const a: Obj = { ...node };
    if (typeof a['note'] === 'string') a['note'] = defang(a['note']);
    if (typeof a['fn'] === 'string') a['fn'] = defang(a['fn']);
    if (typeof a['via'] === 'string' && !tables.has(a['via'])) a['via'] = null;
    const values = a['values'];
    if (isObj(values)) {
      const clean: Obj = {};
      for (const [key, value] of Object.entries(values)) {
        if (Object.keys(clean).length >= DB_MAX_VALUES || value === null) continue;
        const v = typeof value === 'string' ? value : JSON.stringify(value);
        clean[key] = defang(v.length > 40 ? `${v.slice(0, 39)}…` : v);
      }
      a['values'] = clean;
    }
    kept.push(a);
  }
  map['accesses'] = kept;
}

/**
 * Reglas del FlowDbMap que el esquema no expresa: stepId de los pasos del FLUJO (uno por paso), tablas declaradas en
 * accesses/via/relations, values con como mucho 16 textos de 40 caracteres y sin marcado en los textos libres.
 */
export function dbMapErrors(map: unknown, flow: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(map)) return ['$: debe ser un objeto'];
  const steps = stepIds(flow);
  const tables = new Set<string>();
  for (const table of list(map['tables'])) tables.add(txt(at(table, 'name')));
  checkNoMarkup(map['summary'], '$.summary', errors);
  list(map['relations']).forEach((rel, i) => {
    if (!tables.has(txt(at(rel, 'from')))) errors.push(`$.relations[${i}].from: no es una tabla de tables`);
    if (!tables.has(txt(at(rel, 'to')))) errors.push(`$.relations[${i}].to: no es una tabla de tables`);
  });
  const seen = new Set<string>();
  list(map['accesses']).forEach((a, i) => {
    const path = `$.accesses[${i}]`;
    const stepId = txt(at(a, 'stepId'));
    if (!steps.has(stepId)) errors.push(`${path}.stepId: no es un id de steps del FLUJO`);
    else if (seen.has(stepId)) errors.push(`${path}.stepId: ya hay un acceso para ese paso`);
    else seen.add(stepId);
    if (!tables.has(txt(at(a, 'table')))) errors.push(`${path}.table: no es una tabla de tables`);
    const via = at(a, 'via');
    if (typeof via === 'string' && !tables.has(via)) errors.push(`${path}.via: no es una tabla de tables ni null`);
    checkNoMarkup(at(a, 'note'), `${path}.note`, errors);
    checkNoMarkup(at(a, 'fn'), `${path}.fn`, errors);
    const values = at(a, 'values');
    if (isObj(values)) {
      if (Object.keys(values).length > DB_MAX_VALUES) errors.push(`${path}.values: mas de ${DB_MAX_VALUES} claves`);
      for (const [k, v] of Object.entries(values)) {
        const key = `${path}.values.${cut(k, 64)}`;
        if (typeof v !== 'string' || v.length > 40) errors.push(`${key}: debe ser un texto de como mucho 40 caracteres`);
        else checkNoMarkup(v, key, errors);
      }
    }
  });
  return limit(errors);
}

/* -------------------------------- UI_PLAN -------------------------------- */

function uiPlanBodyErrors(body: unknown, path: string, errors: string[]): void {
  const mark = at(body, 'mark');
  const inject = at(body, 'inject');
  checkNoMarkup(at(body, 'root'), `${path}.root`, errors);
  checkNoMarkup(at(mark, 'selector'), `${path}.mark.selector`, errors);
  checkNoMarkup(at(mark, 'label'), `${path}.mark.label`, errors);
  checkNoMarkup(at(inject, 'after'), `${path}.inject.after`, errors);
  checkNoMarkup(at(inject, 'component'), `${path}.inject.component`, errors);
  checkNoMarkup(at(body, 'caption'), `${path}.caption`, errors);
  const bindings = at(body, 'bindings');
  if (isObj(bindings)) {
    const keys = Object.keys(bindings);
    if (keys.length > 60) errors.push(`${path}.bindings: mas de 60 claves`);
    for (const key of keys) if (key.length > 120) errors.push(`${path}.bindings: clave mayor de 120 caracteres`);
    if (JSON.stringify(bindings).length > 4000) errors.push(`${path}.bindings: mayor de 4000 caracteres`);
  }
  const inputs = at(inject, 'inputs');
  if (isObj(inputs) && Object.keys(inputs).length > 20) errors.push(`${path}.inject.inputs: mas de 20 claves`);
}

/** Neutraliza '<' (por '‹') en caption y mark.label del plan, en la raíz y en `after`. */
export function repairUiPlan(plan: Obj): void {
  const fix = (body: unknown): void => {
    if (!isObj(body)) return;
    if (typeof body['caption'] === 'string') body['caption'] = defang(body['caption']);
    const mark = body['mark'];
    if (isObj(mark) && typeof mark['label'] === 'string') mark['label'] = defang(mark['label']);
  };
  fix(plan);
  fix(plan['after']);
}

/** Reglas del UiPreviewPlan que el esquema no expresa: sin marcado en selectores, root e inject, y tamaños de bindings/inputs. */
export function uiPlanErrors(plan: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(plan)) return ['$: debe ser un objeto'];
  uiPlanBodyErrors(plan, '$', errors);
  const after = plan['after'];
  if (!isNullish(after)) {
    if (!isObj(after)) errors.push('$.after: debe ser un objeto');
    else {
      if ('after' in after) errors.push('$.after.after: no permitido');
      uiPlanBodyErrors(after, '$.after', errors);
    }
  }
  return limit(errors);
}
