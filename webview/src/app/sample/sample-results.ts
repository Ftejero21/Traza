import { FlowDiagnosisResponse, FlowKind } from '../bridge/protocol';
import { CodeRef, FlowDiagram, LogAnalysisResult, LogPreAnalysis, SimulationResult, UiPreviewPlan } from '../workspace-code/ai/nexo-ia.types';
import { decodeUtf8Base64 } from '../workspace-code/workspace-code.types';
import { SAMPLE_DB_MAP } from './sample-db';
import { SAMPLE_FLOW } from './sample-project';

/** Respuestas simuladas del backend (modo navegador). Pasan por `sanitizeDiagnosis`/`sanitizeUiPreviewPlan` como las reales. */

type Obj = Record<string, unknown>;

interface PresetText {
  title: string;
  conclusion: string;
  userImpact: string;
  fix: string;
  field?: string;
}

const TEXTS: Record<string, PresetText> = {
  ok: {
    title: 'Login correcto: se devuelve el token',
    conclusion: 'El email existe (P5) y passwordEncoder.matches() devuelve true (P6), así que UsuarioController responde 200 con el JWT (P7).',
    userImpact: 'El usuario entra en la aplicación y se le redirige a /inicio.',
    fix: '',
  },
  'bad-pass': {
    title: 'La contraseña no coincide',
    conclusion: 'UsuarioServiceImpl.authenticate() encuentra al usuario (P5), pero passwordEncoder.matches() devuelve false y lanza FreeSocialException("error.login") (P6). El controlador no llega a generar el token.',
    userImpact: 'El formulario muestra «Usuario o contraseña incorrectos» bajo los campos.',
    fix: 'Mostrar mensaje claro y no revelar si el email existe.',
    field: 'password = ***',
  },
  'no-user': {
    title: 'No existe ningún usuario con ese email',
    conclusion: 'UsuarioRepository.findByEmail() devuelve un Optional vacío (P5) y orElseThrow() lanza FreeSocialException antes de comprobar la contraseña.',
    userImpact: 'El usuario ve el mismo aviso genérico de credenciales incorrectas.',
    fix: 'Responder con el mismo mensaje que una contraseña incorrecta para no revelar qué emails existen.',
    field: 'email = «oculto»',
  },
  empty: {
    title: 'El formulario no se envía',
    conclusion: 'LoginComponent.login() sale en la primera línea (P1) porque el email está vacío; no se hace ninguna petición al backend.',
    userImpact: 'No pasa nada al pulsar «Entrar»: no hay aviso ni petición.',
    fix: 'Deshabilitar el botón o mostrar un aviso cuando falten el email o la contraseña.',
    field: 'email = ""',
  },
};

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function plainRef(ref: CodeRef | null): CodeRef | null {
  if (!ref) return null;
  const copy = { ...ref };
  delete copy.verification;
  return copy;
}

function decodeContext(contextBase64: string): Obj {
  try {
    return obj(JSON.parse(decodeUtf8Base64(contextBase64))) ?? {};
  } catch (error: unknown) {
    console.warn('[Nexo] Contexto de ejemplo no válido.', error instanceof Error ? error.name : '');
    return {};
  }
}

function flowOf(ctx: Obj): FlowDiagram {
  const flow = obj(ctx['flow']);
  return flow && Array.isArray(flow['steps']) ? (flow as unknown as FlowDiagram) : SAMPLE_FLOW;
}

function simulate(ctx: Obj): SimulationResult {
  const flow = flowOf(ctx);
  const input = obj(ctx['input']) ?? {};
  const presets = SAMPLE_FLOW.simulationPresets;
  const email = input['email'];
  const preset = presets.find((p) => p.label === input['escenario'])
    ?? ((typeof email !== 'string' || !email.trim()) ? presets.find((p) => p.id === 'empty') : presets.find((p) => p.id === 'ok'))
    ?? presets[0];
  const failStepId = preset.expected.failStepId;
  const failIndex = failStepId ? flow.steps.findIndex((s) => s.id === failStepId) : -1;
  const ids = flow.steps.map((s) => s.id);
  const executed = failIndex >= 0 ? ids.slice(0, failIndex + 1) : ids;
  const skipped = failIndex >= 0 ? ids.slice(failIndex + 1) : [];
  const status = preset.expected.httpStatus;
  const kind = preset.expected.kind;
  const text = TEXTS[preset.id] ?? TEXTS['ok'];
  const result: SimulationResult = {
    kind,
    failStepId: kind === 'error' || kind === 'stop' ? failStepId : null,
    badge: kind === 'ok' ? '200 OK' : kind === 'stop' ? 'Se detiene' : `Error ${status ?? ''}`.trim(),
    title: text.title,
    where: failIndex >= 0 ? plainRef(flow.steps[failIndex].ref) : null,
    conclusion: text.conclusion,
    userImpact: text.userImpact,
    fix: text.fix,
    snippet: null,
    confidence: 'media',
    confidenceReason: 'Respuesta simulada (modo navegador)',
    executedStepIds: executed,
    skippedStepIds: skipped,
  };
  if (status !== undefined) result.httpStatus = status;
  if (text.field) result.field = text.field;
  return result;
}

