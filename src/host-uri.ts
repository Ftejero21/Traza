import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { runChangeRequest } from './host-change';
import { MAX_ASK_CHARS } from './host-guards';
import { HostAi, isCancelled } from './host-ai';
import { isSpanish, oneLine } from './host-flow-summary';

/**
 * Deep links:
 * - `vscode://ftejero21.traza/flow?q=…&mode=sim|logs|db`: genera un flujo. La URI es entrada no confiable:
 *   siempre pide confirmación modal antes de enviar nada al modelo.
 * - `vscode://ftejero21.traza/flow?q=…&mode=change&change=…`: propone un cambio (genera el flujo si hace falta) y lo abre
 *   en «Simular cambios». `q` es opcional (si falta, se usa `change`). Siempre con confirmación modal; solo se simula.
 * - `vscode://ftejero21.traza/show?id=<uuid>`: reabre un flujo ya generado en esta sesión (caché en memoria).
 *   Sin IA, sin enviar datos y sin modal; el id se valida y solo se busca en la caché.
 * - `vscode://ftejero21.traza/show?id=<uuid>&mode=changes`: lo reabre con sus propuestas en «Simular cambios».
 */

let busy = false;

type UriMode = 'sim' | 'logs' | 'db' | 'change';
const MODES: ReadonlySet<string> = new Set(['sim', 'logs', 'db', 'change']);
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

function parseFlowUri(uri: vscode.Uri): { question: string; mode?: UriMode; change?: string } | 'badPath' | 'badQuestion' | 'badChange' {
  if (uri.path.replace(/\/+$/, '') !== '/flow') return 'badPath';
  const params = new URLSearchParams(uri.query);
  const rawMode = params.get('mode')?.trim().toLowerCase();
  const mode = rawMode && MODES.has(rawMode) ? (rawMode as UriMode) : undefined;
  const q = params.get('q')?.trim() ?? '';
  if (mode === 'change') {
    const change = params.get('change')?.trim() ?? '';
    if (!change || change.length > MAX_ASK_CHARS) return 'badChange';
    if (q.length > MAX_ASK_CHARS) return 'badQuestion';
    return { question: q || change, mode, change };
  }
  if (!q || q.length > MAX_ASK_CHARS) return 'badQuestion';
  return mode ? { question: q, mode } : { question: q };
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
          ? 'El enlace de Traza no trae un identificador de flujo válido (parámetro id).'
          : 'The Traza link has no valid flow identifier (id parameter).');
        return;
      }
      const showMode = new URLSearchParams(uri.query).get('mode')?.trim().toLowerCase() === 'changes';
      await vscode.commands.executeCommand('traza.showFlow', showMode ? { flowId: id, mode: 'changes' } : { flowId: id });
      return;
    }
    if (busy) {
      void vscode.window.showInformationMessage(es
        ? 'Traza ya está generando un flujo desde un enlace. Espera a que termine.'
        : 'Traza is already generating a flow from a link. Wait for it to finish.');
      return;
    }
    const parsed = parseFlowUri(uri);
    if (parsed === 'badPath') {
      const base = `${vscode.env.uriScheme}://${context.extension.id}`;
      void vscode.window.showErrorMessage(es
        ? `Enlace de Traza no reconocido. Usa ${base}/flow?q=<pregunta>.`
        : `Unrecognized Traza link. Use ${base}/flow?q=<question>.`);
      return;
    }
    if (parsed === 'badQuestion') {
      void vscode.window.showErrorMessage(es
        ? 'El enlace de Traza no trae una pregunta válida (parámetro q, de 1 a 4000 caracteres).'
        : 'The Traza link has no valid question (q parameter, 1 to 4000 characters).');
      return;
    }
    if (parsed === 'badChange') {
      void vscode.window.showErrorMessage(es
        ? 'El enlace de Traza no trae un cambio válido (parámetro change, de 1 a 4000 caracteres).'
        : 'The Traza link has no valid change (change parameter, 1 to 4000 characters).');
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
      const { question, mode, change } = parsed;
      const preview = previewQuestion(question);
      const folders = folderLabel();
      if (mode === 'change' && change) {
        const hasQuestion = question !== change;
        const changeMessage = es ? 'Un enlace quiere proponer un cambio con Traza' : 'A link wants to propose a change with Traza';
        const changeButton = es ? 'Proponer cambio' : 'Propose change';
        const sendNote = es
          ? 'Traza enviará al proveedor del modelo configurado en Traza las rutas y los fragmentos de código relevantes del workspace (nunca archivos sensibles como .env o claves, y con los secretos enmascarados). La propuesta solo se simulará en «Simular cambios»; no se modificará ningún archivo. Si no esperabas este enlace, cancela.'
          : 'Traza will send the relevant workspace paths and code fragments to the provider of the model configured in Traza (never sensitive files such as .env or keys, and with secrets masked). The proposal will only be simulated in "Simular cambios"; no file will be modified. If you did not expect this link, cancel.';
        const changeDetail = [
          ...(hasQuestion ? [`${es ? 'Pregunta' : 'Question'}: ${preview}`] : []),
          `${es ? 'Cambio' : 'Change'}: ${previewQuestion(change)}`,
          `${es ? 'Carpeta' : 'Folder'}: ${folders}`,
          sendNote,
        ].join('\n\n');
        const picked = await vscode.window.showInformationMessage(changeMessage, { modal: true, detail: changeDetail }, changeButton);
        if (picked !== changeButton) return;
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: es ? 'Traza: proponiendo cambio' : 'Traza: proposing change', cancellable: true },
          (progress, token) => runChangeRequest(context, ai, {
            request: change, flowQuestion: question, pinned: [], useActiveEditor: false, token,
            progress: (m) => progress.report({ message: m }),
          }),
        );
        if (result.kind === 'answer') void vscode.window.showInformationMessage(result.answer.slice(0, 1000));
        return;
      }
      const message = es ? 'Un enlace quiere generar un flujo con Traza' : 'A link wants to generate a flow with Traza';
      const button = es ? 'Generar flujo' : 'Generate flow';
      const detail = es
        ? `Pregunta: ${preview}\n\nCarpeta: ${folders}\n\nTraza enviará al proveedor del modelo configurado en Traza las rutas y los fragmentos de código relevantes del workspace (nunca archivos sensibles como .env o claves, y con los secretos enmascarados). No se modificará ningún archivo. Si no esperabas este enlace, cancela.`
        : `Question: ${preview}\n\nFolder: ${folders}\n\nTraza will send the relevant workspace paths and code fragments to the provider of the model configured in Traza (never sensitive files such as .env or keys, and with secrets masked). No file will be modified. If you did not expect this link, cancel.`;
      const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, button);
      if (choice !== button) return;
      const generated = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: es ? 'Traza: generando flujo' : 'Traza: generating flow', cancellable: true },
        (progress, token) => ai.generateFlow({ question, pinned: [], useActiveEditor: false, token, progress: (m) => progress.report({ message: m }) }),
      );
      FlowPanel.show(context, ai, {
        flow: generated.flow, sample: false, title: generated.title, proposals: [],
        source: { model: generated.model }, ...(mode && mode !== 'change' ? { mode } : {}),
      });
    } finally {
      busy = false;
    }
  } catch (error: unknown) {
    if (isCancelled(error)) return;
    console.warn('[Traza] No se pudo generar el flujo desde un enlace.', error instanceof Error ? error.name : '');
    void vscode.window.showErrorMessage(
      error instanceof Error && error.message ? error.message.slice(0, 500) : (es ? 'Error inesperado.' : 'Unexpected error.'),
    );
  }
}
