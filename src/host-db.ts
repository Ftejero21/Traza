import * as vscode from 'vscode';
import type { Client as PgClient, ClientConfig as PgConfig } from 'pg';
import type { Connection as MysqlConnection, ConnectionOptions as MysqlOptions, RowDataPacket } from 'mysql2/promise';
import type {
  DbConnectionInfo,
  WorkspaceCodeDatabaseMetadata,
} from '../webview/src/app/bridge/protocol';
import type {
  WorkspaceCodeDbColumn,
  WorkspaceCodeDbForeignKey,
  WorkspaceCodeDbIndex,
  WorkspaceCodeDbTable,
} from '../webview/src/app/workspace-code/services/workspace-code-runtime.types';
import { DB_KEY_PATTERN, LOCAL_HOSTS, normalizeCodePath } from './host-guards';

/*
 * Conexiones de base de datos de la vista de flujo (modo «Base de datos»): configuración en `nexo.databases`, contraseña
 * en SecretStorage y lectura de la metadata (tablas, columnas, claves e índices) en SOLO LECTURA. Nunca se ejecuta SQL de
 * la IA ni se leen filas: solo consultas fijas y parametrizadas a `information_schema` / `pg_catalog`.
 */

export type DbProvider = 'postgresql' | 'mysql' | 'mariadb';

export interface DbConfig {
  id: string;
  name: string;
  provider: DbProvider;
  host: string;
  port: number;
  database: string;
  user: string;
  schema?: string;
  root?: string;
  ssl?: boolean;
}

const SETTING = 'databases';
const SECRET_PREFIX = 'nexo.db.password.';
const PROVIDERS: readonly DbProvider[] = ['postgresql', 'mysql', 'mariadb'];
const CACHE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_TABLES = 500;
const MAX_COLUMNS = 200;
const MAX_NAME = 128;
const NAME_PATTERN = /^[^\u0000-\u001f]{1,128}$/;
const HOST_PATTERN = /^[A-Za-z0-9.\-_:[\]]{1,253}$/;
const PG_FK_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

/** Error con un mensaje fijo en español, apto para la webview (nunca URL, usuario ni contraseña). */
class DbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbError';
  }
}

const MSG = {
  auth: 'Usuario o contraseña de la base de datos incorrectos.',
  database: 'La base de datos no existe.',
  host: 'No se pudo conectar con el servidor de la base de datos.',
  timeout: 'La base de datos ha tardado demasiado en responder.',
  provider: 'Proveedor de base de datos no soportado.',
  generic: 'No se pudo leer el esquema de la base de datos.',
  missing: 'No existe esa conexión de base de datos.',
  password: 'Falta la contraseña de la base de datos. Usa "Nexo: Contraseña de base de datos".',
  tls: 'Para un servidor remoto activa "ssl": solo se permite conexión sin TLS en localhost.',
};

function warn(message: string, error: unknown): void {
  console.warn(`[Nexo] ${message}`, error instanceof Error ? error.name : '');
}

function secretKey(id: string): string {
  return `${SECRET_PREFIX}${id}`;
}

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

/** Traduce un error del driver a un mensaje fijo. */
function translate(error: unknown): DbError {
  if (error instanceof DbError) return error;
  const e = (error ?? {}) as { code?: unknown; errno?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  if (['28P01', '28000', 'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_NOT_SUPPORTED_AUTH_MODE'].includes(code)) return new DbError(MSG.auth);
  if (['3D000', 'ER_BAD_DB_ERROR', '3F000'].includes(code)) return new DbError(MSG.database);
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(code)) return new DbError(MSG.host);
  if (['ETIMEDOUT', '57014', 'PROTOCOL_SEQUENCE_TIMEOUT'].includes(code)) return new DbError(MSG.timeout);
  if (error instanceof Error && /timeout/i.test(error.message)) return new DbError(MSG.timeout);
  return new DbError(MSG.generic);
}

/* ---------------------------- configuración ---------------------------- */

function str(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;
}

