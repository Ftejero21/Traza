import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AppComponent } from './app.component';
import { MockBridge } from './bridge/mock-bridge';
import { NexoBridge } from './bridge/nexo-bridge';
import { VsCodeBridge } from './bridge/vscode-bridge';
import { WorkspaceCodeI18nPipe } from './workspace-code/i18n/workspace-code-i18n.service';
import { WorkspaceCodeAiFlowComponent } from './workspace-code/workspace-code-ai-flow/workspace-code-ai-flow.component';
import { WorkspaceCodeAiSnippetComponent } from './workspace-code/workspace-code-ai-flow/workspace-code-ai-snippet.component';
import { WorkspaceCodeAiChangesComponent } from './workspace-code/workspace-code-ai-flow/workspace-code-ai-changes.component';
import { WorkspaceCodeDbTableDiagramComponent } from './workspace-code/workspace-code-db/workspace-code-db-table-diagram.component';

/** `VsCodeBridge` dentro de VS Code; `MockBridge` solo cuando no existe `acquireVsCodeApi` (navegador). */
export function bridgeFactory(): NexoBridge {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function' ? new VsCodeBridge() : new MockBridge();
}

@NgModule({
  declarations: [
    AppComponent, WorkspaceCodeAiFlowComponent, WorkspaceCodeAiSnippetComponent, WorkspaceCodeAiChangesComponent,
    WorkspaceCodeDbTableDiagramComponent, WorkspaceCodeI18nPipe,
  ],
  imports: [BrowserModule],
  providers: [{ provide: NexoBridge, useFactory: bridgeFactory }],
  bootstrap: [AppComponent],
})
export class AppModule {}
