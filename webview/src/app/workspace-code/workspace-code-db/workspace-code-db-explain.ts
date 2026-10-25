import { WorkspaceCodeDbColumn, WorkspaceCodeDbForeignKey, WorkspaceCodeDbTable } from '../services/workspace-code-runtime.types';
import { relationCardinality } from './workspace-code-db.util';

/**
 * Modo «Explicar» del diagrama de una tabla: guion didáctico paso a paso de cómo se rellena una tabla. Este archivo solo
 * tiene tipos y lógica pura (sin Angular): el generador local a partir del esquema, la fusión del guion de la IA y el
 * reproductor con temporizador. El componente del diagrama es quien lo dibuja.
 */

export type DbExplainKind = 'actor' | 'request' | 'flow' | 'insert' | 'fill' | 'note';

export interface DbExplainStep {
  id: string;
  kind: DbExplainKind;
  /** Nombre de tabla, `@app`, `@api` o `null`. */
  from: string | null;
  to: string | null;
  title: string;
  text: string;
  endpoint?: string | null;
  endpointGuess?: boolean;
  /** Columnas de la tabla destino que se rellenan en este paso. */
  columns: string[];
  icon: string;
  durationMs?: number;
  /** Modo «Base de datos» del flujo: tabla accedida, operación, función y valores (expresiones) por columna. */
  table?: string | null;
  op?: string | null;
  fn?: string | null;
  values?: Record<string, string>;
}

export type DbExplainRole = 'auto' | 'uuid' | 'fk' | 'input' | 'now' | 'updated' | 'default' | 'null' | 'secret' | 'hash' | 'deleted';

export interface DbExplainSampleCell {
  column: string;
  value: string;
  role: DbExplainRole;
}

export interface DbExplainScript {
  table: string;
  source: 'local' | 'ai';
  summary: string;
  involved: string[];
  sample: DbExplainSampleCell[];
  steps: DbExplainStep[];
  /** Guion conducido por el flujo: título de la cabecera y nota del origen del esquema. */
  title?: string;
  note?: string;
}

/** Respuesta del endpoint de IA (`POST /api/workspace/code-ai/db-explain`). */
export interface DbExplainAiStep {
  kind?: string | null;
  from?: string | null;
  to?: string | null;
  title?: string | null;
  text?: string | null;
  endpoint?: string | null;
  columns?: string[] | null;
}

export interface DbExplainAiResponse {
  success: boolean;
  codigo?: string | null;
  mensaje?: string | null;
  summary?: string | null;
  steps?: DbExplainAiStep[] | null;
}

export const ACTOR_APP = '@app';
export const ACTOR_API = '@api';

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KINDS: DbExplainKind[] = ['actor', 'request', 'flow', 'insert', 'fill', 'note'];
const ICONS: Record<DbExplainKind, string> = {
  actor: 'bi-person', request: 'bi-send', flow: 'bi-key', insert: 'bi-box-seam', fill: 'bi-magic', note: 'bi-info-circle',
};
const MAX_STEPS = 8;
const MAX_PARENTS = 3;
const SAMPLE_IDS = ['7', '3', '12', '21', '8', '15', '4', '9'];
const OWNER_TABLE = /^(users?|usuarios?|accounts?|cuentas?|members?|miembros?|clientes?|customers?|profiles?|perfiles?|empleados?|employees?|personas?)$/i;
const OWNER_COLUMN = /(user|usuario|owner|author|autor|creador|creator|created_by|emisor|sender|cliente|customer|account|cuenta)(_id)?$/i;

export function explainIconFor(kind: DbExplainKind): string {
  return ICONS[kind] ?? ICONS.note;
}

export function isExplainActor(id: string | null | undefined): boolean {
  return id === ACTOR_APP || id === ACTOR_API;
}

/* ====================================================================
 * Generador local
 * ==================================================================== */

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
}

function ticks(names: string[]): string[] {
  return names.map((n) => '`' + n + '`');
}

function joinNames(names: string[], t: Translate): string {
  const list = ticks(names);
  if (list.length <= 1) return list.join('');
  return list.slice(0, -1).join(', ') + t('dbx.and') + list[list.length - 1];
}