/** Entrada de `nexo.databases` validada; `null` si no es válida. */
function parseConfig(raw: unknown): DbConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o['id'], 40);
  const name = str(o['name'], MAX_NAME);
  const provider = o['provider'] as DbProvider;
  const host = str(o['host'], 253);
  const port = o['port'];
  const database = str(o['database'], MAX_NAME);
  const user = str(o['user'], MAX_NAME);
  if (!id || !DB_KEY_PATTERN.test(id) || !name || !NAME_PATTERN.test(name) || !PROVIDERS.includes(provider)) return null;
  if (!host || !HOST_PATTERN.test(host) || typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!database || !user) return null;
  const config: DbConfig = { id, name, provider, host, port, database, user };
  const schema = o['schema'] === undefined ? null : str(o['schema'], MAX_NAME);
  if (o['schema'] !== undefined && o['schema'] !== '' && !schema) return null;
  if (schema) config.schema = schema;
  if (typeof o['root'] === 'string' && o['root'].trim()) {
    const root = normalizeCodePath(o['root']);
    if (root === null) return null;
    config.root = root;
  }
  if (o['ssl'] !== undefined && typeof o['ssl'] !== 'boolean') return null;
  if (o['ssl'] === true) config.ssl = true;
  return config;
}

/** Conexiones válidas de `nexo.databases` (las inválidas o repetidas se ignoran con un aviso). */
export function readDbConfigs(): DbConfig[] {
  const raw = vscode.workspace.getConfiguration('nexo').get<unknown>(SETTING);
  const list = Array.isArray(raw) ? raw : [];
  const out: DbConfig[] = [];
  for (const item of list) {
    const config = parseConfig(item);
    if (!config || out.some((c) => c.id === config.id)) {
      console.warn('[Nexo] Conexión de base de datos no válida en "nexo.databases": se ignora.');
      continue;
    }
    out.push(config);
  }
  return out;
}

/* ---------------------------- metadata ---------------------------- */

function emptyColumn(name: string, position: number): WorkspaceCodeDbColumn {
  return {
    name, position, dataType: '', columnType: '', length: null, precision: null, scale: null, nullable: true, primaryKey: false,
    unique: false, autoIncrement: false, defaultValue: null, extra: null, comment: null,
  };
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean);
  return [];
}

/** Completa PK, únicas, `referencedBy` (invirtiendo las FK) e índices de las tablas. */
function finish(tables: Map<string, WorkspaceCodeDbTable>): WorkspaceCodeDbTable[] {
  for (const table of tables.values()) {
    const pk = new Set(table.primaryKey);
    const unique = new Set(table.indexes.filter((i) => i.unique && !i.primary && i.columns.length === 1).map((i) => i.columns[0]));
    for (const column of table.columns) {
      if (pk.has(column.name)) column.primaryKey = true;
      if (unique.has(column.name) || (pk.has(column.name) && table.primaryKey.length === 1)) column.unique = true;
    }
    for (const fk of table.foreignKeys) {
      const target = tables.get(fk.refTable);
      if (!target) continue;
      target.referencedBy.push({ name: fk.name, table: table.name, columns: fk.columns, refColumns: fk.refColumns, onDelete: fk.onDelete, onUpdate: fk.onUpdate });
    }
  }
  return [...tables.values()];
}

function newTable(name: string, view: boolean): WorkspaceCodeDbTable {
  return { name, type: view ? 'VIEW' : 'TABLE', engine: null, rowEstimate: null, comment: null, columns: [], primaryKey: [], foreignKeys: [], indexes: [], referencedBy: [] };
}

