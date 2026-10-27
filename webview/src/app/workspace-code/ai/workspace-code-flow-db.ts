import { FlowDbAccess, FlowDbMap, FlowDiagram, FlowStep } from './nexo-ia.types';
import {
  WorkspaceCodeDatabaseMetadata,
  WorkspaceCodeDbColumn,
  WorkspaceCodeDbForeignKey,
  WorkspaceCodeDbTable,
} from '../services/workspace-code-runtime.types';
import { ACTOR_API, DbExplainScript, DbExplainStep } from '../workspace-code-db/workspace-code-db-explain';

/**
 * Modo «Base de datos» del flujo de Nexo IA: lógica pura (sin Angular). Detecta si el flujo toca la base de datos,
 * elige los pasos de datos, deduce tablas candidatas del código, construye el esquema (real o virtual) que pinta el
 * diagrama de tablas y el guion conducido por el reproductor del flujo (un paso del guion por cada paso con acceso).
 */

type Translate = (key: string, params?: Record<string, string | number>) => string;

const DB_TEXT = /(Repository|Repo|Dao|Mapper|EntityManager|JdbcTemplate|Jpa|Query|Entity)\b|\bfindBy|\bsave(All|AndFlush)?\b|\bdelete(By)?\b|\b(SELECT|INSERT|UPDATE)\b/i;
const REPOSITORY_GENERIC = /(?:Jpa|Crud|PagingAndSorting|Mongo)?Repository<\s*(\w+)\s*,/g;
const TABLE_ANNOTATION = /@Table\s*\(\s*(?:name\s*=\s*)?"([\w$.]+)"/g;
const SQL_TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+[`"[]?([A-Za-z_][\w$]*)/gi;
const MAX_DB_STEPS = 8;
const MAX_ENTITIES = 4;
const MAX_TEXT = 200;
const MAX_VIRTUAL_COLUMNS = 24;

const OP_ICONS: Record<string, string> = {
  SELECT: 'bi-search', INSERT: 'bi-box-seam', UPDATE: 'bi-pencil-square', DELETE: 'bi-trash3', UPSERT: 'bi-arrow-repeat',
};

/** El paso toca la base de datos: carril `db`, paso `sql` o clase/función/etiqueta de acceso a datos. */
export function isDbStep(flow: FlowDiagram, step: FlowStep): boolean {
  if (step.kind === 'sql') return true;
  const dbLanes = new Set(flow.lanes.filter((l) => l.kind === 'db').map((l) => l.id));
  if (dbLanes.has(step.from) || dbLanes.has(step.to)) return true;
  return [step.ref?.className, step.ref?.functionName, step.label].some((text) => !!text && DB_TEXT.test(text));
}

/** El flujo toca la base de datos (habilita la pestaña «Base de datos»). */
export function flowHasDb(flow: FlowDiagram | null): boolean {
  if (!flow) return false;
  if (flow.lanes.some((l) => l.kind === 'db')) return true;
  return flow.steps.some((s) => isDbStep(flow, s));
}

/** Índices de los pasos de datos y de su paso anterior (como mucho 8, en orden). */
export function dbStepIndexes(flow: FlowDiagram): number[] {
  const out = new Set<number>();
  flow.steps.forEach((step, i) => {
    if (!isDbStep(flow, step)) return;
    if (i > 0) out.add(i - 1);
    out.add(i);
  });
  return [...out].sort((a, b) => a - b).slice(0, MAX_DB_STEPS);
}

/** Entidades de los repositorios genéricos (`JpaRepository<User, Long>` → `User`), como mucho 4. */
export function repositoryEntities(texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const match of text.matchAll(REPOSITORY_GENERIC)) {
      const name = match[1];
      if (!out.includes(name)) out.push(name);
      if (out.length >= MAX_ENTITIES) return out;
    }
  }
  return out;
}

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
}

/** Nombres de tabla candidatos (en minúsculas): entidades en snake_case y plural, `@Table(name=…)` y SQL de las ventanas. */
export function candidateTableNames(texts: string[], entities: string[]): Set<string> {
  const out = new Set<string>();
  for (const entity of entities) {
    const s = snake(entity);
    for (const name of [s, `${s}s`, `${s}es`, entity.toLowerCase()]) out.add(name);
  }
  for (const text of texts) {
    for (const match of text.matchAll(TABLE_ANNOTATION)) out.add(match[1].split('.').pop()!.toLowerCase());
    for (const match of text.matchAll(SQL_TABLE)) out.add(match[1].toLowerCase());
  }
  return out;
}

/** Nombre sin mayúsculas ni separadores (fechaCreacion ≡ fecha_creacion). */
function normName(name: string): string {
  return name.replace(/[_\-\s]/g, '').toLowerCase();
}

function virtualColumn(name: string, type: string, pk: boolean, nullable: boolean | undefined, position: number): WorkspaceCodeDbColumn {
  return {
    name, position, dataType: type, columnType: type, length: null, precision: null, scale: null,
    nullable: nullable ?? !pk, primaryKey: pk, unique: false, autoIncrement: false, defaultValue: null, extra: null, comment: null,
  };
}

/**
 * Esquema del diagrama: cada tabla del mapa se resuelve contra el esquema real (sin distinguir mayúsculas; el real manda
 * en nombres, tipos, PK y FK) o, si no existe, como tabla virtual con las columnas del mapa y FK `ai_fk_${i}` de sus
 * relaciones. Solo entran las tablas con algún acceso (`table` o `via`); una tabla accedida que no esté en el mapa pero sí
 * en el esquema real se incluye desde el real. Las relaciones (FK reales y virtuales, `referencedBy`) se limitan a las
 * tablas mostradas. Los accesos se reescriben con los nombres canónicos y pierden las columnas desconocidas.
 */
export function buildFlowDbSchema(map: FlowDbMap, real: WorkspaceCodeDatabaseMetadata | null): { meta: WorkspaceCodeDatabaseMetadata; accesses: FlowDbAccess[] } {
  const realByLower = new Map((real?.tables ?? []).map((t) => [t.name.toLowerCase(), t]));
  const wanted = new Set<string>();
  for (const access of map.accesses) {
    for (const ref of [access.table, access.via]) {
      const lower = ref?.trim().toLowerCase();
      if (lower) wanted.add(lower);
    }
  }
  /** Nombre del mapa en minúsculas → nombre canónico. */
  const canonical = new Map<string, string>();
  // `source` es nulo solo en tablas reales accedidas que el mapa no declara; las virtuales siempre lo tienen.
  const picked: { source: FlowDbMap['tables'][number] | null; realTable: WorkspaceCodeDbTable | null }[] = [];
  for (const table of map.tables) {
    const lower = table.name.toLowerCase();
    if (!wanted.has(lower)) continue;
    const realTable = realByLower.get(lower) ?? null;
    const name = realTable?.name ?? table.name;
    if ([...canonical.values()].includes(name)) {
      canonical.set(lower, name);
      continue;
    }
    canonical.set(lower, name);
    picked.push({ source: table, realTable });
  }
  for (const lower of wanted) {
    if (canonical.has(lower)) continue;
    const realTable = realByLower.get(lower);
    if (!realTable) continue;
    canonical.set(lower, realTable.name);
    if (picked.some((p) => p.realTable?.name === realTable.name)) continue;
    picked.push({ source: null, realTable });
  }
  const names = new Set(canonical.values());
  const columnOf = (tables: Map<string, WorkspaceCodeDbTable>, table: string, column: string): string | null => {
    const t = tables.get(table);
    if (!t) return null;
    const lower = column.toLowerCase();
    const norm = normName(column);
    return t.columns.find((c) => c.name === column)?.name ?? t.columns.find((c) => c.name.toLowerCase() === lower)?.name
      ?? (norm ? t.columns.find((c) => normName(c.name) === norm)?.name : undefined) ?? null;
  };

  // Primera pasada: columnas (sin claves foráneas de las virtuales).
  const tables = new Map<string, WorkspaceCodeDbTable>();
  for (const { source, realTable } of picked) {
    if (realTable) {
      tables.set(realTable.name, { ...realTable, foreignKeys: realTable.foreignKeys.filter((fk) => names.has(fk.refTable)), referencedBy: [] });
      continue;
    }
    if (!source) continue;
    const columns = source.columns.map((c, i) => virtualColumn(c.name, c.type, c.pk, c.nullable, i + 1));
    // Unión con las columnas de todos los accesos (leídas, escritas, filtradas y claves de `values`).
    const known = new Set(columns.map((c) => normName(c.name)));
    for (const access of map.accesses) {
      if (canonical.get(access.table.toLowerCase()) !== source.name) continue;
      for (const name of [...access.columns, ...Object.keys(access.values ?? {})]) {
        const clean = name.trim();
        const key = normName(clean);
        if (!clean || !key || known.has(key) || columns.length >= MAX_VIRTUAL_COLUMNS) continue;
        known.add(key);
        columns.push(virtualColumn(clean, '', false, undefined, columns.length + 1));
      }
    }
    tables.set(source.name, {
      name: source.name, type: 'TABLE', engine: null, rowEstimate: null, comment: source.entity ?? null, columns,
      primaryKey: columns.filter((c) => c.primaryKey).map((c) => c.name), foreignKeys: [], indexes: [], referencedBy: [],
    });
  }

  // Segunda pasada: FK de las tablas virtuales a partir de las relaciones del mapa.
  map.relations.forEach((rel, i) => {
    const from = canonical.get(rel.from.toLowerCase());
    const to = canonical.get(rel.to.toLowerCase());
    if (!from || !to) return;
    const fromTable = tables.get(from);
    // Las tablas reales conservan solo sus FK reales.
    if (!fromTable || picked.some((p) => p.realTable?.name === from)) return;
    const fromColumn = columnOf(tables, from, rel.fromColumn);
    const toColumn = columnOf(tables, to, rel.toColumn);
    if (!fromColumn || !toColumn) return;
    const fk: WorkspaceCodeDbForeignKey = { name: `ai_fk_${i}`, columns: [fromColumn], refTable: to, refColumns: [toColumn], onDelete: null, onUpdate: null };
    fromTable.foreignKeys = [...fromTable.foreignKeys, fk];
  });

  // `referencedBy` de todas, calculado desde las FK finales.
  for (const table of tables.values()) {
    for (const fk of table.foreignKeys) {
      const target = tables.get(fk.refTable);
      if (!target) continue;
      target.referencedBy = [...target.referencedBy, {
        name: fk.name, table: table.name, columns: fk.columns, refColumns: fk.refColumns, onDelete: fk.onDelete, onUpdate: fk.onUpdate,
      }];
    }
  }

  const accesses: FlowDbAccess[] = [];
  for (const access of map.accesses) {
    const table = canonical.get(access.table.toLowerCase());
    if (!table || !tables.has(table)) continue;
    const columns = [...new Set(access.columns.map((c) => columnOf(tables, table, c)).filter((c): c is string => !!c))];
    const out: FlowDbAccess = { ...access, table, columns };
    if (access.values) {
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(access.values)) {
        const column = columnOf(tables, table, key);
        if (column) values[column] = value;
      }
      if (Object.keys(values).length) out.values = values;
      else delete out.values;
    }
    const via = access.via ? canonical.get(access.via.toLowerCase()) : null;
    if (via && tables.has(via) && via !== table) out.via = via;
    else delete out.via;
    accesses.push(out);
  }

  const meta: WorkspaceCodeDatabaseMetadata = {
    database: real?.database ?? null,
    provider: real?.provider ?? 'ai',
    tables: [...tables.values()],
  };
  return { meta, accesses };
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Guion conducido por el reproductor del flujo: un paso por cada paso del flujo con acceso válido (tabla conocida), en
 * orden. `indexes[k]` es el índice en el flujo del paso `k` del guion. Cada paso va de la función que hace la operación
 * («Backend (API)», etiquetada `fn()`) a la tabla, o por la arista FK si hay `via`; al revés si `direction === 'fromDb'`.
 */
export function buildFlowDbScript(flow: FlowDiagram, accesses: FlowDbAccess[], tables: WorkspaceCodeDbTable[], t: Translate,
  summary = '', note = ''): { script: DbExplainScript; indexes: number[] } {
  const byStep = new Map(accesses.map((a) => [a.stepId, a]));
  const known = new Set(tables.map((x) => x.name));
  const steps: DbExplainStep[] = [];
  const indexes: number[] = [];

  flow.steps.forEach((step, i) => {
    const access = byStep.get(step.id);
    if (!access || !known.has(access.table)) return;
    const toDb = access.direction !== 'fromDb';
    const other = access.via && known.has(access.via) ? access.via : ACTOR_API;
    const fn = access.fn ? access.fn.replace(/\(\)\s*$/, '') || null : null;
    const columns = [...new Set([...access.columns, ...Object.keys(access.values ?? {})])];
    const out: DbExplainStep = {
      id: 's' + (steps.length + 1),
      kind: access.op === 'INSERT' ? 'insert' : 'request',
      from: toDb ? other : access.table,
      to: toDb ? access.table : other,
      title: t('aiFlow.db.step.title', { op: access.op, table: access.table }),
      text: clip(access.note || (fn ? t('aiFlow.db.step.text', { fn, op: access.op, table: access.table }) : step.title)),
      columns,
      icon: OP_ICONS[access.op] ?? 'bi-database',
      table: access.table,
      op: access.op,
      fn,
    };
    if (access.values) out.values = { ...access.values };
    steps.push(out);
    indexes.push(i);
  });

  const script: DbExplainScript = {
    table: steps[0]?.table ?? tables[0]?.name ?? '',
    source: 'ai',
    summary,
    involved: tables.map((x) => x.name),
    sample: [],
    steps,
    title: flow.title,
    note,
  };
  return { script, indexes };
}
