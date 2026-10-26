/**
 * Contratos de cambios propuestos por Nexo IA (prompt 2).
 * Complementa contracts/nexo-ia.types.ts (importa CodeRef, SimulationResult, SimulationPreset…).
 */
import type { SimulationPreset, SimulationResult } from './nexo-ia.types';

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** Número en el archivo original (null en líneas añadidas). */
  oldLine: number | null;
  /** Número en el archivo nuevo (null en líneas eliminadas). */
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  /** Cabecera legible: '@@ accept()'. */
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileChange {
  mountId: string;
  path: string;
  /** Nota breve: 'comment puede ser null'. */
  note: string;
  status: 'modified' | 'added' | 'deleted';
  /** SHA-256 del contenido que leyó la IA. Si no coincide al aplicar, hay conflicto. */
  baseHash: string | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Caso del flujo activo en el que se nota el cambio (`presetId` null = caso nuevo con su `input`). */
export interface ChangeCase {
  presetId: string | null;
  label: string;
  input: unknown;
}

export interface ChangeProposal {
  id: string;
  /** Mensaje del usuario que lo originó. */
  request: string;
  title: string;
  /** 1–2 frases: qué cambia y por qué. */
  summary: string;
  files: FileChange[];
  /** Flujo afectado, si existe (habilita «Simular cambios»). */
  flowId: string | null;
  /** Riesgos o efectos secundarios que la IA ha detectado. */
  risks: string[];
  /** De 1 a 3 casos del flujo activo en los que se nota el cambio (ausente en propuestas antiguas). */
  cases?: ChangeCase[];
  status: 'pending' | 'applied' | 'discarded' | 'conflict';
  createdAt: string;
}

export type ComparisonTag = 'fixed' | 'better' | 'same' | 'regression';

export interface CaseComparison {
  preset: SimulationPreset;
  before: SimulationResult;
  after: SimulationResult;
  /** Lo calcula el frontend con las reglas del prompt 2, nunca la IA. */
  tag?: ComparisonTag;
}

export interface ChangeComparison {
  proposalId: string;
  flowId: string;
  cases: CaseComparison[];
}

/* ============================================================
 *  Endpoints
 * ============================================================
 *  POST /api/workspace/code-ai/ask   → si es una petición de cambio, el mensaje lleva `change: ChangeProposal`
 *  POST /api/workspace/code-ai/changes/{id}/compare   { flowId } → ChangeComparison
 *  POST /api/workspace/code-ai/changes/{id}/status    { status: 'applied' | 'discarded' } → 204
 *  (Aplicar y deshacer escriben en disco desde el frontend con WorkspaceCodeFsService.)
 */

export interface UndoSnapshot {
  proposalId: string;
  files: { mountId: string; path: string; previousContent: string | null; appliedHash: string }[];
  appliedAt: string;
}

/** Forma de `WorkspaceCodeChangeCompareResponseDTO` (chatBack). `before`/`after` se sanean en el frontend. */
export interface ChangeCompareResponse {
  success: boolean;
  codigo: string;
  mensaje: string | null;
  comparison: { proposalId: string; flowId: string; cases: { presetId: string; before: unknown; after: unknown }[] } | null;
  model: string | null;
  usage: unknown;
  cached: boolean;
}