function truncate(value: string, max = 24): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function typeOf(column: WorkspaceCodeDbColumn): string {
  return (column.columnType || column.dataType || '').toLowerCase();
}

function enumFirst(type: string): string | null {
  const match = /^(?:enum|set)\s*\(\s*'((?:[^']|'')*)'/i.exec(type);
  return match ? match[1].replace(/''/g, "'") : null;
}

function stripQuotes(value: string): string {
  return value.replace(/^\s*(['"`])(.*)\1\s*$/, '$2');
}

function isTimestampDefault(column: WorkspaceCodeDbColumn): boolean {
  return /current_timestamp|now\(\)|localtimestamp|sysdate/i.test(column.defaultValue ?? '');
}

function roleOf(column: WorkspaceCodeDbColumn, fkColumns: Set<string>): DbExplainRole {
  const name = column.name.toLowerCase();
  const type = typeOf(column);
  const uuidName = /^(uuid|guid)$/.test(name);
  if (column.primaryKey && column.autoIncrement) return 'auto';
  if (column.autoIncrement) return 'auto';
  if ((column.primaryKey || uuidName) && (/^(char\(36\)|binary\(16\)|uuid)/.test(type) || uuidName)) return 'uuid';
  if (fkColumns.has(column.name)) return 'fk';
  if (/on update current_timestamp/i.test(column.extra ?? '') || /^(updated|modified|actualizad|fecha_modif)/.test(name)) return 'updated';
  if (isTimestampDefault(column) || /^(created|creado|fecha_creacion|fecha_alta|inserted|registered|alta)/.test(name)) return 'now';
  if (/^(deleted|borrado|eliminado)(_at|_en)?/.test(name) && column.nullable) return 'deleted';
  if (/(password|contrasena|contraseña|hash)/.test(name)) return 'hash';
  if (/(token|api_?key|secret|salt|clave|private_key)/.test(name)) return 'secret';
  if (column.defaultValue !== null && column.defaultValue !== undefined) return 'default';
  if (column.nullable) return 'null';
  return 'input';
}

function inputValue(column: WorkspaceCodeDbColumn): string {
  const name = column.name.toLowerCase();
  const type = typeOf(column);
  const first = enumFirst(type);
  if (first !== null) return truncate(first);
  if (/^(tinyint\(1\)|bool|boolean|bit\(1\)|bit$)/.test(type)) return 'true';
  if (/datetime|timestamp/.test(type)) return '2026-10-03 10:15';
  if (/^date/.test(type)) return '2026-10-03';
  if (/^time/.test(type)) return '10:15';
  if (/json/.test(type)) return '{…}';
  if (/blob|binary|bytea|image/.test(type)) return '<binario>';
  if (/decimal|numeric|float|double|real|money/.test(type)) return /(precio|price|importe|amount|total)/.test(name) ? '19.99' : '9.99';
  if (/int|serial/.test(type)) return /(cantidad|qty|stock)/.test(name) ? '3' : '1';
  if (/email|correo/.test(name)) return 'ana@ejemplo.com';
  if (/^(nombre|name|first_name|username)/.test(name)) return 'Ana';
  if (/(apellido|last_name)/.test(name)) return 'García';
  if (/(titulo|title|asunto)/.test(name)) return 'Mi primer chat';
  if (/(desc|contenido|content|texto|mensaje|body)/.test(name)) return 'Hola';
  if (/(url|link|avatar|foto|imagen)/.test(name)) return 'https://…';
  if (/(tel|phone|movil)/.test(name)) return '+34 600 000 000';
  if (/(precio|price|importe|amount|total)/.test(name)) return '19.99';
  if (/(cantidad|qty|stock)/.test(name)) return '3';
  if (/text|char|string|enum|set/.test(type)) return '"texto"';
  return '…';
}

function sampleValue(column: WorkspaceCodeDbColumn, role: DbExplainRole, parentIds: Map<string, string>, fkByColumn: Map<string, WorkspaceCodeDbForeignKey>): string {
  switch (role) {
    case 'auto': return '42';
    case 'uuid': return '3f2b…a91c';
    case 'fk': {
      const fk = fkByColumn.get(column.name);
      return (fk && parentIds.get(fk.refTable)) || '1';
    }
    case 'now': case 'updated': return '2026-10-03 10:15';
    case 'hash': case 'secret': return '••••••';
    case 'null': case 'deleted': return 'NULL';
    case 'default': {
      const raw = stripQuotes(column.defaultValue ?? '');
      if (/^null$/i.test(raw)) return 'NULL';
      return truncate(raw || (enumFirst(typeOf(column)) ?? '""'));
    }
    default: return truncate(inputValue(column));
  }
}

interface ParentInfo {
  table: string;
  columns: string[];
  fks: WorkspaceCodeDbForeignKey[];
  owner: boolean;
  nullable: boolean;
}

export function buildLocalExplainScript(tables: WorkspaceCodeDbTable[], tableName: string, t: Translate): DbExplainScript | null {
  const target = tables.find((x) => x.name === tableName);
  if (!target) return null;
  const exists = new Set(tables.map((x) => x.name));
  const columnByName = new Map(target.columns.map((c) => [c.name, c]));
  const fkByColumn = new Map<string, WorkspaceCodeDbForeignKey>();
  for (const fk of target.foreignKeys) for (const column of fk.columns) if (!fkByColumn.has(column)) fkByColumn.set(column, fk);

  const steps: DbExplainStep[] = [];
  const push = (step: Omit<DbExplainStep, 'id' | 'icon'> & { icon?: string }) => {
    steps.push({ ...step, id: '', icon: step.icon ?? ICONS[step.kind] });
  };
  const finish = (summary: string, involved: string[], sample: DbExplainSampleCell[]): DbExplainScript => {
    steps.forEach((s, i) => { s.id = 's' + (i + 1); });
    return { table: target.name, source: 'local', summary, involved: [...new Set(involved)], sample, steps };
  };

  if (target.type === 'VIEW') {
    push({ kind: 'note', from: null, to: target.name, title: t('dbx.step.view.title', { table: target.name }), text: t('dbx.step.view.text', { table: target.name }), columns: [] });
    push({ kind: 'note', from: null, to: target.name, title: t('dbx.step.view2.title', { table: target.name }), text: t('dbx.step.view2.text', { table: target.name }), columns: [] });
    return finish(t('dbx.sum.view', { table: target.name }), [target.name], []);
  }

  // Padres: claves foráneas no reflexivas hacia tablas que existen, agrupadas por tabla referenciada.
  const parentMap = new Map<string, ParentInfo>();
  for (const fk of target.foreignKeys) {
    if (fk.refTable === target.name || !exists.has(fk.refTable)) continue;
    let info = parentMap.get(fk.refTable);
    if (!info) {
      info = { table: fk.refTable, columns: [], fks: [], owner: OWNER_TABLE.test(fk.refTable), nullable: false };
      parentMap.set(fk.refTable, info);
    }
    info.fks.push(fk);
    for (const column of fk.columns) if (!info.columns.includes(column)) info.columns.push(column);
  }
  for (const info of parentMap.values()) {
    if (info.columns.some((c) => OWNER_COLUMN.test(c))) info.owner = true;
    info.nullable = info.columns.some((c) => columnByName.get(c)?.nullable);
  }
  const parents = [...parentMap.values()].sort((a, b) =>
    Number(b.owner) - Number(a.owner) || Number(a.nullable) - Number(b.nullable) || a.table.localeCompare(b.table));
  const animated = parents.slice(0, MAX_PARENTS);
  const restParents = parents.slice(MAX_PARENTS);
  const owner = parents.find((p) => p.owner) ?? null;

  const children = [...new Set(target.referencedBy.filter((r) => r.table !== target.name && exists.has(r.table)).map((r) => r.table))].sort((a, b) => a.localeCompare(b));
  const shownChildren = children.slice(0, 3);
  const selfFk = target.foreignKeys.find((fk) => fk.refTable === target.name) ?? null;

  const fkColumns = new Set(target.foreignKeys.flatMap((fk) => fk.columns));
  const parentIds = new Map<string, string>(parents.map((p, i) => [p.table, SAMPLE_IDS[i % SAMPLE_IDS.length]]));
  const roles = new Map<string, DbExplainRole>();
  for (const column of target.columns) {
    let role = roleOf(column, fkColumns);
    if (role === 'fk' && fkByColumn.get(column.name)?.refTable === target.name && column.nullable) role = 'null';
    roles.set(column.name, role);
  }
  const rolesIn = (...wanted: DbExplainRole[]) => target.columns.filter((c) => wanted.includes(roles.get(c.name)!)).map((c) => c.name);
  const sample: DbExplainSampleCell[] = target.columns.map((c) => {
    const role = roles.get(c.name)!;
    return { column: c.name, role, value: sampleValue(c, role, parentIds, fkByColumn) };
  });

  // Tabla puente (N:M).
  const distinctParents = new Set(target.foreignKeys.filter((fk) => fk.refTable !== target.name).map((fk) => fk.refTable));
  const pkSubsetOfFk = target.primaryKey.length > 0 && target.primaryKey.every((c) => fkColumns.has(c));
  const plainColumns = target.columns.filter((c) => !c.primaryKey && !fkColumns.has(c.name) && !['now', 'updated'].includes(roles.get(c.name)!));
  const junction = distinctParents.size >= 2 && (pkSubsetOfFk || plainColumns.length <= 1);
  const junctionNames = [...distinctParents];

  const inputColumns = rolesIn('input');
  const t0 = { table: target.name };

  // 1. Empieza en la app.
  push({
    kind: 'actor', from: owner ? owner.table : ACTOR_APP, to: ACTOR_APP, title: t('dbx.step.start.title', t0), columns: [],
    text: junction
      ? t('dbx.step.start.junction', { ...t0, a: junctionNames[0], b: junctionNames[1] })
      : owner ? t('dbx.step.start.owner', { ...t0, parent: owner.table }) : t('dbx.step.start.generic', t0),
  });

  // 2. La app llama al backend.
  const fieldNames = inputColumns.slice(0, 4).join(', ');
  push({
    kind: 'request', from: ACTOR_APP, to: ACTOR_API, title: t('dbx.step.request.title', t0), columns: [],
    text: fieldNames ? t('dbx.step.request.text', { ...t0, fields: fieldNames }) : t('dbx.step.request.textNoFields', t0),
    endpoint: `POST /api/${kebab(target.name)}`, endpointGuess: true,
  });

  // 3. Un paso por cada padre animado.
  const covered = new Set<string>();
  for (const parent of animated) {
    const one = relationCardinality(target, parent.columns) === 'oneToOne';
    const ondelete = (parent.fks[0].onDelete ?? '').toUpperCase();
    let text = t(one ? 'dbx.step.parent.one' : 'dbx.step.parent.many', { table: target.name, cols: parent.columns.join(', '), parent: parent.table });
    const p = { table: target.name, parent: parent.table };
    if (parent.owner) text += t('dbx.step.parent.owner', p);
    text += t(parent.nullable ? 'dbx.step.parent.optional' : 'dbx.step.parent.required', p);
    text += t(ondelete === 'CASCADE' ? 'dbx.step.parent.cascade' : ondelete === 'SET NULL' ? 'dbx.step.parent.setNull' : 'dbx.step.parent.restrict', p);
    parent.columns.forEach((c) => covered.add(c));
    push({ kind: 'flow', from: parent.table, to: target.name, title: t('dbx.step.parent.title', { parent: parent.table }), text, columns: [...parent.columns] });
  }
  if (restParents.length) {
    const names = restParents.slice(0, 6).map((p) => '`' + p.table + '`').join(', ') + (restParents.length > 6 ? ', …' : '');
    push({
      kind: 'note', from: null, to: target.name, title: t('dbx.step.parentsMore.title'),
      text: t('dbx.step.parentsMore.text', { count: restParents.length, names }), columns: [],
    });
  }

  // 4. INSERT: los campos de entrada y las claves foráneas que aún no se han rellenado.
  const insertColumns = [...inputColumns, ...rolesIn('fk').filter((c) => !covered.has(c))];
  let colsText = [...inputColumns, ...rolesIn('fk')].slice(0, 5).map((c) => '`' + c + '`').join(', ');
  if (!colsText) colsText = target.columns.slice(0, 5).map((c) => '`' + c.name + '`').join(', ');
  push({ kind: 'insert', from: ACTOR_API, to: target.name, title: t('dbx.step.insert.title', t0), text: t('dbx.step.insert.text', { ...t0, cols: colsText }), columns: insertColumns });

  // 5. La base de datos completa el resto.
  const fillColumns = rolesIn('auto', 'uuid', 'now', 'updated', 'default', 'null', 'secret', 'hash', 'deleted');
  if (fillColumns.length) {
    const phrases = fillColumns.slice(0, 6).map((name) => {
      const role = roles.get(name)!;
      const value = sample.find((s) => s.column === name)?.value ?? '';
      return t('dbx.step.fill.' + role, { col: name, value });
    });
    push({ kind: 'fill', from: null, to: target.name, title: t('dbx.step.fill.title', t0), text: phrases.join('; ') + '.', columns: fillColumns });
  }

  // 6. Hijos.
  if (shownChildren.length) {
    push({
      kind: 'flow', from: target.name, to: shownChildren[0], title: t('dbx.step.children.title', t0), columns: [],
      text: t('dbx.step.children.text', { ...t0, names: joinNames(shownChildren, t) }),
    });
  }

  // 7. Auto-referencia.
  if (selfFk) {
    push({
      kind: 'flow', from: target.name, to: target.name, title: t('dbx.step.self.title', t0), columns: [],
      text: t('dbx.step.self.text', { ...t0, cols: selfFk.columns.join(', ') }),
    });
  }

  if (steps.length > MAX_STEPS) {
    const noteAt = steps.findIndex((s) => s.kind === 'note');
    if (noteAt >= 0) steps.splice(noteAt, 1);
  }
  if (steps.length > MAX_STEPS) steps.length = MAX_STEPS;

  let summary: string;
  if (junction) summary = t('dbx.sum.junction', { ...t0, a: junctionNames[0], b: junctionNames[1] });
  else if (owner) summary = t(relationCardinality(target, owner.columns) === 'oneToOne' ? 'dbx.sum.owner.one' : 'dbx.sum.owner.many', { ...t0, parent: owner.table });
  else if (parents.length) summary = t('dbx.sum.child', { ...t0, parents: joinNames(parents.slice(0, 3).map((p) => p.table), t) });
  else summary = t('dbx.sum.root', t0);

  return finish(summary, [target.name, ...animated.map((p) => p.table), ...(shownChildren.length ? [shownChildren[0]] : [])], sample);
}

/* ====================================================================
 * Mejora con IA
 * ==================================================================== */

/**
 * Combina la respuesta de la IA con el guion local: valida actores y tablas, filtra columnas al destino y toma el ejemplo
 * del guion local. Devuelve `null` si no queda ningún paso utilizable.
 */
export function mergeAiScript(base: DbExplainScript, tables: WorkspaceCodeDbTable[], response: DbExplainAiResponse): DbExplainScript | null {
  const names = new Set(tables.map((x) => x.name));
  const target = tables.find((x) => x.name === base.table);
  const targetColumns = new Set(target?.columns.map((c) => c.name) ?? []);
  const place = (value: string | null | undefined): string | null => {
    const v = (value ?? '').trim();
    if (!v) return null;
    return isExplainActor(v) || names.has(v) ? v : ACTOR_API;
  };
  const steps: DbExplainStep[] = [];
  for (const raw of response.steps ?? []) {
    const title = (raw.title ?? '').trim();
    const text = (raw.text ?? '').trim();
    if (!title && !text) continue;
    const kind: DbExplainKind = KINDS.includes(raw.kind as DbExplainKind) ? (raw.kind as DbExplainKind) : 'note';
    let columns = (raw.columns ?? []).filter((c) => targetColumns.has(c));
    const equivalent = base.steps.find((s) => s.kind === kind);
    if ((kind === 'insert' || kind === 'fill') && !columns.length) columns = [...(equivalent?.columns ?? [])];
    let endpoint = (raw.endpoint ?? '').trim() || null;
    let endpointGuess = false;
    if (kind === 'request' && !endpoint && equivalent?.endpoint) {
      endpoint = equivalent.endpoint;
      endpointGuess = !!equivalent.endpointGuess;
    }
    steps.push({
      id: 's' + (steps.length + 1), kind, from: place(raw.from), to: place(raw.to), title: title || text, text: text || title,
      endpoint, endpointGuess, columns, icon: ICONS[kind],
    });
    if (steps.length >= MAX_STEPS) break;
  }
  if (!steps.length) return null;
  const involved = [base.table];
  for (const step of steps) for (const end of [step.from, step.to]) if (end && names.has(end) && !involved.includes(end)) involved.push(end);
  return { table: base.table, source: 'ai', summary: (response.summary ?? '').trim() || base.summary, involved, sample: base.sample, steps };
}

/* ====================================================================
 * Reproductor
 * ==================================================================== */

/**
 * Avanza solo por los pasos con un temporizador (`setTimeout` fuera de la zona de Angular). `onChange` se llama tras cada
 * cambio de estado visible; el componente decide cómo entrar en la zona.
 */
export class DbExplainPlayer {
  index = 0;
  playing = false;
  finished = false;
  speed = 1;
  /** Cambia en cada paso: sirve para recrear globo, paquete y camino temporal y relanzar sus animaciones. */
  stepKey = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private remaining = 0;
  private destroyed = false;

  constructor(
    readonly steps: DbExplainStep[],
    private readonly onChange: () => void,
    private readonly outside: (fn: () => void) => void,
  ) {}

  get count(): number {
    return this.steps.length;
  }

  get step(): DbExplainStep | null {
    return this.steps[this.index] ?? null;
  }

  get atStart(): boolean {
    return this.index <= 0;
  }

  get atEnd(): boolean {
    return this.index >= this.steps.length - 1;
  }

  durationOf(i: number): number {
    const step = this.steps[i];
    if (!step) return 3000;
    const base = step.durationMs ?? Math.min(8000, Math.max(3000, 1600 + (step.title.length + step.text.length) * 32));
    return base / this.speed;
  }

  start(auto: boolean): void {
    this.go(0);
    if (auto) this.play();
  }

  go(i: number): void {
    if (this.destroyed || !this.steps.length) return;
    this.clear();
    this.index = Math.min(Math.max(i, 0), this.steps.length - 1);
    this.stepKey++;
    this.finished = false;
    this.remaining = this.durationOf(this.index);
    if (this.playing) this.arm(this.remaining);
    this.onChange();
  }

  next(): void {
    if (this.destroyed) return;
    if (this.atEnd) {
      this.clear();
      this.finished = true;
      this.playing = false;
      this.remaining = 0;
      this.onChange();
      return;
    }
    this.go(this.index + 1);
  }

  prev(): void {
    this.go(this.index - 1);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.destroyed) return;
    if (this.finished) this.go(0);
    this.playing = true;
    if (this.remaining < 400) this.remaining = this.durationOf(this.index);
    this.arm(this.remaining);
    this.onChange();
  }

  pause(): void {
    if (!this.playing) return;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    this.clear();
    this.playing = false;
    this.onChange();
  }

  restart(): void {
    this.go(0);
    this.play();
  }

  setSpeed(speed: number): void {
    if (!(speed > 0) || speed === this.speed) return;
    if (this.playing) this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    this.remaining = this.remaining * this.speed / speed;
    this.speed = speed;
    if (this.playing) this.arm(this.remaining);
    this.onChange();
  }

  destroy(): void {
    this.destroyed = true;
    this.playing = false;
    this.clear();
  }

  private arm(ms: number): void {
    this.clear();
    this.startedAt = Date.now();
    this.outside(() => {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.next();
      }, Math.max(0, ms));
    });
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
