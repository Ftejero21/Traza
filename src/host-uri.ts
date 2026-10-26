import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { MAX_ASK_CHARS } from './host-guards';
import { HostAi, isCancelled } from './host-ai';
import { isSpanish, oneLine } from './host-flow-summary';

/**
 * Deep links:
 * - `vscode://nexo-local.nexo-vscode/flow?q=…&mode=sim|logs|db`: genera un flujo. La URI es entrada no confiable:
 *   siempre pide confirmación modal antes de enviar nada al modelo.
 * - `vscode://nexo-local.nexo-vscode/show?id=<uuid>`: reabre un flujo ya generado en esta sesión (caché en memoria).
 *   Sin IA, sin enviar datos y sin modal; el id se valida y solo se busca en la caché.
 */

let busy = false;

type UriMode = 'sim' | 'logs' | 'db';
const MODES: ReadonlySet<string> = new Set(['sim', 'logs', 'db']);
const MAX_PREVIEW = 300;
const MAX_FOLDERS = 3;

export function registerFlowUriHandler(context: vscode.ExtensionContext, ai: HostAi): vscode.Disposable {
  return vscode.window.registerUriHandler({ handleUri: (uri) => handleFlowUri(context, ai, uri) });
}

const FLOW_ID = /^[0-9a-f-]{36}$/i;

function parseShowUri(uri: vscode.Uri): string | null {
  const id = new URLSearchParams(uri.query).get('id')?.trim() ?? '';
  return FLOW_ID.test(id) ? id : null;
}

function parseFlowUri(uri: vscode.Uri): { question: string; mode?: UriMode } | 'badPath' | 'badQuestion' {
  if (uri.path.replace(/\/+$/, '') !== '/flow') return 'badPath';
  const params = new URLSearchParams(uri.query);
  const question = params.get('q')?.trim() ?? '';
  if (!question || question.length > MAX_ASK_CHARS) return 'badQuestion';
  const rawMode = params.get('mode')?.trim().toLowerCase();
  if (rawMode && MODES.has(rawMode)) return { question, mode: rawMode as UriMode };
  return { question };
}

function previewQuestion(q: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = q.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ');
  return oneLine(clean, MAX_PREVIEW);
}

function folderLabel(): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const label = folders.slice(0, MAX_FOLDERS).map((f) => `${f.name} (${f.uri.fsPath})`).join(', ');
  return folders.length > MAX_FOLDERS ? `${label} … (+${folders.length - MAX_FOLDERS})` : label;
}

async function handleFlowUri(context: vscode.ExtensionContext, ai: HostAi, uri: vscode.Uri): Promise<void> {
  const es = isSpanish();
  try {
    if (uri.path.replace(/\/+$/, '') === '/show') {
      const id = parseShowUri(uri);
      if (!id) {
        void vscode.window.showErrorMessage(es
          ? 'El enlace de Nexo no trae un identificador de flujo válido (parámetro id).'
          : 'The Nexo link has no valid flow identifier (id parameter).');
        return;
      }
      await vscode.commands.executeCommand('nexo.showFlow', { flowId: id });
      return;
    }
    if (busy) {
      void vscode.window.showInformationMessage(es
        ? 'Nexo ya está generando un flujo desde un enlace. Espera a que termine.'
        : 'Nexo is already generating a flow from a link. Wait for it to finish.');
      return;
    }
    const parsed = parseFlowUri(uri);
    if (parsed === 'badPath') {
      void vscode.window.showErrorMessage(es
        ? 'Enlace de Nexo no reconocido. Usa vscode://nexo-local.nexo-vscode/flow?q=<pregunta>.'
        : 'Unrecognized Nexo link. Use vscode://nexo-local.nexo-vscode/flow?q=<question>.');
      return;
    }
    if (parsed === 'badQuestion') {
      void vscode.window.showErrorMessage(es
        ? 'El enlace de Nexo no trae una pregunta válida (parámetro q, de 1 a 4000 caracteres).'
        : 'The Nexo link has no valid question (q parameter, 1 to 4000 characters).');
      return;
    }
    if (!(vscode.workspace.workspaceFolders ?? []).length) {
      void vscode.window.showErrorMessage(es
        ? 'Abre una carpeta del proyecto para generar el flujo.'
        : 'Open a project folder to generate the flow.');
      return;
    }
    busy = true;
    try {
      const { question, mode } = parsed;
      const preview = previewQuestion(question);
      const folders = folderLabel();
      const message = es ? 'Un enlace quiere generar un flujo con Nexo' : 'A link wants to generate a flow with Nexo';
      const button = es ? 'Generar flujo' : 'Generate flow';
      const detail = es
        ? `Pregunta: ${preview}\n\nCarpeta: ${folders}\n\nNexo enviará al proveedor del modelo configurado en Nexo las rutas y los fragmentos de código relevantes del workspace (nunca archivos sensibles como .env o claves, y con los secretos enmascarados). No se modificará ningún archivo. Si no esperabas este enlace, cancela.`
        : `Question: ${preview}\n\nFolder: ${folders}\n\nNexo will send the relevant workspace paths and code fragments to the provider of the model configured in Nexo (never sensitive files such as .env or keys, and with secrets masked). No file will be modified. If you did not expect this link, cancel.`;
      const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, button);
      if (choice !== button) return;
      const generated = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: es ? 'Nexo: generando flujo' : 'Nexo: generating flow', cancellable: true },
        (progress, token) => ai.generateFlow({ question, pinned: [], useActiveEditor: false, token, progress: (m) => progress.report({ message: m }) }),
      );
      FlowPanel.show(context, ai, {
        flow: generated.flow, sample: false, title: generated.title, proposals: [],
        source: { model: generated.model }, ...(mode ? { mode } : {}),
      });
    } finally {
      busy = false;
    }
  } catch (error: unknown) {
    if (isCancelled(error)) return;
    console.warn('[Nexo] No se pudo generar el flujo desde un enlace.', error instanceof Error ? error.name : '');
    void vscode.window.showErrorMessage(
      error instanceof Error && error.message ? error.message.slice(0, 500) : (es ? 'Error inesperado.' : 'Unexpected error.'),
    );
  }
}
