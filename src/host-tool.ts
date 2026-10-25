/**
 * Herramienta del modo agente `nexo_flow` (Language Model Tool): genera el flujo de un proceso del proyecto con el
 * pipeline existente de Nexo, lo abre en el panel y devuelve al agente un resumen en texto acotado. No modifica
 * archivos. Pide confirmación siempre antes de enviar código al proveedor del modelo configurado en Nexo.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { isCancelled, type GeneratedFlow, type HostAi } from './host-ai';
import type { PinnedRef } from './host-context';
import { MAX_ASK_CHARS, normalizeCodePath } from './host-guards';

interface FlowToolInput {
  question: string;
  files?: string[];
}

const MAX_FILES = 12;
const MAX_FILE_CHARS = 520;
const MAX_STEPS = 40;
const MAX_SUMMARY = 600;
const MAX_ERRORS = 400;
const MAX_LABEL = 120;
const MAX_CONFIRM_QUESTION = 200;

/** Ejecución en curso de la herramienta (gana la última invocación). */
let currentRun: vscode.CancellationTokenSource | undefined;

function isSpanish(): boolean {
  return vscode.workspace.getConfiguration('nexo').get<string>('language') !== 'en';
}

/** Texto en una línea (saltos colapsados) y recortado a `max`. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Texto plano y acotado que recibe el agente. */
function formatResult(generated: GeneratedFlow): string {
  const es = isSpanish();
  const flow = generated.flow as Record<string, unknown>;
  const title = oneLine(generated.title, 120);
  const lanes = new Map<string, string>();
  for (const lane of asArray(flow['lanes'])) {
    const o = asObject(lane);
    if (!o) continue;
    const id = typeof o['id'] === 'string' ? o['id'] : '';
    if (id) lanes.set(id, oneLine(o['name'], 80) || oneLine(id, 80));
  }
  const nameOf = (id: unknown): string => {
    const key = typeof id === 'string' ? id : '';
    return lanes.get(key) ?? (oneLine(key, 80) || '?');
  };
  const lines: string[] = [
    `${es ? 'Flujo' : 'Flow'}: ${title}`,
    `${es ? 'Modelo' : 'Model'}: ${oneLine(generated.model, 120)}`,
    `${es ? 'Resumen' : 'Summary'}: ${oneLine(flow['summary'], MAX_SUMMARY)}`,
  ];
  if (typeof flow['errorSummary'] === 'string') lines.push(`${es ? 'Errores' : 'Errors'}: ${oneLine(flow['errorSummary'], MAX_ERRORS)}`);
  const steps = asArray(flow['steps']).map(asObject).filter((s): s is Record<string, unknown> => s !== null);
  lines.push(es ? 'Pasos:' : 'Steps:');
  steps.slice(0, MAX_STEPS).forEach((step, index) => {
    const label = oneLine(step['label'], MAX_LABEL) || oneLine(step['title'], MAX_LABEL);
    const ref = asObject(step['ref']);
    const file = ref ? oneLine(ref['file'], 260) : '';
    const line = ref && typeof ref['line'] === 'number' && Number.isFinite(ref['line']) ? `:${ref['line']}` : '';
    const where = file ? ` (${file}${line})` : '';
    lines.push(`${index + 1}. ${nameOf(step['from'])} → ${nameOf(step['to'])}: ${label}${where}`);
  });
  if (steps.length > MAX_STEPS) {
    const more = steps.length - MAX_STEPS;
    lines.push(es ? `… y ${more} pasos más` : `… and ${more} more steps`);
  }
  lines.push(es
    ? `El diagrama interactivo se ha abierto en el panel «Flujo · ${title}» (Recorrido, Simular datos, Analizar logs, Base de datos, Simular cambios). No se ha modificado ningún archivo.`
    : `The interactive diagram has been opened in the panel "Flujo · ${title}" (Recorrido, Simular datos, Analizar logs, Base de datos, Simular cambios). No file has been modified.`);
  return lines.join('\n');
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
      return {
        invocationMessage: es ? 'Generando el flujo con Nexo…' : 'Generating the flow with Nexo…',
        confirmationMessages: { title: es ? 'Generar flujo con Nexo' : 'Generate flow with Nexo', message },
      };
    },
    async invoke(options, token) {
      const question = questionOf(options.input);
      const files = (options.input as { files?: unknown } | undefined)?.files;
      const pinned = pinnedFromFiles(files);
      currentRun?.cancel();
      currentRun?.dispose();
      const cts = new vscode.CancellationTokenSource();
      currentRun = cts;
      const listener = token.onCancellationRequested(() => cts.cancel());
      try {
        const generated = await ai.generateFlow({ question, pinned, useActiveEditor: true, token: cts.token, progress: () => {} });
        FlowPanel.show(context, ai, { flow: generated.flow, sample: false, title: generated.title, proposals: [], source: { model: generated.model } });
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(formatResult(generated))]);
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
