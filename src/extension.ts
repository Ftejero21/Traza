import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { HostAi, isCancelled, type GeneratedFlow } from './host-ai';
import { registerChatParticipant } from './host-chat';
import { registerDbCommands } from './host-db';
import { registerFlowTool } from './host-tool';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROPOSALS = 10;
const SAMPLE_TITLE = 'Login con email y contraseña';
const MAX_QUESTION_CHARS = 4000;

type Source = 'file' | 'editor' | 'sample';

function titleOf(flow: unknown): string {
  const raw = flow && typeof flow === 'object' ? (flow as { title?: unknown }).title : undefined;
  const title = typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
  return title || 'Sin título';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * JSON del flujo: un `FlowDiagram` o un objeto con `.flow` y, opcionalmente, propuestas de cambio (`proposals`,
 * `proposal` o `change`; solo objetos, máx. 10). `null` (con aviso) si no se puede usar.
 */
function parseFlowJson(text: string): { flow: unknown; proposals: unknown[] } | null {
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    void vscode.window.showErrorMessage('El JSON supera el límite de 2 MB.');
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error: unknown) {
    console.warn('[Nexo] JSON no válido.', error instanceof Error ? error.name : '');
    void vscode.window.showErrorMessage(`El JSON no es válido: ${error instanceof Error ? error.message.slice(0, 200) : ''}`);
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    void vscode.window.showErrorMessage('El JSON no es un flujo válido');
    return null;
  }
  const o = raw as Record<string, unknown>;
  const nested = o['flow'];
  const flow = isObject(nested) ? nested : raw;
  let proposals: unknown[] = [];
  if (isObject(nested)) {
    if (Array.isArray(o['proposals'])) proposals = (o['proposals'] as unknown[]).filter(isObject).slice(0, MAX_PROPOSALS);
    else if (isObject(o['proposal'])) proposals = [o['proposal']];
    else if (isObject(o['change'])) proposals = [o['change']];
  }
  return { flow, proposals };
}

async function readJsonFile(): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
    filters: { JSON: ['json'] }, openLabel: 'Abrir flujo',
  });
  const uri = picked?.[0];
  if (!uri) return null;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > MAX_JSON_BYTES) {
      void vscode.window.showErrorMessage('El JSON supera el límite de 2 MB.');
      return null;
    }
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  } catch (error: unknown) {
    console.warn('[Nexo] No se pudo leer el archivo JSON.', error instanceof Error ? error.name : '');
    void vscode.window.showErrorMessage('No se pudo leer el archivo JSON.');
    return null;
  }
}

async function openFlow(context: vscode.ExtensionContext, ai: HostAi): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const items: (vscode.QuickPickItem & { source: Source })[] = [
    { label: '$(file) Abrir archivo JSON…', source: 'file' },
    ...(editor?.document.languageId === 'json' ? [{ label: '$(edit) Usar JSON del editor activo', description: editor.document.fileName, source: 'editor' as const }] : []),
    { label: '$(beaker) Flujo de ejemplo', source: 'sample' },
  ];
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Nexo: ¿qué flujo quieres abrir?' });
  if (!choice) return;
  if (choice.source === 'sample') {
    FlowPanel.show(context, ai, { flow: null, sample: true, title: SAMPLE_TITLE, proposals: [] });
    return;
  }
  const text = choice.source === 'editor' ? editor?.document.getText() ?? null : await readJsonFile();
  if (text === null) return;
  const parsed = parseFlowJson(text);
  if (parsed === null) return;
  FlowPanel.show(context, ai, { flow: parsed.flow, sample: false, title: titleOf(parsed.flow), proposals: parsed.proposals });
}

/** Pregunta por InputBox (vacía o cancelada → `null`). */
async function askQuestion(title: string, prompt: string): Promise<string | null> {
  const value = await vscode.window.showInputBox({
    title, prompt, ignoreFocusOut: true,
    validateInput: (text) => (text.length > MAX_QUESTION_CHARS ? `Máximo ${MAX_QUESTION_CHARS} caracteres.` : null),
  });
  const question = value?.trim() ?? '';
  return question ? question : null;
}

