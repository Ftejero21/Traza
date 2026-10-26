/**
 * Orquestador único de peticiones de cambio (chat `@traza`, comando «Proponer cambio», tool `traza_flow` y deep links):
 * reutiliza el flujo abierto si es relevante o genera uno nuevo, propone el cambio con `HostAi.proposeChange` y, cuando
 * la propuesta está lista, abre el panel directamente en «Simular cambios». Solo se simula: nunca escribe archivos.
 */
import * as vscode from 'vscode';
import { FlowPanel } from './flow-panel';
import { isCancelled, trazaLog, type GeneratedFlow, type HostAi } from './host-ai';
import { foldAccents, type PinnedRef } from './host-context';
import { isSpanish } from './host-flow-summary';

export interface ChangeRunOptions {
  request: string;
  flowQuestion?: string;
  model?: vscode.LanguageModelChat;
  pinned: PinnedRef[];
  folder?: string;
  useActiveEditor: boolean;
  token: vscode.CancellationToken;
  progress?: (m: string) => void;
}

export type ChangeRunResult =
  | { kind: 'proposal'; proposal: Record<string, unknown>; model: string; flowId: string; flowTitle: string; generated: GeneratedFlow | null }
  | { kind: 'answer'; answer: string; flowId: string; flowTitle: string; generated: GeneratedFlow | null };

const STOPWORDS: ReadonlySet<string> = new Set([
  'necesito', 'quiero', 'gustaria', 'puedes', 'podrias', 'cambiar', 'cambia', 'cambie', 'cambiemos', 'cambio',
  'modificar', 'modifica', 'poner', 'ponemos', 'pongamos', 'quitar', 'anadir', 'agregar', 'cuando', 'donde', 'para',
  'como', 'este', 'esta', 'esto', 'estos', 'esas', 'nuestro', 'sale', 'salga', 'tambien', 'todo', 'with', 'when',
  'change', 'need', 'want', 'please', 'make', 'that', 'this', 'from', 'into',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Texto del flujo donde se buscan las palabras clave (minúsculas, sin tildes). */
function flowHaystack(flow: Record<string, unknown>): string {
  const parts: string[] = [str(flow['title']), str(flow['question']), str(flow['summary'])];
  for (const lane of Array.isArray(flow['lanes']) ? flow['lanes'] : []) parts.push(str(asObject(lane)?.['name']));
  for (const step of Array.isArray(flow['steps']) ? flow['steps'] : []) {
    const s = asObject(step);
    if (!s) continue;
    parts.push(str(s['label']), str(s['title']), str(asObject(s['ref'])?.['file']));
  }
  for (const file of Array.isArray(flow['files']) ? flow['files'] : []) {
    parts.push(typeof file === 'string' ? file : str(asObject(file)?.['file']));
  }
  return foldAccents(parts.join(' ')).toLowerCase();
}

/** Heurística local (sin IA): ¿el flujo abierto está relacionado con la petición? */
export function isFlowRelevant(flow: unknown, text: string): boolean {
  const obj = asObject(flow);
  if (!obj) return false;
  const words = [...new Set(foldAccents(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4))]
    .filter((w) => !STOPWORDS.has(w));
  if (!words.length) {
    trazaLog().info('Cambio: flujo abierto relevante=false hits=0/0');
    return false;
  }
  const haystack = flowHaystack(obj);
  const hits = words.filter((w) => haystack.includes(w) || (w.length >= 6 && haystack.includes(w.slice(0, 5)))).length;
  const relevant = hits >= 2 || (words.length <= 2 && hits >= 1);
  trazaLog().info(`Cambio: flujo abierto relevante=${relevant} hits=${hits}/${words.length}`);
  return relevant;
}

export async function runChangeRequest(context: vscode.ExtensionContext, ai: HostAi, opts: ChangeRunOptions): Promise<ChangeRunResult> {
  const es = isSpanish();
  let flow: unknown;
  let flowTitle: string;
  let generated: GeneratedFlow | null = null;
  const current = FlowPanel.currentFlow();
  if (current && isFlowRelevant(current.flow, `${opts.request} ${opts.flowQuestion ?? ''}`)) {
    flow = current.flow;
    flowTitle = current.title;
  } else {
    opts.progress?.(es ? 'Buscando el flujo relacionado con el cambio…' : 'Finding the flow related to the change…');
    generated = await ai.generateFlow({
      question: opts.flowQuestion ?? opts.request,
      ...(opts.model ? { model: opts.model } : {}),
      pinned: opts.pinned,
      useActiveEditor: opts.useActiveEditor,
      token: opts.token,
      ...(opts.progress ? { progress: opts.progress } : {}),
      scenario: false,
      ...(opts.folder ? { folder: opts.folder } : {}),
    });
    flow = generated.flow;
    flowTitle = generated.title;
  }
  const flowObj = asObject(flow);
  const flowId = flowObj && typeof flowObj['id'] === 'string' ? flowObj['id'] : '';

  opts.progress?.(es ? 'Preparando el cambio…' : 'Preparing the change…');
  let result: Awaited<ReturnType<HostAi['proposeChange']>>;
  try {
    result = await ai.proposeChange({
      question: opts.request,
      flow,
      ...(opts.model ? { model: opts.model } : {}),
      pinned: opts.pinned,
      token: opts.token,
      ...(opts.progress ? { progress: opts.progress } : {}),
    });
  } catch (error: unknown) {
    // El flujo generado no se pierde si la propuesta falla (salvo cancelación).
    if (generated && !isCancelled(error) && !opts.token.isCancellationRequested) FlowPanel.showGenerated(context, ai, generated);
    throw error;
  }
  if ('answer' in result) {
    if (generated) FlowPanel.showGenerated(context, ai, generated);
    return { kind: 'answer', answer: result.answer, flowId, flowTitle, generated };
  }

  const proposal = result.proposal;
  const proposalFlowId = typeof proposal['flowId'] === 'string' ? proposal['flowId'] : '';
  if (proposalFlowId) ai.rememberProposal(proposalFlowId, proposal);
  if (generated) {
    // Flujo recién generado: el panel se abre ya con la propuesta, en «Simular cambios» (puede haber otro flujo abierto).
    const saved = proposalFlowId ? ai.proposalsFor(proposalFlowId) : [];
    FlowPanel.show(context, ai, {
      flow: generated.flow, sample: false, title: generated.title, proposals: saved.length ? saved : [proposal],
      source: { model: generated.model }, mode: 'changes',
    });
  } else if (!FlowPanel.addProposal(proposal) && proposalFlowId) {
    const g = ai.flowById(proposalFlowId);
    if (g) {
      FlowPanel.show(context, ai, {
        flow: g.flow, sample: false, title: g.title, proposals: ai.proposalsFor(proposalFlowId),
        source: { model: g.model }, mode: 'changes',
      });
    }
  }
  return { kind: 'proposal', proposal, model: result.model, flowId, flowTitle, generated };
}
