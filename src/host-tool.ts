/**
 * Herramienta del modo agente `nexo_flow` (Language Model Tool): genera el flujo de un proceso del proyecto con el
 * pipeline existente de Nexo, lo abre en el panel y devuelve al agente un resumen en texto acotado. No modifica
 * archivos. Pide confirmación siempre antes de enviar código al proveedor del modelo configurado en Nexo.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { isCancelled, type HostAi } from './host-ai';
import type { PinnedRef } from './host-context';
import { formatFlowToolText, isScenarioQuestion, isSpanish, oneLine, resolveFlowFolder } from './host-flow-summary';
import { MAX_ASK_CHARS, normalizeCodePath } from './host-guards';

interface FlowToolInput {
  question: string;
  files?: string[];
  /** Nombre de carpeta/proyecto del workspace mencionado por el usuario (solo se compara con nombres de carpeta). */
  project?: string;
  /** `true` si el usuario pregunta qué pasa en una situación concreta. */
  scenario?: boolean;
}

const MAX_FILES = 12;
const MAX_FILE_CHARS = 520;
const MAX_PROJECT = 120;
const MAX_CONFIRM_QUESTION = 200;

/** Ejecución en curso de la herramienta (gana la última invocación). */
let currentRun: vscode.CancellationTokenSource | undefined;

function questionOf(input: unknown): string {
  const raw = input && typeof input === 'object' ? (input as { question?: unknown }).question : undefined;
  const question = typeof raw === 'string' ? raw.trim() : '';
  if (!question || question.length > MAX_ASK_CHARS) {
    throw new Error(isSpanish() ? 'La pregunta es obligatoria (máx. 4000 caracteres).' : 'The question is required (max. 4000 characters).');
  }
  return question;
}

/** Convierte las rutas de `files` (relativas o absolutas) en referencias dentro del workspace. */
function pinnedFromFiles(files: unknown): PinnedRef[] {
  if (!Array.isArray(files)) return [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  const out: PinnedRef[] = [];
  const seen = new Set<string>();
  const add = (uri: vscode.Uri): void => {
    const key = uri.toString();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ uri });
  };
  const items = files.filter((f): f is string => typeof f === 'string').slice(0, MAX_FILES);
  for (const item of items) {
    const p = item.trim();
    if (!p || p.length > MAX_FILE_CHARS) continue;
    if (path.isAbsolute(p)) {
      const uri = vscode.Uri.file(p);
      if (vscode.workspace.getWorkspaceFolder(uri) !== undefined) add(uri);
      continue;
    }
    const rel = normalizeCodePath(p);
    if (!rel) continue;
    if (folders.length > 1) {
      const slash = rel.indexOf('/');
      const first = slash >= 0 ? rel.slice(0, slash) : rel;
      const rest = slash >= 0 ? rel.slice(slash + 1) : '';
      const folder = folders.find((f) => f.name === first);
      if (folder && rest) {
        add(vscode.Uri.joinPath(folder.uri, rest));
        continue;
      }
    }
    for (const folder of folders) add(vscode.Uri.joinPath(folder.uri, rel));
  }
  return out;
}

/** `project` de la tool (string ≤120); `undefined` si no es válido. */
function projectOf(input: unknown): string | undefined {
  const raw = input && typeof input === 'object' ? (input as { project?: unknown }).project : undefined;
  const project = typeof raw === 'string' ? raw.trim() : '';
  return project && project.length <= MAX_PROJECT ? project : undefined;
}

function scenarioOf(input: unknown, question: string): boolean {
  const flag = input && typeof input === 'object' ? (input as { scenario?: unknown }).scenario : undefined;
  return flag === true || isScenarioQuestion(question);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : (isSpanish() ? 'Error inesperado.' : 'Unexpected error.');
}

export function registerFlowTool(context: vscode.ExtensionContext, ai: HostAi): vscode.Disposable[] {
  if (typeof vscode.lm?.registerTool !== 'function') return [];
  const tool: vscode.LanguageModelTool<FlowToolInput> = {
    prepareInvocation(options) {
      const es = isSpanish();
      const raw = (options.input as { question?: unknown } | undefined)?.question;
      const question = typeof raw === 'string' ? oneLine(raw, MAX_CONFIRM_QUESTION) : '';
      const message = new vscode.MarkdownString();
      message.appendText(es
        ? 'Nexo enviará al proveedor del modelo configurado en Nexo las rutas y los fragmentos de código relevantes del workspace (nunca archivos sensibles como .env o claves, y con los secretos enmascarados). No se modificará ningún archivo.\n\nPregunta: '
        : 'Nexo will send the relevant workspace paths and code fragments to the provider of the model configured in Nexo (never sensitive files such as .env or keys, and with secrets masked). No file will be modified.\n\nQuestion: ');
      message.appendText(question);
      const rawQuestion = typeof raw === 'string' ? raw : '';
      const folder = rawQuestion ? resolveFlowFolder(rawQuestion, projectOf(options.input)) : null;
      if (folder) message.appendText(`\n\n${es ? 'Carpeta' : 'Folder'}: ${oneLine(folder.name, MAX_PROJECT)}`);
      return {
        invocationMessage: es ? 'Generando el flujo con Nexo…' : 'Generating the flow with Nexo…',
        confirmationMessages: { title: es ? 'Generar flujo con Nexo' : 'Generate flow with Nexo', message },
      };
    },
    async invoke(options, token) {
      const question = questionOf(options.input);
      const files = (options.input as { files?: unknown } | undefined)?.files;
      const pinned = pinnedFromFiles(files);
      const folder = resolveFlowFolder(question, projectOf(options.input));
      const scenario = scenarioOf(options.input, question);
      currentRun?.cancel();
      currentRun?.dispose();
      const cts = new vscode.CancellationTokenSource();
      currentRun = cts;
      const listener = token.onCancellationRequested(() => cts.cancel());
      try {
        const generated = await ai.generateFlow({
          question, pinned, useActiveEditor: true, token: cts.token, progress: () => {},
          ...(folder ? { folder: folder.name } : {}), scenario,
        });
        FlowPanel.showGenerated(context, ai, generated);
        const flowId = typeof generated.flow['id'] === 'string' ? generated.flow['id'] : '';
        const showUri = `${vscode.env.uriScheme}://${context.extension.id}/show?id=${encodeURIComponent(flowId)}`;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(formatFlowToolText(generated, showUri))]);
      } catch (error: unknown) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (isCancelled(error)) {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(isSpanish()
            ? 'La generación del flujo se canceló (se inició otra generación o no se eligió modelo).'
            : 'The flow generation was cancelled (another generation started or no model was chosen).')]);
        }
        console.warn('[Nexo] Error en la herramienta nexo_flow.', error instanceof Error ? error.name : '');
        throw new Error(`${isSpanish() ? 'Nexo no pudo generar el flujo: ' : 'Nexo could not generate the flow: '}${errorMessage(error)}`);
      } finally {
        listener.dispose();
        if (currentRun === cts) currentRun = undefined;
        cts.dispose();
      }
    },
  };
  return [vscode.lm.registerTool<FlowToolInput>('nexo_flow', tool)];
}
