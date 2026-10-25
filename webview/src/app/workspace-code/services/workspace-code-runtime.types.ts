/*
 * Copia parcial de chatFront `services/workspace-code-runtime.types.ts`: solo la metadata de base de datos (tablas,
 * columnas, claves e índices) que usan el modo «Base de datos» del flujo y el diagrama de tablas.
 */


export interface WorkspaceCodeDbColumn {
  name: string;
  position: number;
  dataType: string;
  columnType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue: string | null;
  extra: string | null;
  comment: string | null;
}

export interface WorkspaceCodeDbForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface WorkspaceCodeDbIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
  type: string | null;
}

export interface WorkspaceCodeDbReference {
  name: string;
  table: string;
  columns: string[];
  refColumns: string[];
  onDelete: string | null;
  onUpdate: string | null;
}

export interface WorkspaceCodeDbTable {
  name: string;
  type: 'TABLE' | 'VIEW';
  engine: string | null;
  rowEstimate: number | null;
  comment: string | null;
  columns: WorkspaceCodeDbColumn[];
  primaryKey: string[];
  foreignKeys: WorkspaceCodeDbForeignKey[];
  indexes: WorkspaceCodeDbIndex[];
  referencedBy: WorkspaceCodeDbReference[];
}

export interface WorkspaceCodeDatabaseMetadata {
  database: string | null;
  provider: string;
  tables: WorkspaceCodeDbTable[];
}
