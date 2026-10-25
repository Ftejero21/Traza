import { Component, Input } from '@angular/core';
import { CaseComparison, ChangeProposal, ComparisonTag, DiffLineKind, FileChange } from '../ai/nexo-ia.changes.types';
import { FlowResultSource, ResultKind, SimulationResult } from '../ai/nexo-ia.types';
import { CodeToken, tokenizeCodeLine } from '../ai/workspace-code-code-tokens';
import { languageOfPath } from '../ai/workspace-code-ai-change-patch';
import { WorkspaceCodeAiChangeService } from '../services/workspace-code-ai-change.service';
import { WorkspaceCodeAiFlowService } from '../services/workspace-code-ai-flow.service';
import { WorkspaceCodeAiUiPreviewService } from '../services/workspace-code-ai-ui-preview.service';

type ChangeCommand = 'ai.applyChange' | 'ai.discardChange' | 'ai.undoChange' | 'ai.simulateChange';

interface DiffRow {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  sign: string;
  tokens: CodeToken[];
}

interface FileView {
  change: FileChange;
  hunks: { header: string; rows: DiffRow[] }[];
}

const TAGS: ComparisonTag[] = ['fixed', 'better', 'same', 'regression'];

/**
 * Modo «Simular cambios» de la pestaña del flujo: a la izquierda el diff propuesto (por archivo y bloque) con sus
 * acciones; a la derecha la comparación antes/después de cada caso (chips, tabla y tarjetas). La reproducción la lleva
 * `WorkspaceCodeAiFlowService`; las acciones (`ai.*Change`) van directas a `WorkspaceCodeAiChangeService` (en la
 * extensión no hay servicio de comandos).
 */
@Component({
  selector: 'app-workspace-code-ai-changes',
  templateUrl: './workspace-code-ai-changes.component.html',
  styleUrls: ['../workspace-code-ai-scroll.css', './workspace-code-ai-changes.component.css'],
})
export class WorkspaceCodeAiChangesComponent {
  @Input() narrow = false;

  readonly tags = TAGS;
  private cache: { proposal: ChangeProposal; files: FileView[] } | null = null;

  constructor(
    public flowService: WorkspaceCodeAiFlowService,
    public changes: WorkspaceCodeAiChangeService,
    public preview: WorkspaceCodeAiUiPreviewService,
  ) {}

  /** «Visualizar pantalla» de la tarjeta Antes (pestaña «Ahora») o Después (pestaña «Con el cambio»). */
  openPreview(side: 'now' | 'after', event: Event): void {
    event.stopPropagation();
    this.preview.show(side);
  }

  /** En la extensión el id de la propuesta hace de `messageId`. */
  get proposalId(): string | null {
    return this.flowService.activeChange?.messageId ?? null;
  }

  get proposal(): ChangeProposal | null {
    return this.flowService.activeChange?.proposal ?? null;
  }

  /** Comparación de esta propuesta (otra anterior no se muestra). */
  get comparison(): { cases: Required<CaseComparison>[]; source?: FlowResultSource } | null {
    const comparison = this.flowService.ui.comparison;
    return comparison && comparison.proposalId === this.proposal?.id ? comparison : null;
  }

  get current(): Required<CaseComparison> | null {
    return this.comparison ? this.flowService.currentCase : null;
  }

  get side(): 'before' | 'after' {
    return this.flowService.ui.changeSide;
  }

  get files(): FileView[] {
    const proposal = this.proposal;
    if (!proposal) return [];
    if (this.cache?.proposal !== proposal) {
      this.cache = {
        proposal,
        files: proposal.files.map((change) => {
          const language = languageOfPath(change.path);
          return {
            change,
            hunks: change.hunks.map((h) => ({
              header: h.header,
              rows: h.lines.map((l) => ({
                kind: l.kind,
                oldLine: l.oldLine,
                newLine: l.newLine,
                sign: l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ',
                tokens: tokenizeCodeLine(l.text, language),
              })),
            })),
          };
        }),
      };
    }
    return this.cache.files;
  }

  get blockReason(): string | null {
    return this.proposalId && this.proposal?.status === 'pending' ? this.changes.applyBlockReason(this.proposalId) : null;
  }

  count(tag: ComparisonTag): number {
    return this.comparison?.cases.filter((c) => c.tag === tag).length ?? 0;
  }

  fileIcon(file: FileChange): string {
    return file.status === 'added' ? 'bi-file-earmark-plus' : file.status === 'deleted' ? 'bi-file-earmark-minus' : 'bi-file-earmark-code';
  }

  /** Badge del resultado seguido de `· Pn` si hay un paso que falla. */
  resultText(result: SimulationResult): string {
    // Texto fijo para ok/error (el `badge` del modelo cambia de redacción entre Antes y Después).
    const badge = result.kind === 'ok' ? `${result.httpStatus ?? 200} OK`
      : result.kind === 'error' ? (result.httpStatus ? `Error ${result.httpStatus}` : 'Error')
      : result.badge || result.kind;
    const index = result.failStepId && (result.kind === 'error' || result.kind === 'stop')
      ? this.flowService.flow?.steps.findIndex((s) => s.id === result.failStepId) ?? -1
      : -1;
    return index >= 0 ? `${badge} · P${index + 1}` : badge;
  }

  badgeIcon(kind: ResultKind): string {
    return kind === 'error' ? 'bi-x-octagon-fill' : kind === 'stop' ? 'bi-pause-circle-fill' : kind === 'ok' ? 'bi-check-circle-fill' : 'bi-question-circle';
  }

  run(command: ChangeCommand, event: Event): void {
    event.stopPropagation();
    const id = this.proposalId;
    if (!id || !this.canRun(command)) return;
    switch (command) {
      case 'ai.applyChange':
        void this.changes.apply(id);
        break;
      case 'ai.discardChange':
        this.changes.discard(id);
        break;
      case 'ai.undoChange':
        void this.changes.undo(id);
        break;
      case 'ai.simulateChange':
        void this.changes.simulate(id);
        break;
    }
  }

  canRun(command: ChangeCommand): boolean {
    const id = this.proposalId;
    if (!id) return false;
    switch (command) {
      case 'ai.applyChange':
        return this.changes.canApply(id);
      case 'ai.discardChange':
        return this.changes.canDiscard(id);
      case 'ai.undoChange':
        return this.changes.canUndo(id);
      case 'ai.simulateChange':
        return this.changes.canSimulate(id);
    }
  }

  retry(): void {
    const proposal = this.proposal;
    if (proposal) void this.flowService.compareChange(proposal);
  }

  selectCase(id: string, event: Event): void {
    event.stopPropagation();
    this.flowService.selectCase(id);
  }

  trackFile = (index: number, file: FileView) => `${index}:${file.change.mountId}:${file.change.path}`;
  trackIndex = (index: number) => index;
  trackCase = (_: number, c: Required<CaseComparison>) => c.preset.id;
}
