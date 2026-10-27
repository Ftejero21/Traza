import type { CaseComparison, ChangeComparison } from './nexo-ia.changes.types';

/**
 * Contratos de Nexo IA (frontend ⇄ backend ⇄ modelo).
 * Úsalos tal cual en el frontend y replica los mismos nombres de campo en el backend (DTOs).
 */

/* ============================================================
 *  Referencias a código (siempre validadas en el frontend)
 * ============================================================ */

export interface CodeRef {
  /** Id del montaje (WorkspaceCodeFsService) donde vive el archivo. */
  mountId: string;
  /** Ruta relativa al montaje, con '/' como separador. */
  file: string;
  /** Línea 1-based donde ocurre la acción. */
  line: number;
  /** Texto EXACTO (sin espacios iniciales) de esa línea. Sirve para validar y corregir `line`. */
  anchor: string;
  /** Clase, componente, servicio o interfaz que contiene la línea. */
  className: string;
  /** Método o función. Sin parámetros, p. ej. 'accept'. */
  functionName: string;
  /** Resultado de FlowRefValidator. Lo rellena el frontend, nunca la IA. */
  verification?: 'exact' | 'corrected' | 'unverified';
}

export interface CodeSnippet {
  ref: CodeRef;
  /** Primera línea del fragmento. El frontend lo vuelve a leer del archivo real. */
  startLine: number;
  /** Número de líneas a mostrar (3–8). */
  length: number;
  /** Línea marcada dentro del archivo (1-based, absoluta). */
  highlightLine: number;
  language: string;
}

/* ============================================================
 *  Flujo (respuesta a "¿cómo funciona X?")
 * ============================================================ */

export type FlowLaneKind = 'ui' | 'component' | 'service' | 'api' | 'db' | 'queue' | 'external' | 'other';

export interface FlowLane {
  id: string;
  name: string;
  /** Nombre corto para cabeceras estrechas (≤ 12 caracteres). */
  short: string;
  /** Tecnología: 'Angular', 'Spring Boot', 'PostgreSQL'… */
  sub: string;
  kind: FlowLaneKind;
}

export type FlowStepKind = 'code' | 'sql' | 'http' | 'event' | 'generated';

/** Qué ve el usuario final en un paso: vista o pantalla, toast, lista de datos, aviso, modal, mensaje de error… */
export type FlowStepUiKind = 'screen' | 'toast' | 'list' | 'warning' | 'modal' | 'error' | 'message';

/** Lo que el paso muestra al usuario final en pantalla (opcional: los flujos antiguos no lo traen). */
export interface FlowStepUi {
  kind: FlowStepUiKind;
  /** Qué ve exactamente (texto o elemento), ≤120. */
  what: string;
  /** El paso muestra lo que pide la pregunta. */
  focus?: boolean;
}

export interface FlowStep {
  id: string;
  /** Id de carril origen y destino. Iguales = llamada interna (bucle). */
  from: string;
  to: string;
  /** Etiqueta corta sobre la flecha: '(click)="accept()"', 'PATCH /api/x/{id}'… */
  label: string;
  title: string;
  /** 1–3 frases. Qué pasa y por qué; sin relleno. */
  explanation: string;
  kind: FlowStepKind;
  /** Dónde ocurre en el código. Para pasos sql/http, la línea de código que los provoca. */
  ref: CodeRef | null;
  /** Fragmento a mostrar. Para sql/http/generated, `generatedCode` sustituye a la lectura del archivo. */
  snippet: CodeSnippet | null;
  /** Solo en pasos que el usuario final ve en pantalla. */
  ui?: FlowStepUi;
  generatedCode?: { title: string; language: string; code: string; highlightIndex: number };
  /**
   * Código mostrado cuando la validación pudo leer el archivo (≤ 8 líneas de ≤ 400 caracteres). Solo frontend: se
   * persiste en el historial para poder enseñar el fragmento aunque la carpeta local no esté conectada.
   */
  codeSnapshot?: FlowCodeSnapshot;
}