function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/');
  return clean.slice(clean.lastIndexOf('/') + 1).toLowerCase();
}

function logs(ctx: Obj): LogAnalysisResult {
  const flow = flowOf(ctx);
  const pre = (obj(ctx['pre']) ?? { evidence: [], seenStepIds: [], httpStatuses: [] }) as unknown as LogPreAnalysis;
  const frame = pre.topProjectFrame;
  let step = frame
    ? flow.steps.find((s) => s.ref && baseName(s.ref.file) === baseName(frame.file)
      && (!frame.className || s.ref.className === frame.className) && s.ref.functionName === frame.functionName)
      ?? flow.steps.find((s) => s.ref && baseName(s.ref.file) === baseName(frame.file))
    : undefined;
  const seen = Array.isArray(pre.seenStepIds) ? pre.seenStepIds : [];
  if (!step && seen.length) step = flow.steps.find((s) => s.id === seen[seen.length - 1]);
  const statuses = Array.isArray(pre.httpStatuses) ? pre.httpStatuses : [];
  const exception = pre.exception?.type ? pre.exception.type.slice(pre.exception.type.lastIndexOf('.') + 1) : 'Excepción';
  return {
    kind: step ? 'error' : 'none',
    failStepId: step ? step.id : null,
    badge: statuses.includes(401) ? 'Error 401' : 'Excepción',
    title: `${exception} en authenticate()`,
    where: step ? plainRef(step.ref) : null,
    conclusion: step
      ? `La traza parte de ${step.ref?.className ?? ''}.${step.ref?.functionName ?? ''}() (P${flow.steps.indexOf(step) + 1}): passwordEncoder.matches() devuelve false y se lanza FreeSocialException("error.login"), que el manejador global resuelve sin token.`
      : 'Los logs no contienen ningún marco de pila del flujo.',
    userImpact: 'El usuario ve «Usuario o contraseña incorrectos» y no inicia sesión.',
    fix: 'Revisar la contraseña introducida; si es correcta, comprobar que el hash guardado usa el mismo PasswordEncoder.',
    snippet: null,
    confidence: 'media',
    confidenceReason: 'Respuesta simulada (modo navegador)',
    evidence: Array.isArray(pre.evidence) ? pre.evidence : [],
    seenStepIds: seen,
  };
}

function uiPlan(): UiPreviewPlan {
  return {
    root: '.login-card',
    state: 'message',
    bindings: { errorMessage: 'Usuario o contraseña incorrectos', loading: false },
    mark: { selector: '.login-error', label: 'Error 401' },
    caption: 'El usuario ve el aviso de credenciales incorrectas bajo el formulario.',
  };
}

/** Simulación de un preset del flujo de ejemplo (la usa también la comparación de Simular cambios). */
export function simulatePreset(presetId: string, flow: FlowDiagram = SAMPLE_FLOW): SimulationResult {
  const preset = flow.simulationPresets.find((p) => p.id === presetId) ?? SAMPLE_FLOW.simulationPresets.find((p) => p.id === presetId);
  const input = preset ? { escenario: preset.label, ...(obj(preset.input) ?? {}) } : {};
  return simulate({ flow, input });
}

/** Respuesta simulada de `POST …/flow/{kind}`. */
export function sampleFlowResponse(kind: FlowKind, contextBase64: string): FlowDiagnosisResponse {
  const ctx = decodeContext(contextBase64);
  const result = kind === 'simulate' ? simulate(ctx) : kind === 'logs' ? logs(ctx) : kind === 'db-map' ? SAMPLE_DB_MAP : uiPlan();
  const operation = kind === 'simulate' ? 'SIMULATE' : kind === 'logs' ? 'LOGS' : kind === 'db-map' ? 'DB_MAP' : 'UI_PLAN';
  return { success: true, codigo: 'OK', mensaje: null, operation, result, model: 'Mock', usage: null, cached: false };
}
