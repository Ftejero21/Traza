/**
 * Protocolo tipado entre el host de la extensión y la webview. Solo tipos (sin imports de Angular): lo importan
 * tanto la webview como el host (`src/*.ts`).
 */
import type { WorkspaceCodeDatabaseMetadata } from '../workspace-code/services/workspace-code-runtime.types';

export type { WorkspaceCodeDatabaseMetadata };

export type FlowKind = 'simulate' | 'logs' | 'ui-plan' | 'db-map';
export type NexoLanguage = 'es' | 'en';

/** Apariencia de la vista: paleta y fuentes originales de Nexo, o los colores y fuentes del tema de VS Code. */
export type NexoTheme = 'nexo' | 'vscode';
export type NotifyLevel = 'info' | 'success' | 'warning' | 'danger';

export interface FlowRequestBody {
  language: NexoLanguage;
  contextBase64: string;
}

/** Cuerpo de la comparación antes/después de una propuesta (`compareChange`). */
export interface ChangeCompareBody {
  flowId: string;
  language: NexoLanguage;
  contextBase64: string;
}

/** Escritura de un archivo del workspace (`content: null` = borrar). */
export interface ApplyFileWrite {
  path: string;
  content: string | null;
  line?: number;
}

export interface ApplyFilesResult {
  ok: boolean;
  error?: string;
}

/** Conexión de base de datos configurada en VS Code (sin host, usuario ni contraseña). */
export interface DbConnectionInfo {
  key: string;
  name: string;
  provider: string;
  database: string | null;
  root: string;
  hasPassword: boolean;
}

export type BridgeRequest =
  | { op: 'listFiles' }
  | { op: 'readFile'; fileId: string; as: 'text' | 'base64'; maxBytes?: number }
  | { op: 'readMountFile'; mountId: string; path: string; as: 'text' | 'base64'; maxBytes: number }
  | { op: 'flow'; kind: FlowKind; body: FlowRequestBody }
  | { op: 'copy'; text: string }
  | { op: 'compareChange'; proposalId: string; body: ChangeCompareBody }
  | { op: 'dbExplain'; body: { language: NexoLanguage; contextBase64: string } }
  | { op: 'applyFiles'; writes: ApplyFileWrite[] }
  | { op: 'confirm'; title: string; message: string; confirm: string }
  | { op: 'dbConnections' }
  | { op: 'dbMetadata'; key: string };

export type BridgeOp = BridgeRequest['op'];

export interface SampleDocument {
  path: string;
  content: string;
  language: string;
}

export type WebviewToHost =
  | { type: 'ready' }
  | ({ type: 'request'; id: string } & BridgeRequest)
  | { type: 'cancel'; id: string }
  | { type: 'openRef'; fileId: string; line: number; sample?: SampleDocument }
  | { type: 'notify'; level: NotifyLevel; text: string }
  | { type: 'ask'; text: string };

export type HostToWebview =
  | { type: 'init' | 'config'; language: NexoLanguage; modelName: string | null; theme: NexoTheme }
  | {
    type: 'openFlow'; flow: unknown; sample: boolean; step?: number; mode?: 'walk' | 'sim' | 'logs' | 'db' | 'changes'; proposals?: unknown[];
    /** Flujo recién generado con el modelo de VS Code (abre su escenario, si lo trae, en «Simular»). */
    source?: { model: string | null };
  }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'filesChanged' }
  | { type: 'fileSaved' };

export interface ProjectMountInfo {
  id: string;
  name: string;
  alias: string;
  path: string;
}

export interface ProjectFileInfo {
  id: string;
  path: string;
  name: string;
  extension: string;
  binary: boolean;
}

export interface ProjectSnapshot {
  mounts: ProjectMountInfo[];
  files: ProjectFileInfo[];
}

/** Resultado de `readFile` (`readMountFile` devuelve `string | null`). */
export interface ReadFileResult {
  ok: boolean;
  binary: boolean;
  content: string;
}

/** Forma de `WorkspaceCodeFlowDiagnosisResponseDTO`. */
export interface FlowDiagnosisResponse {
  success: boolean;
  codigo: string;
  mensaje: string | null;
  operation: string | null;
  result: unknown;
  model: string | null;
  usage: unknown;
  cached: boolean;
}
