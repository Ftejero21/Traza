/**
 * Chat participant `@traza` (id `traza.flow`): sin comando o con `/flujo` genera el flujo con el modelo del chat y lo
 * abre en el panel; `/cambio` propone un cambio sobre el flujo abierto. Los textos de la IA se escapan antes de
 * mostrarse y nunca llevan enlaces de comando confiables.
 */
import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { isCancelled, type HostAi } from './host-ai';
import type { PinnedRef } from './host-context';
import { escapeMarkdown, failLocation, formatFlowChatMarkdown, isScenarioQuestion, isSpanish, oneLine, resolveFlowFolder } from './host-flow-summary';

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
        ? 'Escribe qué proceso quieres ver, por ejemplo: `@traza ¿cómo funciona el login?`.  \nCon `/cambio <petición>` propongo un cambio sobre el flujo abierto.'
        : 'Describe the process you want to see, for example: `@traza how does login work?`.  \nWith `/cambio <request>` I propose a change on the open flow.');
      return {};
    }
    try {
      if (request.command === 'cambio') {
        const current = FlowPanel.currentFlow();
        if (!current) {
          stream.markdown(es
            ? 'No hay ningún flujo abierto. Genera uno con `@traza <pregunta>` o abre uno con «Traza: Flujo».'
            : 'No flow is open. Generate one with `@traza <question>` or open one with "Traza: Flujo".');
          return {};
        }
        stream.progress(es ? 'Preparando el cambio…' : 'Preparing the change…');
        const result = await ai.proposeChange({
          question: prompt, flow: current.flow, model: request.model, pinned: referencesOf(request), token,
          progress: (message) => stream.progress(message),
        });
        if ('answer' in result) {
          stream.markdown(escapeMarkdown(result.answer));
          return {};
        }
        FlowPanel.addProposal(result.proposal);
        const title = typeof result.proposal['title'] === 'string' ? result.proposal['title'] : '';
        const summary = typeof result.proposal['summary'] === 'string' ? result.proposal['summary'] : '';
        stream.markdown(`**${escapeMarkdown(title)}**\n\n${escapeMarkdown(summary)}`);
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