export interface FlowCodeSnapshot {
  file: string;
  startLine: number;
  lines: string[];
  highlightLine: number;
  language: string;
}

export interface FlowErrorExit {
  stepId: string;
  httpStatus?: number;
  /** Condición que provoca la salida: 'el usuario no tiene el rol APPROVER'. */
  condition: string;
}

export interface SimulationPreset {
  id: string;
  /** Etiqueta del chip: 'comment: null', 'sin APPROVER'… */
  label: string;
  input: unknown;
  /** Resultado esperado según el código (lo usa el plan de pruebas). */
  expected: { kind: ResultKind; failStepId: string | null; httpStatus?: number };
}

export interface FlowDiagram {
  id: string;
  title: string;
  question: string;
  /** Párrafo que va antes de la lista de pasos en el chat. */
  summary: string;
  /** Párrafo con las salidas de error, después de la lista. */
  errorSummary: string;
  lanes: FlowLane[];
  steps: FlowStep[];
  errorExits: FlowErrorExit[];
  /** Forma de los datos de entrada del proceso (lo que se puede simular). */
  inputExample: unknown;
  simulationPresets: SimulationPreset[];
  files: CodeRef[];
  model: string;
  generatedAt: string;
  /** Escenario de la pregunta ya simulado por el FLOW; opcional. */
  scenario?: FlowScenario;
  /**
   * Mapa de datos del modo «Base de datos». Solo frontend (como `codeSnapshot`): se persiste en el historial para no volver a
   * pedirlo a la IA y nunca viaja al backend en SIMULATE, LOGS, COMPARE ni PROPOSE.
   */
  dbMap?: FlowDbMapStored;
}

/** Escenario concreto planteado en la pregunta, con su simulación ya resuelta. */
export interface FlowScenario {
  label: string;
  input: unknown;
  result: SimulationResult;
}

/* ============================================================
 *  Diagnóstico (común a simulación y logs)
 * ============================================================ */

export type ResultKind = 'error' | 'stop' | 'ok' | 'none';
export type Confidence = 'alta' | 'media' | 'baja';

/** Qué ve el usuario en la vista previa: bloqueado, sin aviso, con aviso o funcionando. */
export type UiPreviewState = 'blocked' | 'silent' | 'message' | 'success';

/**
 * Plan de la vista de pantalla (Nexo IA, fase 2.2). La IA NUNCA devuelve HTML ni CSS: solo este plan compacto
 * (< 150 tokens). El frontend pinta la plantilla y las hojas reales del componente con estos valores.
 */
export interface UiPreviewPlan {
  /** Selector existente de la raíz visible (encuadre). */
  root: string;
  state: UiPreviewState;
  /** Clave = expresión EXACTA de la plantilla; valor JSON plano. */
  bindings: Record<string, unknown>;
  mark: { selector: string; label: string };
  /** Algo visible que no está en la plantilla (p. ej. un aviso): host del componente `component` tras `after`. */
  inject?: { after: string; component: string; inputs?: Record<string, unknown> };
  /** Una frase (≤ 140). */
  caption: string;
  /** Solo si hay cambio propuesto: plan de «Con el cambio». */
  after?: Omit<UiPreviewPlan, 'after'>;
}

/**
 * Maqueta de pantalla de la IA (UI_MOCK): HTML + CSS estáticos de la vista del paso, con datos de ejemplo inventados.
 * Se sanea y se pinta solo en el iframe sandbox. Nunca se modifica ningún archivo.
 */
export interface UiMockBody {
  /** Solo el contenido de `<body>`, ya renderizado. */
  html: string;
  css?: string;
  root?: string;
  state: UiPreviewState;
  mark: { selector: string; label: string };
  caption: string;
}

export interface UiMock extends UiMockBody {
  css: string;
  /** «carpeta/ruta» de la plantilla principal que usó la IA. */
  view?: string;
  /** Solo si hay cambio propuesto: la misma pantalla con el cambio. */
  after?: UiMockBody;
}

