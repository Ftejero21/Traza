/**
 * Validador JSON Schema mínimo (port de `WorkspaceCodeJsonSchemaValidator`) para la salida estructurada de la IA.
 * Subconjunto usado por `nexo-ia.schemas.json` (único origen del contrato; importado en el bundle): type (también en
 * array y null), required, properties, additionalProperties false, enum, minLength/maxLength, minimum/maximum,
 * minItems/maxItems, items, $ref a #/$defs, oneOf, allOf y el esquema vacío {}. Como mucho 20 errores con ruta.
 */
import SCHEMAS from './nexo-ia.schemas.json';

type Json = unknown;
type Schema = Record<string, unknown>;

const MAX_ERRORS = 20;
const MAX_DEPTH = 64;
const ROOT = SCHEMAS as unknown as Record<string, unknown>;
const DEFS = (ROOT['$defs'] ?? {}) as Record<string, unknown>;

function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function definitionNode(definition: string): Schema | null {
  const top = ROOT[definition];
  if (isObj(top) && definition !== '$defs') return top;
  const def = DEFS[definition];
  return isObj(def) ? def : null;
}

function resolve(ref: string): Schema | null {
  if (!ref.startsWith('#/$defs/')) return null;
  const def = DEFS[ref.slice('#/$defs/'.length)];
  return isObj(def) ? def : null;
}

function collectRefs(schema: unknown, out: Set<string>): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, out);
    return;
  }
  if (!isObj(schema)) return;
  const ref = schema['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
    const name = ref.slice('#/$defs/'.length);
    if (!out.has(name)) {
      out.add(name);
      collectRefs(DEFS[name], out);
    }
  }
  for (const value of Object.values(schema)) collectRefs(value, out);
}

/** JSON compacto con la definición y los $defs que usa (para el prompt de sistema). */
export function compactSchema(definition: string): string {
  const schema = definitionNode(definition);
  if (!schema) return '{}';
  const used = new Set<string>();
  collectRefs(schema, used);
  const out: Record<string, unknown> = {};
  const defs: Record<string, unknown> = {};
  for (const name of used) if (DEFS[name] !== undefined) defs[name] = DEFS[name];
  if (Object.keys(defs).length) out['$defs'] = defs;
  out[definition] = schema;
  return JSON.stringify(out);
}

function typeName(value: Json): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'unknown';
}

function matchesSingle(type: string, value: Json): boolean {
  switch (type) {
    case 'object': return isObj(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null || value === undefined;
    default: return true;
  }
}

function matchesType(type: unknown, value: Json): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesSingle(String(t), value));
  return matchesSingle(String(type), value);
}

function deepEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function add(errors: string[], message: string): void {
  if (errors.length < MAX_ERRORS) errors.push(message);
}

function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function check(schema: unknown, node: Json, path: string, errors: string[], depth: number): void {
  if (errors.length >= MAX_ERRORS || !isObj(schema) || !Object.keys(schema).length) return;
  if (depth > MAX_DEPTH) {
    add(errors, `${path}: demasiado anidado`);
    return;
  }
  const value = node === undefined ? null : node;
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const target = resolve(ref);
    if (!target) add(errors, `${path}: $ref desconocida ${ref}`);
    else check(target, value, path, errors, depth + 1);
  }
  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) for (const sub of allOf) check(sub, value, path, errors, depth + 1);
  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    let matches = 0;
    let best: string[] | null = null;
    for (const sub of oneOf) {
      const branch: string[] = [];
      check(sub, value, path, branch, depth + 1);
      if (!branch.length) matches++;
      else if (!best || branch.length < best.length) best = branch;
    }
    if (matches === 0 && best) for (const e of best) add(errors, e);
    else if (matches > 1) add(errors, `${path}: oneOf coincide con ${matches} opciones`);
  }
  const type = schema['type'];
  if (type !== undefined && !matchesType(type, value)) {
    add(errors, `${path}: type ${Array.isArray(type) ? JSON.stringify(type) : String(type)} (es ${typeName(value)})`);
    return;
  }
  const enumNode = schema['enum'];
  if (Array.isArray(enumNode) && !enumNode.some((option) => deepEqual(option, value))) {
    add(errors, `${path}: enum ${JSON.stringify(enumNode)}`);
  }
  if (typeof value === 'string') {
    const length = codePoints(value);
    if (typeof schema['minLength'] === 'number' && length < schema['minLength']) add(errors, `${path}: minLength ${schema['minLength']}`);
    if (typeof schema['maxLength'] === 'number' && length > schema['maxLength']) add(errors, `${path}: maxLength ${schema['maxLength']}`);
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) add(errors, `${path}: minimum ${schema['minimum']}`);
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) add(errors, `${path}: maximum ${schema['maximum']}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) add(errors, `${path}: minItems ${schema['minItems']}`);
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) add(errors, `${path}: maxItems ${schema['maxItems']}`);
    const items = schema['items'];
    if (isObj(items)) {
      for (let i = 0; i < value.length && errors.length < MAX_ERRORS; i++) check(items, value[i], `${path}[${i}]`, errors, depth + 1);
    }
  }
  if (isObj(value)) {
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const field of required) if (!Object.prototype.hasOwnProperty.call(value, String(field))) add(errors, `${path}.${String(field)}: required`);
    }
    const properties = isObj(schema['properties']) ? (schema['properties'] as Record<string, unknown>) : null;
    if (properties) {
      for (const [key, sub] of Object.entries(properties)) {
        if (errors.length >= MAX_ERRORS) break;
        if (Object.prototype.hasOwnProperty.call(value, key)) check(sub, value[key], `${path}.${key}`, errors, depth + 1);
      }
    }
    if (schema['additionalProperties'] === false) {
      for (const name of Object.keys(value)) {
        if (!properties || !Object.prototype.hasOwnProperty.call(properties, name)) add(errors, `${path}.${name}: additionalProperties false`);
      }
    }
  }
}

/** Errores de validación del valor contra la definición indicada (FlowDiagram, SimulationResult…). */
export function validate(definition: string, value: unknown): string[] {
  const errors: string[] = [];
  const schema = definitionNode(definition);
  if (!schema) return [`$: esquema desconocido ${definition}`];
  check(schema, value, '$', errors, 0);
  return errors;
}