async function pgMetadata(config: DbConfig, password: string): Promise<WorkspaceCodeDatabaseMetadata> {
  const pg = await import('pg');
  const options: PgConfig = {
    host: config.host, port: config.port, database: config.database, user: config.user, password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c default_transaction_read_only=on -c statement_timeout=${QUERY_TIMEOUT_MS}`,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    application_name: 'nexo-vscode',
  };
  const client: PgClient = new pg.Client(options);
  client.on('error', (error: unknown) => warn('Error de la conexión PostgreSQL.', error));
  const schema = config.schema || 'public';
  try {
    await client.connect();
    const tablesRes = await client.query(
      `SELECT table_name::text AS table_name, table_type::text AS table_type FROM information_schema.tables
       WHERE table_schema = $1 AND table_type IN ('BASE TABLE', 'VIEW') ORDER BY table_name LIMIT ${MAX_TABLES}`, [schema]);
    const tables = new Map<string, WorkspaceCodeDbTable>();
    for (const row of tablesRes.rows) tables.set(text(row.table_name), newTable(text(row.table_name), text(row.table_type) === 'VIEW'));
    const columnsRes = await client.query(
      `SELECT table_name::text AS table_name, column_name::text AS column_name, ordinal_position, data_type::text AS data_type,
         udt_name::text AS udt_name, character_maximum_length, numeric_precision, numeric_scale, is_nullable::text AS is_nullable,
         column_default::text AS column_default, is_identity::text AS is_identity
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [schema]);
    for (const row of columnsRes.rows) {
      const table = tables.get(text(row.table_name));
      if (!table || table.columns.length >= MAX_COLUMNS) continue;
      const length = num(row.character_maximum_length);
      const dataType = text(row.data_type) === 'USER-DEFINED' ? text(row.udt_name) : text(row.data_type);
      const def = row.column_default === null || row.column_default === undefined ? null : text(row.column_default);
      const column = emptyColumn(text(row.column_name), num(row.ordinal_position) ?? table.columns.length + 1);
      column.dataType = dataType;
      column.columnType = dataType + (length ? `(${length})` : '');
      column.length = length;
      column.precision = num(row.numeric_precision);
      column.scale = num(row.numeric_scale);
      column.nullable = text(row.is_nullable) === 'YES';
      column.defaultValue = def;
      column.autoIncrement = text(row.is_identity) === 'YES' || (def !== null && def.startsWith('nextval('));
      table.columns.push(column);
    }
    const consRes = await client.query(
      `SELECT c.conname::text AS name, c.contype::text AS type, t.relname::text AS table_name,
         ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
         rt.relname::text AS ref_table,
         ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS ref_columns,
         c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update
       FROM pg_catalog.pg_constraint c
       JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid
       WHERE n.nspname = $1 AND c.contype IN ('p', 'u', 'f') ORDER BY t.relname, c.conname`, [schema]);
    for (const row of consRes.rows) {
      const table = tables.get(text(row.table_name));
      if (!table) continue;
      const columns = textArray(row.columns);
      const type = text(row.type);
      if (type === 'p') {
        table.primaryKey = columns;
        table.indexes.push({ name: text(row.name), unique: true, primary: true, columns, type: null });
      } else if (type === 'u') {
        table.indexes.push({ name: text(row.name), unique: true, primary: false, columns, type: null });
      } else if (type === 'f') {
        const fk: WorkspaceCodeDbForeignKey = {
          name: text(row.name), columns, refTable: text(row.ref_table), refColumns: textArray(row.ref_columns),
          onDelete: PG_FK_ACTIONS[text(row.on_delete)] ?? null, onUpdate: PG_FK_ACTIONS[text(row.on_update)] ?? null,
        };
        table.foreignKeys.push(fk);
      }
    }
    return { database: config.database, provider: 'postgresql', tables: finish(tables) };
  } finally {
    await client.end().catch((error: unknown) => warn('No se pudo cerrar la conexión PostgreSQL.', error));
  }
}