/* ============================================================
 *  Mapa de datos del flujo (modo «Base de datos», DB_MAP)
 * ============================================================ */

export type FlowDbOp = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT';

export interface FlowDbColumn {
  name: string;
  type: string;
  pk: boolean;
  nullable?: boolean;
}

export interface FlowDbTable {
  name: string;
  entity?: string | null;
  columns: FlowDbColumn[];
}

export interface FlowDbRelation {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

export interface FlowDbAccess {
  stepId: string;
  table: string;
  op: FlowDbOp;
  direction: 'toDb' | 'fromDb';
  columns: string[];
  /** Expresión del flujo que va a cada columna (`dto.email`), nunca datos reales. */
  values?: Record<string, string>;
  /** Tabla unida (JOIN) o `null`. */
  via?: string | null;
  /** `Clase.método`. */
  fn: string;
  note?: string;
}

/** Respuesta de la IA (≤ 600 tokens): tablas, relaciones y accesos por paso del flujo. */
export interface FlowDbMap {
  summary: string;
  tables: FlowDbTable[];
  relations: FlowDbRelation[];
  accesses: FlowDbAccess[];
}

/** Mapa guardado en el flujo (solo frontend). */
export interface FlowDbMapStored extends FlowDbMap {
  source: FlowResultSource;
  language: 'es' | 'en';
  generatedAt: string;
  /** `real` = correlacionado con el esquema de una conexión; `code` = deducido del código. */
  schema: 'real' | 'code';
  database: string | null;
}

/** JSON que viaja en base64 (`contextBase64`) en la llamada DB_MAP (y en la tarea `dbMap` de Claude). */
export interface FlowDbMapContext {
  flowId: string;
  flow: {
    id: string;
    title: string;
    lanes: { id: string; name: string; kind: FlowLaneKind }[];
    steps: { id: string; from: string; to: string; label: string; title: string; kind: FlowStepKind; ref: { file: string; line: number; className: string; functionName: string } | null }[];
  };
  code: { path: string; startLine: number; endLine: number; content: string }[];
  schema: {
    provider: string;
    tables: { name: string; columns: { name: string; type: string; pk: boolean; nullable: boolean }[]; fks: { columns: string[]; refTable: string; refColumns: string[] }[] }[];
    otherTables: string[];
  } | null;
  /** Solo en el reintento profundo (`db-map-sql`): archivos de acceso a datos de partida (el host los lee) y motivo del reintento. */
  seeds?: { mountId: string; file: string; line: number }[];
  reason?: 'failed' | 'empty';
  /** Solo en el reintento profundo: la SQL que la IA devolvió en el flujo (pasos `sql`, ≤ 8, cada `code` ≤ 2000 caracteres). */
  flowSql?: { stepId: string; code: string }[];
}

/** Archivo enviado como contexto (ruta del proyecto y contenido ya enmascarado). */
export interface UiPlanFile {
  path: string;
  content: string;
}

/** JSON que viaja en base64 (`contextBase64`) en la llamada UI_PLAN. */
export interface UiPlanContext {
  flowId: string;
  component: { name: string; selector: string; ts: UiPlanFile; html: UiPlanFile; css: UiPlanFile[] };
  children: { selector: string; name: string; html: UiPlanFile; css: UiPlanFile[] }[];
  globalCss: string;
  simulation: {
    mode: 'sim' | 'logs' | 'changes' | 'walk';
    step: { index: number; id: string; title: string; label: string };
    kind: ResultKind;
    badge: string;
    title: string;
    httpStatus?: number;
    field?: string;
    userImpact: string;
    fix: string;
    input: unknown;
    after?: { kind: ResultKind; badge: string; title: string; userImpact: string };
  };
  change: {
    title: string;
    summary: string;
    files: { path: string; status: string; hunks: { oldStart: number; newStart: number; lines: { kind: string; text: string }[] }[] }[];
  } | null;
}

/** JSON que viaja en base64 (`contextBase64`) en la llamada UI_MOCK. */
export interface UiMockContext {
  flowId: string;
  question: string;
  screen: { index: number; id: string; title: string; label: string; what: string; kind: string | null };
  /** `ref` = «mountId/file:line». */
  steps: { index: number; label: string; title: string; ref: string | null; ui: string | null }[];
  seeds: { mountId: string; file: string; line: number }[];
  simulation: UiPlanContext['simulation'];
  change: (NonNullable<UiPlanContext['change']> & { applied: boolean }) | null;
}

export interface FlowDiagnosis {
  kind: ResultKind;
  /** Paso donde falla o se detiene. null si 'ok' o 'none'. */
  failStepId: string | null;
  /** 'Error 500', 'Error 403', 'Se detiene', '200 OK'… */
  badge: string;
  httpStatus?: number;
  title: string;
  where: CodeRef | null;
  /** Campo culpable con su valor: 'comment = null'. */
  field?: string;
  /** Conclusión de Traza: la cadena causal completa, citando pasos, clases y líneas. */
  conclusion: string;
  /** Qué ve el usuario final. */
  userImpact: string;
  /** Cómo arreglarlo. Vacío si no hay nada que corregir. */
  fix: string;
  snippet: CodeSnippet | null;
  confidence: Confidence;
  confidenceReason: string;
}

export interface SimulationRequest {
  flowId: string;
  input: unknown;
}

export interface SimulationResult extends FlowDiagnosis {
  executedStepIds: string[];
  skippedStepIds: string[];
}

/* ============================================================
 *  Logs
 * ============================================================ */

export type LogTone = 'info' | 'error' | 'trace';

export interface LogEvidence {
  /** Índice de la línea en el texto pegado (0-based). */
  index: number;
  /** Línea ya enmascarada. */
  text: string;
  stepId: string | null;
  tone: LogTone;
  /** Marco de pila reconocido, si lo hay. */
  frame?: { className: string; functionName: string; file: string; line: number };
  httpStatus?: number;
}

/** Lo que calcula el frontend ANTES de llamar a la IA (determinista). */
export interface LogPreAnalysis {
  evidence: LogEvidence[];
  seenStepIds: string[];
  exception?: { type: string; message: string; nullField?: string };
  /** Primer marco de pila que pertenece a un archivo del proyecto (no de librerías). */
  topProjectFrame?: LogEvidence['frame'];
  httpStatuses: number[];
}

export interface LogAnalysisRequest {
  flowId: string;
  /** Logs ya enmascarados. */
  logs: string;
  pre: LogPreAnalysis;
}

export interface LogAnalysisResult extends FlowDiagnosis {
  evidence: LogEvidence[];
  seenStepIds: string[];
}

/* ============================================================
 *  Chat
 * ============================================================ */

export interface AiContextItem {
  kind: 'file' | 'selection' | 'project';
  ref?: CodeRef;
  /** Para la selección, del rango [line, endLine]. */
  endLine?: number;
  label: string;
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  context?: AiContextItem[];
  /** Presente cuando la respuesta es un proceso explicado como flujo. */
  flow?: FlowDiagram;
  refs?: CodeRef[];
  createdAt: string;
  status?: 'streaming' | 'done' | 'error';
}

export interface AiConversationSummary {
  id: string;
  title: string;
  meta: string;
  updatedAt: string;
  hasFlow: boolean;
}

/* ============================================================
 *  Endpoints (ajusta la ruta base a la del servicio de IA existente)
 * ============================================================
 *  POST /api/workspace/code-ai/ask        { projectId, conversationId?, message, context, model } → AiChatMessage (stream)
 *  POST /api/workspace/code-ai/flow/simulate   SimulationRequest  → SimulationResult
 *  POST /api/workspace/code-ai/flow/logs       LogAnalysisRequest → LogAnalysisResult
 *  POST /api/workspace/code-ai/flow/ui-plan    { model, language, contextBase64 (UiPlanContext) } → { result: UiPreviewPlan }
 *  POST /api/workspace/code-ai/flow/db-map     { model, language, contextBase64 (FlowDbMapContext) } → { result: FlowDbMap }
 *  GET  /api/workspace/code-ai/conversations?projectId=…           → AiConversationSummary[]
 *  GET  /api/workspace/code-ai/conversations/{id}                  → AiChatMessage[]
 */

/* ============================================================
 *  Tipos de vista del editor (no forman parte del contrato con el backend)
 * ============================================================ */

/** Modelos del selector: `fast` = router actual, `pro` = Luna, `reason` = Luna con más razonamiento. */
export type AiModelId = 'fast' | 'pro' | 'reason';

export type FlowMode = 'walk' | 'sim' | 'logs' | 'changes' | 'db';

export type FlowRowState = 'done' | 'current' | 'pending' | 'fail' | 'stop' | 'skipped';

/** Fragmento releído del archivo real (nunca el texto que devuelve la IA). */
export interface SnippetView {
  file: string;
  fileId: string | null;
  startLine: number;
  lines: string[];
  /** Línea marcada (absoluta en el archivo; en los generados, relativa a `startLine`). */
  highlightLine: number;
  language: string;
  verification: 'exact' | 'corrected' | 'unverified';
  generated?: boolean;
  /** Construido desde `FlowStep.codeSnapshot` porque el archivo no se pudo leer ahora. */
  cached?: boolean;
}

/** Quién produjo un resultado de simulación o de logs: el modelo de VS Code (`lm`) o Claude, y su nombre (texto ya traducido). */
export interface FlowResultSource {
  provider: 'lm' | 'claude';
  model: string | null;
}

export interface FlowUiState {
  mode: FlowMode;
  step: number;
  playing: boolean;
  speed: 0.5 | 1 | 2;
  labHeight: number | null;
  labPane: 'data' | 'result';
  simInput: string;
  simPreset: string | null;
  simError: string | null;
  simResult: SimulationResult | null;
  logsInput: string;
  logsResult: LogAnalysisResult | null;
  pre: LogPreAnalysis | null;
  busy: boolean;
  error: string | null;
  resultVisible: boolean;
  revealedFor: string | null;
  /** Simular cambios: lado reproducido, caso seleccionado y comparación antes/después. */
  changeSide: 'before' | 'after';
  changeCase: string | null;
  comparison: (Omit<ChangeComparison, 'cases'> & { cases: Required<CaseComparison>[]; source?: FlowResultSource }) | null;
  changeBusy: boolean;
  changeError: string | null;
  /** Claude está resolviendo la tarea (simular/logs o simular cambios): el laboratorio espera con «Cancelar». */
  claudeRun: 'diagnosis' | 'compare' | null;
  /** Acción extra del error: «Abrir panel de IA» (Claude no disponible u ocupado). */
  errorAction: 'claudePanel' | null;
  changeErrorAction: 'claudePanel' | null;
  /** Proveedor y modelo del resultado visible (pie de la tarjeta de diagnóstico). */
  resultSource: FlowResultSource | null;
  /** Modo «Base de datos»: estado del mapa de datos. */
  dbStatus: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  dbError: string | null;
  dbErrorAction: 'claudePanel' | null;
  /** El mapa lo está resolviendo Claude (la carga muestra «Cancelar»). */
  dbClaude: boolean;
  /** Reintento profundo (`db-map-sql`) en curso: la IA lee el código con herramientas. */
  dbDeep: boolean;
  /** Último mensaje de progreso del reintento profundo (≤ 100 caracteres). */
  dbProgress: string | null;
}

/** Conversación guardada en `localStorage` (solo mensajes y metadatos de las chips). */
export interface StoredConversation<TMessage = unknown> {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hasFlow: boolean;
  /** Archivo de contexto de la primera pregunta (vacío = proyecto completo). */
  meta: string;
  messages: TMessage[];
  summary: string | null;
  pendingSummaryTurns: { role: 'user' | 'assistant'; text: string }[];
  queuedExchanges: number;
}
