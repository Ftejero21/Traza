/**
 * Chat participant `@traza` (id `traza.flow`): sin comando o con `/flujo` genera el flujo con el modelo del chat y lo
 * abre en el panel; `/cambio` (o un texto que se detecta como petición de cambio) genera o reutiliza el flujo, propone
 * el cambio y lo abre en «Simular cambios». Los textos de la IA se escapan antes de mostrarse y nunca llevan enlaces de
 * comando confiables.
 */
import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { runChangeRequest } from './host-change';
import { isCancelled, type HostAi } from './host-ai';
import type { PinnedRef } from './host-context';
import {
  escapeMarkdown, failLocation, formatChangeChatMarkdown, formatFlowChatMarkdown, isChangeRequest, isScenarioQuestion, isSpanish,
  oneLine, resolveFlowFolder,
} from './host-flow-summary';

const FLOW_ID = /^[0-9a-f-]{36}$/i;

function referencesOf(request: vscode.ChatRequest): PinnedRef[] {
  const out: PinnedRef[] = [];
  for (const ref of request.references) {
    const value = ref.value;
    if (value instanceof vscode.Uri) out.push({ uri: value });
    else if (value instanceof vscode.Location) out.push({ uri: value.uri, range: value.range });
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 500) : (isSpanish() ? 'Error inesperado.' : 'Unexpected error.');
}

export function registerChatParticipant(context: vscode.ExtensionContext, ai: HostAi): vscode.Disposable[] {
  if (typeof vscode.chat?.createChatParticipant !== 'function') return [];
  const handler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
    const es = isSpanish();
    const prompt = request.prompt.trim();
    if (!prompt) {
      stream.markdown(es
        ? 'Escribe qué proceso quieres ver, por ejemplo: `@traza ¿cómo funciona el login?`.  \nCon `/cambio <petición>` propongo un cambio (genero el flujo si hace falta) y lo abro en «Simular cambios».'
        : 'Describe the process you want to see, for example: `@traza how does login work?`.  \nWith `/cambio <request>` I propose a change (generating the flow if needed) and open it in "Simular cambios".');
      return {};
    }
    try {
      const isChange = request.command === 'cambio' || (request.command !== 'flujo' && isChangeRequest(prompt));
      if (isChange) {
        const changeFolder = resolveFlowFolder(prompt);
        const result = await runChangeRequest(context, ai, {
          request: prompt, model: request.model, pinned: referencesOf(request), useActiveEditor: true, token,
          progress: (message) => stream.progress(message),
          ...(changeFolder ? { folder: changeFolder.name } : {}),
        });
        const flowId = FLOW_ID.test(result.flowId) && ai.flowById(result.flowId) ? result.flowId : '';
        if (result.kind === 'answer') {
          stream.markdown(escapeMarkdown(oneLine(result.answer, 4000)));
          if (result.generated) {
            stream.markdown(`\n\n${formatFlowChatMarkdown(result.generated)}`);
            if (flowId) stream.button({ command: 'traza.showFlow', arguments: [{ flowId }], title: es ? 'Visualizar flujo' : 'Visualize flow' });
          }
          return {};
        }
        stream.markdown(formatChangeChatMarkdown(result));
        if (flowId) {
          stream.button({ command: 'traza.showFlow', arguments: [{ flowId, mode: 'changes' }], title: es ? 'Ver cambios' : 'View changes' });
          stream.button({ command: 'traza.showFlow', arguments: [{ flowId }], title: es ? 'Visualizar flujo' : 'Visualize flow' });
        }
        return {};
      }
      const folder = resolveFlowFolder(prompt);
      const scenario = isScenarioQuestion(prompt);
      const folderName = folder ? oneLine(folder.name, 120) : '';
      stream.progress(es
        ? `Preparando el flujo${folderName ? ` de ${folderName}` : ''}…`
        : `Preparing the flow${folderName ? ` of ${folderName}` : ''}…`);
      const generated = await ai.generateFlow({
        question: prompt, model: request.model, pinned: referencesOf(request), useActiveEditor: true, token,
        progress: (message) => stream.progress(message),
        ...(folder ? { folder: folder.name } : {}), scenario,
      });
      FlowPanel.showGenerated(context, ai, generated);
      stream.markdown(formatFlowChatMarkdown(generated));
      const location = failLocation(generated);
      if (location) stream.anchor(location, es ? 'Ver dónde falla' : 'See where it fails');
      const flowId = typeof generated.flow['id'] === 'string' ? generated.flow['id'] : '';
      stream.button({
        command: 'traza.showFlow', arguments: flowId ? [{ flowId }] : [],
        title: es ? 'Visualizar flujo' : 'Visualize flow',
      });
      return {};
    } catch (error: unknown) {
      if (isCancelled(error) || token.isCancellationRequested) return {};
      console.warn('[Traza] Error en @traza.', error instanceof Error ? error.name : '');
      return { errorDetails: { message: errorMessage(error) } };
    }
  };
  const participant = vscode.chat.createChatParticipant('traza.flow', handler);
  participant.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
  return [participant];
}