async function mysqlMetadata(config: DbConfig, password: string): Promise<WorkspaceCodeDatabaseMetadata> {
  const mysql = await import('mysql2/promise');
  const options: MysqlOptions = {
    host: config.host, port: config.port, database: config.database, user: config.user, password,
    connectTimeout: CONNECT_TIMEOUT_MS,
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  };
  let conn: MysqlConnection | null = null;
  try {
    conn = await mysql.createConnection(options);
    conn.on('error', (error: unknown) => warn('Error de la conexión MySQL.', error));
    await conn.query({ sql: 'SET SESSION TRANSACTION READ ONLY', timeout: QUERY_TIMEOUT_MS });
    const run = async (sql: string): Promise<RowDataPacket[]> => {
      const [rows] = await conn!.query<RowDataPacket[]>({ sql, timeout: QUERY_TIMEOUT_MS }, [config.database]);
      return rows;
    };
    const tables = new Map<string, WorkspaceCodeDbTable>();
    for (const row of await run(
      `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME LIMIT ${MAX_TABLES}`)) {
      tables.set(text(row['table_name']), newTable(text(row['table_name']), text(row['table_type']) === 'VIEW'));
    }
    for (const row of await run(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, ORDINAL_POSITION AS ordinal_position, DATA_TYPE AS data_type,
         COLUMN_TYPE AS column_type, CHARACTER_MAXIMUM_LENGTH AS char_length, NUMERIC_PRECISION AS num_precision,
         NUMERIC_SCALE AS num_scale, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, COLUMN_KEY AS column_key
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`)) {
      const table = tables.get(text(row['table_name']));
      if (!table || table.columns.length >= MAX_COLUMNS) continue;
      const column = emptyColumn(text(row['column_name']), num(row['ordinal_position']) ?? table.columns.length + 1);
      const extra = text(row['extra']);
      column.dataType = text(row['data_type']);
      column.columnType = text(row['column_type']) || column.dataType;
      column.length = num(row['char_length']);
      column.precision = num(row['num_precision']);
      column.scale = num(row['num_scale']);
      column.nullable = text(row['is_nullable']) === 'YES';
      column.defaultValue = row['column_default'] === null || row['column_default'] === undefined ? null : text(row['column_default']);
      column.autoIncrement = /auto_increment/i.test(extra);
      column.extra = extra || null;
      column.primaryKey = text(row['column_key']) === 'PRI';
      column.unique = text(row['column_key']) === 'UNI';
      table.columns.push(column);
    }
    const fks = new Map<string, { table: WorkspaceCodeDbTable; fk: WorkspaceCodeDbForeignKey }>();
    for (const row of await run(
      `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name, k.COLUMN_NAME AS column_name,
         k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column, r.DELETE_RULE AS on_delete, r.UPDATE_RULE AS on_update
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`)) {
      const table = tables.get(text(row['table_name']));
      if (!table) continue;
      const key = `${table.name}\u0000${text(row['name'])}`;
      let entry = fks.get(key);
      if (!entry) {
        entry = {
          table,
          fk: { name: text(row['name']), columns: [], refTable: text(row['ref_table']), refColumns: [], onDelete: text(row['on_delete']) || null, onUpdate: text(row['on_update']) || null },
        };
        fks.set(key, entry);
        table.foreignKeys.push(entry.fk);
      }
      entry.fk.columns.push(text(row['column_name']));
      entry.fk.refColumns.push(text(row['ref_column']));
    }
    const indexes = new Map<string, WorkspaceCodeDbIndex>();
    for (const row of await run(
      `SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, COLUMN_NAME AS column_name, INDEX_TYPE AS index_type
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 0
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`)) {
      const table = tables.get(text(row['table_name']));
      if (!table) continue;
      const name = text(row['index_name']);
      const key = `${table.name}\u0000${name}`;
      let index = indexes.get(key);
      if (!index) {
        index = { name, unique: true, primary: name === 'PRIMARY', columns: [], type: text(row['index_type']) || null };
        indexes.set(key, index);
        table.indexes.push(index);
      }
      index.columns.push(text(row['column_name']));
      if (index.primary) table.primaryKey = index.columns;
    }
    return { database: config.database, provider: config.provider, tables: finish(tables) };
  } finally {
    if (conn) await conn.end().catch((error: unknown) => warn('No se pudo cerrar la conexión MySQL.', error));
  }
}

/* ---------------------------- servicio ---------------------------- */

/** Lectura de metadata con caché de 60 s y una sola petición en curso por conexión. */
export class HostDb {
  private readonly cache = new Map<string, { at: number; meta: WorkspaceCodeDatabaseMetadata }>();
  private readonly pending = new Map<string, Promise<WorkspaceCodeDatabaseMetadata>>();
  private generation = 0;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Conexiones para la webview: sin host, usuario ni contraseña. */
  async list(): Promise<DbConnectionInfo[]> {
    const out: DbConnectionInfo[] = [];
    for (const config of readDbConfigs()) {
      const hasPassword = !!(await this.secrets.get(secretKey(config.id)));
      out.push({ key: config.id, name: config.name, provider: config.provider, database: config.database, root: config.root ?? '', hasPassword });
    }
    return out;
  }

  clearCache(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }

  async metadata(key: string, force = false): Promise<WorkspaceCodeDatabaseMetadata> {
    if (!DB_KEY_PATTERN.test(key)) throw new DbError(MSG.missing);
    const cached = this.cache.get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.meta;
    const running = this.pending.get(key);
    if (running) return running;
    const generation = this.generation;
    const promise = this.load(key).then((meta) => {
      if (generation === this.generation) this.cache.set(key, { at: Date.now(), meta });
      return meta;
    }).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** «Nexo: Probar conexión de base de datos»: número de tablas. */
  async test(key: string): Promise<number> {
    return (await this.metadata(key, true)).tables.length;
  }

  private async load(key: string): Promise<WorkspaceCodeDatabaseMetadata> {
    const config = readDbConfigs().find((c) => c.id === key);
    if (!config) throw new DbError(MSG.missing);
    if (!isLocalHost(config.host) && !config.ssl) throw new DbError(MSG.tls);
    const password = await this.secrets.get(secretKey(config.id));
    if (!password) throw new DbError(MSG.password);
    try {
      if (config.provider === 'postgresql') return await pgMetadata(config, password);
      if (config.provider === 'mysql' || config.provider === 'mariadb') return await mysqlMetadata(config, password);
      throw new DbError(MSG.provider);
    } catch (error: unknown) {
      warn('No se pudo leer la metadata de la base de datos.', error);
      throw translate(error);
    }
  }
}

/* ---------------------------- comandos ---------------------------- */

interface SpringCandidate {
  provider: DbProvider;
  host: string;
  port: number;
  database: string;
  user: string;
  root: string;
  file: string;
}

const JDBC = /^jdbc:(postgresql|mysql|mariadb):\/\/([^/:?#\s]+)(?::(\d{1,5}))?\/([^?;#\s/]+)/i;

/** Datasources de Spring (`application*.properties`): solo URL y usuario; nunca la contraseña. */
async function springCandidates(): Promise<SpringCandidate[]> {
  const out: SpringCandidate[] = [];
  let uris: vscode.Uri[] = [];
  try {
    uris = await vscode.workspace.findFiles('**/src/main/resources/application*.properties', '{**/node_modules/**,**/target/**,**/build/**}', 20);
  } catch (error: unknown) {
    warn('No se pudieron buscar los application.properties.', error);
    return out;
  }
  const multi = (vscode.workspace.workspaceFolders ?? []).length > 1;
  for (const uri of uris) {
    let content: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 256 * 1024) continue;
      content = new TextDecoder('utf-8').decode(bytes);
    } catch (error: unknown) {
      warn('No se pudo leer un application.properties.', error);
      continue;
    }
    let url = '';
    let user = '';
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('#') || line.startsWith('!')) continue;
      const match = /^spring\.datasource\.(url|username)\s*[=:]\s*(.*)$/.exec(line);
      if (!match || match[2].includes('${')) continue;
      if (match[1] === 'url') url = match[2].trim();
      else user = match[2].trim();
    }
    const jdbc = JDBC.exec(url);
    if (!jdbc) continue;
    const provider = jdbc[1].toLowerCase() as DbProvider;
    const rel = vscode.workspace.asRelativePath(uri, multi).replace(/\\/g, '/');
    const at = rel.indexOf('src/main/resources/');
    const root = normalizeCodePath(at > 0 ? rel.slice(0, at) : '') ?? '';
    out.push({
      provider, host: jdbc[2], port: jdbc[3] ? Number(jdbc[3]) : provider === 'postgresql' ? 5432 : 3306,
      database: jdbc[4], user: user.slice(0, MAX_NAME), root, file: rel,
    });
  }
  return out;
}

function settingsTarget(): vscode.ConfigurationTarget {
  return (vscode.workspace.workspaceFolders ?? []).length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/** Añade la conexión al ajuste conservando el resto de entradas tal cual. */
async function appendConfig(config: DbConfig): Promise<void> {
  const raw = vscode.workspace.getConfiguration('nexo').get<unknown>(SETTING);
  const list = Array.isArray(raw) ? [...raw] : [];
  await vscode.workspace.getConfiguration('nexo').update(SETTING, [...list, config], settingsTarget());
}

async function pickConnection(placeHolder: string): Promise<DbConfig | null> {
  const list = readDbConfigs();
  if (!list.length) {
    void vscode.window.showInformationMessage('No hay conexiones de base de datos. Usa "Nexo: Añadir conexión de base de datos".');
    return null;
  }
  const choice = await vscode.window.showQuickPick(
    list.map((c) => ({ label: c.name, description: `${c.provider} · ${c.database}`, config: c })),
    { placeHolder },
  );
  return choice?.config ?? null;
}

async function askPassword(secrets: vscode.SecretStorage, config: DbConfig): Promise<boolean> {
  const value = await vscode.window.showInputBox({
    title: `Contraseña de «${config.name}»`,
    prompt: 'Se guarda en el almacén seguro de VS Code (nunca en los ajustes).',
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) return false;
  if (!value) {
    await secrets.delete(secretKey(config.id));
    void vscode.window.showInformationMessage('Contraseña de la base de datos borrada.');
    return true;
  }
  await secrets.store(secretKey(config.id), value);
  void vscode.window.showInformationMessage('Contraseña de la base de datos guardada.');
  return true;
}

async function input(title: string, value: string, validate: (v: string) => string | null, prompt?: string): Promise<string | null> {
  const result = await vscode.window.showInputBox({ title, value, prompt, ignoreFocusOut: true, validateInput: (v) => validate(v.trim()) });
  return result === undefined ? null : result.trim();
}

async function addDatabase(secrets: vscode.SecretStorage, onChange: () => void): Promise<void> {
  const existing = readDbConfigs();
  const candidates = await springCandidates();
  let base: Partial<SpringCandidate> = {};
  if (candidates.length) {
    const choice = await vscode.window.showQuickPick(
      [
        ...candidates.map((c) => ({ label: `$(database) ${c.database}`, description: `${c.provider} · ${c.host}:${c.port}`, detail: c.file, candidate: c as SpringCandidate | null })),
        { label: '$(edit) Introducir los datos a mano', candidate: null },
      ],
      { placeHolder: 'Datasource detectado en el proyecto (solo URL y usuario)' },
    );
    if (!choice) return;
    base = choice.candidate ?? {};
  }
  const title = 'Nexo: Añadir conexión de base de datos';
  const id = await input(title, base.database ? base.database.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) : '',
    (v) => (!DB_KEY_PATTERN.test(v) ? 'Solo letras, números, "-" y "_" (1–40).' : existing.some((c) => c.id === v) ? 'Ya existe una conexión con ese id.' : null),
    'Identificador de la conexión');
  if (id === null) return;
  const name = await input(title, base.database ?? id, (v) => (v && v.length <= MAX_NAME ? null : 'Nombre obligatorio.'), 'Nombre visible');
  if (name === null) return;
  const providerPick = await vscode.window.showQuickPick(
    PROVIDERS.map((p) => ({ label: p, picked: p === base.provider })),
    { placeHolder: 'Proveedor' },
  );
  if (!providerPick) return;
  const provider = providerPick.label as DbProvider;
  const host = await input(title, base.host ?? 'localhost', (v) => (HOST_PATTERN.test(v) ? null : 'Host no válido.'), 'Host');
  if (host === null) return;
  const portText = await input(title, String(base.port ?? (provider === 'postgresql' ? 5432 : 3306)),
    (v) => (/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? null : 'Puerto no válido.'), 'Puerto');
  if (portText === null) return;
  const database = await input(title, base.database ?? '', (v) => (v && v.length <= MAX_NAME ? null : 'Base de datos obligatoria.'), 'Base de datos');
  if (database === null) return;
  const user = await input(title, base.user ?? '', (v) => (v && v.length <= MAX_NAME ? null : 'Usuario obligatorio.'), 'Usuario (solo lectura recomendado)');
  if (user === null) return;
  let schema: string | undefined;
  if (provider === 'postgresql') {
    const value = await input(title, 'public', (v) => (v && v.length <= MAX_NAME ? null : 'Esquema obligatorio.'), 'Esquema');
    if (value === null) return;
    schema = value;
  }
  let ssl = false;
  if (!isLocalHost(host)) {
    const sslPick = await vscode.window.showQuickPick(
      [{ label: 'Usar TLS (obligatorio para servidores remotos)', ssl: true }, { label: 'Cancelar', ssl: false }],
      { placeHolder: 'Conexión remota' },
    );
    if (!sslPick?.ssl) return;
    ssl = true;
  }
  const root = await input(title, base.root ?? '', (v) => (!v || normalizeCodePath(v) !== null ? null : 'Ruta no válida.'),
    'Carpeta del proyecto que usa esta base de datos (vacío = todas)');
  if (root === null) return;
  const config: DbConfig = { id, name, provider, host, port: Number(portText), database, user, root: normalizeCodePath(root) ?? '', ssl };
  if (schema) config.schema = schema;
  try {
    await appendConfig(config);
  } catch (error: unknown) {
    warn('No se pudo guardar la conexión.', error);
    void vscode.window.showErrorMessage('No se pudo guardar la conexión de base de datos.');
    return;
  }
  await askPassword(secrets, config);
  onChange();
  void vscode.window.showInformationMessage(`Conexión «${name}» añadida.`);
}

async function removeDatabase(secrets: vscode.SecretStorage, onChange: () => void): Promise<void> {
  const config = await pickConnection('Conexión que quieres quitar');
  if (!config) return;
  const raw = vscode.workspace.getConfiguration('nexo').get<unknown>(SETTING);
  const list = (Array.isArray(raw) ? raw : []).filter((item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === config.id));
  try {
    await vscode.workspace.getConfiguration('nexo').update(SETTING, list, settingsTarget());
    await secrets.delete(secretKey(config.id));
  } catch (error: unknown) {
    warn('No se pudo quitar la conexión.', error);
    void vscode.window.showErrorMessage('No se pudo quitar la conexión de base de datos.');
    return;
  }
  onChange();
  void vscode.window.showInformationMessage(`Conexión «${config.name}» quitada.`);
}

async function testDatabase(db: HostDb): Promise<void> {
  const config = await pickConnection('Conexión que quieres probar');
  if (!config) return;
  try {
    const tables = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Probando «${config.name}»…` },
      () => db.test(config.id),
    );
    void vscode.window.showInformationMessage(`Conexión «${config.name}» correcta: ${tables} tablas.`);
  } catch (error: unknown) {
    void vscode.window.showErrorMessage(error instanceof DbError ? error.message : MSG.generic);
  }
}

/**
 * Comandos de las conexiones de base de datos. `onChange` limpia la caché de metadata (del panel abierto y la propia de
 * los comandos).
 */
export function registerDbCommands(context: vscode.ExtensionContext, onChange: () => void): vscode.Disposable[] {
  const db = new HostDb(context.secrets);
  const changed = () => {
    db.clearCache();
    onChange();
  };
  return [
    vscode.commands.registerCommand('nexo.addDatabase', () => addDatabase(context.secrets, changed)),
    vscode.commands.registerCommand('nexo.setDatabasePassword', async () => {
      const config = await pickConnection('Conexión cuya contraseña quieres cambiar');
      if (config && (await askPassword(context.secrets, config))) changed();
    }),
    vscode.commands.registerCommand('nexo.testDatabase', () => testDatabase(db)),
    vscode.commands.registerCommand('nexo.removeDatabase', () => removeDatabase(context.secrets, changed)),
  ];
}