function showError(error: unknown): void {
  if (isCancelled(error)) return;
  console.warn('[Nexo] La operación de IA ha fallado.', error instanceof Error ? error.name : '');
  void vscode.window.showErrorMessage(error instanceof Error && error.message ? error.message.slice(0, 500) : 'Error inesperado.');
}

function showGenerated(context: vscode.ExtensionContext, ai: HostAi, generated: GeneratedFlow): void {
  FlowPanel.show(context, ai, { flow: generated.flow, sample: false, title: generated.title, proposals: [], source: { model: generated.model } });
}

/** «Nexo: Generar flujo»: pregunta, archivo activo y selección como pista, y abre el panel. */
async function generateFlow(context: vscode.ExtensionContext, ai: HostAi): Promise<void> {
  if (!(vscode.workspace.workspaceFolders ?? []).length) {
    void vscode.window.showErrorMessage('Abre una carpeta del proyecto para generar el flujo.');
    return;
  }
  const question = await askQuestion('Nexo: Generar flujo', '¿Qué proceso quieres ver? (p. ej. «¿Cómo funciona el login?»)');
  if (!question) return;
  try {
    const generated = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Nexo: generando flujo', cancellable: true },
      (progress, token) => ai.generateFlow({ question, pinned: [], useActiveEditor: true, token, progress: (message) => progress.report({ message }) }),
    );
    showGenerated(context, ai, generated);
  } catch (error: unknown) {
    showError(error);
  }
}

/** «Nexo: Proponer cambio»: sobre el flujo abierto (no el de ejemplo); la propuesta se añade a «Simular cambios». */
async function proposeChange(ai: HostAi): Promise<void> {
  const current = FlowPanel.currentFlow();
  if (!current) {
    void vscode.window.showWarningMessage('Abre o genera un flujo (que no sea el de ejemplo) antes de proponer un cambio.');
    return;
  }
  const question = await askQuestion('Nexo: Proponer cambio', '¿Qué cambio quieres en este flujo?');
  if (!question) return;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Nexo: proponiendo cambio', cancellable: true },
      (progress, token) => ai.proposeChange({ question, flow: current.flow, token, progress: (message) => progress.report({ message }) }),
    );
    if ('answer' in result) {
      void vscode.window.showInformationMessage(result.answer.slice(0, 1000));
      return;
    }
    if (!FlowPanel.addProposal(result.proposal)) void vscode.window.showWarningMessage('El panel del flujo se ha cerrado.');
  } catch (error: unknown) {
    showError(error);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const ai = new HostAi(context);
  // El token del backend antiguo ya no se usa.
  void Promise.resolve(context.secrets.delete('nexo.token')).catch((error: unknown) => {
    console.warn('[Nexo] No se pudo borrar el token antiguo.', error instanceof Error ? error.name : '');
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('nexo.openFlow', () => openFlow(context, ai)),
    vscode.commands.registerCommand('nexo.openSampleFlow', () => FlowPanel.show(context, ai, { flow: null, sample: true, title: SAMPLE_TITLE, proposals: [] })),
    vscode.commands.registerCommand('nexo.generateFlow', () => generateFlow(context, ai)),
    vscode.commands.registerCommand('nexo.proposeChange', () => proposeChange(ai)),
    vscode.commands.registerCommand('nexo.selectModel', () => ai.selectModelCommand()),
    vscode.commands.registerCommand('nexo.showLastFlow', () => {
      const last = ai.lastGenerated;
      if (last) showGenerated(context, ai, last);
      else void vscode.window.showInformationMessage('Todavía no se ha generado ningún flujo. Usa «Nexo: Generar flujo».');
    }),
    ...registerChatParticipant(context, ai),
    ...registerFlowTool(context, ai),
    ...registerDbCommands(context, () => FlowPanel.clearDbCache()),
  );
}

export function deactivate(): void {
  // El panel libera sus recursos al cerrarse (onDidDispose).
}
