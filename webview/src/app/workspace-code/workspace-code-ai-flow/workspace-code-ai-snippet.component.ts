import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { SnippetView } from '../ai/nexo-ia.types';
import { CodeToken, tokenizeCodeLine } from '../ai/workspace-code-code-tokens';

interface SnippetRow {
  number: number;
  tokens: CodeToken[];
  marked: boolean;
}

/**
 * Fragmento de código de Nexo IA releído del archivo real. El resaltado sale de un tokenizer propio que produce
 * spans (sin `innerHTML` ni Monaco `colorize`). Las referencias no verificadas muestran un aviso y no se abren.
 */
@Component({
  selector: 'app-workspace-code-ai-snippet',
  templateUrl: './workspace-code-ai-snippet.component.html',
  styleUrls: ['../workspace-code-ai-scroll.css', './workspace-code-ai-snippet.component.css'],
  changeDetection: ChangeDetectionStrategy.Default,
})
export class WorkspaceCodeAiSnippetComponent implements OnChanges {
  @Input() view: SnippetView | null = null;
  @Input() tone: 'accent' | 'danger' | 'warning' = 'accent';
  @Input() canOpen = true;
  @Output() open = new EventEmitter<void>();

  rows: SnippetRow[] = [];

  ngOnChanges(): void {
    const view = this.view;
    if (!view) {
      this.rows = [];
      return;
    }
    this.rows = view.lines.map((line, i) => {
      const number = view.startLine + i;
      return { number, tokens: tokenizeCodeLine(line, view.language), marked: number === view.highlightLine };
    });
  }

  get location(): string {
    const view = this.view;
    if (!view) return '';
    if (view.generated) return view.file;
    const name = view.file.slice(view.file.lastIndexOf('/') + 1);
    return `${name}:${view.highlightLine}`;
  }

  get openable(): boolean {
    return this.canOpen && !!this.view?.fileId && this.view.verification !== 'unverified';
  }

  trackRow = (_: number, row: SnippetRow) => row.number;
  trackToken = (index: number) => index;
}
