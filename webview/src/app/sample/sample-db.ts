import { DbConnectionInfo } from '../bridge/protocol';
import { FlowDbMap } from '../workspace-code/ai/nexo-ia.types';
import { WorkspaceCodeDatabaseMetadata, WorkspaceCodeDbColumn } from '../workspace-code/services/workspace-code-runtime.types';

/*
 * Base de datos del ejemplo (modo navegador): una conexión configurada con su esquema real (solo metadata) y el mapa
 * de datos que devolvería Nexo IA para el flujo del login.
 */

function column(position: number, name: string, dataType: string, columnType: string, extra: Partial<WorkspaceCodeDbColumn> = {}): WorkspaceCodeDbColumn {
  return {
    name, position, dataType, columnType, length: null, precision: null, scale: null, nullable: true, primaryKey: false,
    unique: false, autoIncrement: false, defaultValue: null, extra: null, comment: null, ...extra,
  };
}

export const SAMPLE_DB_CONNECTIONS: DbConnectionInfo[] = [
  { key: 'sample-freesocial', name: 'freesocial (ejemplo)', provider: 'postgresql', database: 'freesocial', root: 'backend', hasPassword: true },
];

export const SAMPLE_DB_METADATA: Record<string, WorkspaceCodeDatabaseMetadata> = {
  'sample-freesocial': {
    database: 'freesocial',
    provider: 'postgresql',
    tables: [
      {
        name: 'usuario',
        type: 'TABLE',
        engine: null,
        rowEstimate: null,
        comment: null,
        columns: [
          column(1, 'id', 'bigint', 'bigint', { nullable: false, primaryKey: true, autoIncrement: true, defaultValue: "nextval('usuario_id_seq'::regclass)" }),
          column(2, 'email', 'varchar', 'varchar(255)', { length: 255, nullable: false, unique: true }),
          column(3, 'password', 'varchar', 'varchar(255)', { length: 255, nullable: false }),
          column(4, 'nombre', 'varchar', 'varchar(100)', { length: 100 }),
          column(5, 'apellido', 'varchar', 'varchar(100)', { length: 100 }),
          column(6, 'rol_id', 'bigint', 'bigint'),
          column(7, 'created_at', 'timestamp', 'timestamp'),
        ],
        primaryKey: ['id'],
        foreignKeys: [
          { name: 'fk_usuario_rol', columns: ['rol_id'], refTable: 'rol', refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' },
        ],
        indexes: [
          { name: 'usuario_pkey', unique: true, primary: true, columns: ['id'], type: null },
          { name: 'uk_usuario_email', unique: true, primary: false, columns: ['email'], type: null },
        ],
        referencedBy: [],
      },
      {
        name: 'rol',
        type: 'TABLE',
        engine: null,
        rowEstimate: null,
        comment: null,
        columns: [
          column(1, 'id', 'bigint', 'bigint', { nullable: false, primaryKey: true, autoIncrement: true, defaultValue: "nextval('rol_id_seq'::regclass)" }),
          column(2, 'nombre', 'varchar', 'varchar(50)', { length: 50, nullable: false }),
        ],
        primaryKey: ['id'],
        foreignKeys: [],
        indexes: [{ name: 'rol_pkey', unique: true, primary: true, columns: ['id'], type: null }],
        referencedBy: [
          { name: 'fk_usuario_rol', table: 'usuario', columns: ['rol_id'], refColumns: ['id'], onDelete: 'NO ACTION', onUpdate: 'NO ACTION' },
        ],
      },
    ],
  },
};

/** Respuesta de `POST …/flow/db-map` del ejemplo (pasa por `sanitizeFlowDbMap` como la real). */
export const SAMPLE_DB_MAP: FlowDbMap = {
  summary: 'El login solo lee la tabla `usuario`: busca la fila por `email` y compara la contraseña guardada.',
  tables: [
    {
      name: 'usuario',
      entity: 'Usuario',
      columns: [
        { name: 'id', type: 'bigint', pk: true, nullable: false },
        { name: 'email', type: 'varchar(255)', pk: false, nullable: false },
        { name: 'password', type: 'varchar(255)', pk: false, nullable: false },
        { name: 'nombre', type: 'varchar(100)', pk: false },
        { name: 'apellido', type: 'varchar(100)', pk: false },
        { name: 'rol_id', type: 'bigint', pk: false },
        { name: 'created_at', type: 'timestamp', pk: false },
      ],
    },
    {
      name: 'rol',
      entity: 'Rol',
      columns: [
        { name: 'id', type: 'bigint', pk: true, nullable: false },
        { name: 'nombre', type: 'varchar(50)', pk: false },
      ],
    },
  ],
  relations: [{ from: 'usuario', fromColumn: 'rol_id', to: 'rol', toColumn: 'id' }],
  accesses: [
    {
      stepId: 's5',
      table: 'usuario',
      op: 'SELECT',
      direction: 'fromDb',
      columns: ['id', 'email', 'password', 'rol_id'],
      values: { email: 'loginDTO.email' },
      fn: 'UsuarioRepository.findByEmail',
      note: 'Busca el usuario por email antes de comprobar la contraseña.',
    },
  ],
};
