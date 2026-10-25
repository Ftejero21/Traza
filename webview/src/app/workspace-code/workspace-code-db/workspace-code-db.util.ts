import { WorkspaceCodeDbColumn, WorkspaceCodeDbTable } from '../services/workspace-code-runtime.types';

/* Copia parcial de chatFront `workspace-code-db/workspace-code-db.util.ts` (solo lo que usa el diagrama del flujo). */

export function isForeignKeyColumn(table: WorkspaceCodeDbTable, column: string): boolean {
  return table.foreignKeys.some((fk) => fk.columns.includes(column));
}

/** Cardinalidad de una relación según las columnas FK de la tabla de origen: uno a uno si coinciden con la PK o un índice único. */
export function relationCardinality(table: WorkspaceCodeDbTable | null, columns: string[]): 'oneToOne' | 'manyToOne' {
  if (!table || !columns.length) return 'manyToOne';
  const same = (cols: string[]) => cols.length === columns.length && cols.every((c) => columns.includes(c));
  if (table.primaryKey.length && same(table.primaryKey)) return 'oneToOne';
  return table.indexes.some((i) => (i.unique || i.primary) && same(i.columns)) ? 'oneToOne' : 'manyToOne';
}

/** Tipo corto para el diagrama y el árbol (varchar(255) -> varchar(255), bigint unsigned -> bigint unsigned). */
export function shortType(column: WorkspaceCodeDbColumn): string {
  return column.columnType || column.dataType;
}
