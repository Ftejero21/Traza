import { Injectable, OnDestroy } from '@angular/core';
import { NexoBridge } from '../../bridge/nexo-bridge';
import { ApplyFileWrite, ApplyFilesResult } from '../../bridge/protocol';
import { NexoProjectService } from '../../project/nexo-project.service';
import { WorkspaceCodeI18nService } from '../i18n/workspace-code-i18n.service';
import { WorkspaceCodeFile, codeExtension, isBinaryCodeExtension, isSensitiveCodeFile } from '../workspace-code.types';
import { ChangeProposal, FileChange, UndoSnapshot } from '../ai/nexo-ia.changes.types';
import { FlowDiagram } from '../ai/nexo-ia.types';
import { applyFileChange, proposalStats, resolveChangeTarget, sanitizeChangeProposal, sha256Hex } from '../ai/workspace-code-ai-change-patch';
import { isContextExcludedPath } from '../ai/workspace-code-context-exclude';
import { WorkspaceCodeAiFlowService } from './workspace-code-ai-flow.service';
import { WorkspaceCodeNotifyService } from './workspace-code-notify.service';

/** Propuestas que se cargan como máximo con un flujo. */
const MAX_PROPOSALS = 10;

type Found = { proposal: ChangeProposal };
type Target = { change: FileChange; path: string };

/**
 * Ciclo de vida de los cambios propuestos por Nexo IA: aplicar (comprobación de `baseHash`, confirmación por regresiones
 * y escritura en el workspace), descartar, deshacer (snapshot solo en memoria) y simular (comparación antes/después en
 * la vista del flujo). Copia de chatFront adaptada a la extensión: las propuestas llegan con el JSON del flujo (no hay
 * chat) y viven en `proposals`; el id de la propuesta hace de `messageId`. Las escrituras y los diálogos los hace el host.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceCodeAiChangeService implements OnDestroy {
  /** Propuestas del flujo abierto (se sustituyen en cada apertura). */
  proposals: ChangeProposal[] = [];
  /** Contenido anterior de cada propuesta aplicada (solo en memoria: tras recargar no se ofrece Deshacer). */
  private readonly snapshots = new Map<string, UndoSnapshot>();
  private readonly running = new Set<string>();
  private readonly lookup = (flowId: string) => this.lookupFlow(flowId);
  private seq = 0;

  constructor(
    private flow: WorkspaceCodeAiFlowService,
    private project: NexoProjectService,
    private notify: WorkspaceCodeNotifyService,
    private i18n: WorkspaceCodeI18nService,
    private bridge: NexoBridge,
  ) {
    this.flow.changeLookup = this.lookup;
  }

  ngOnDestroy(): void {
    if (this.flow.changeLookup === this.lookup) this.flow.changeLookup = null;
    this.snapshots.clear();
    this.running.clear();
  }

  /* ---------------------------- carga ---------------------------- */

  /**
   * Propuestas que llegan con el flujo: saneadas, con rutas resueltas de forma estricta y permitidas, cada bloque
   * encajado contra el archivo real (`oldStart` corregido, números de línea y contadores) y el `baseHash` del contenido
   * leído (igual que `proposalFromResponse` de chatFront). Las inválidas se omiten con un aviso en la consola.
   * Con `refresh = false` no avisa al servicio del flujo (el llamador abre el flujo y lo refresca después).
   */
  async load(raw: unknown[], flow: FlowDiagram | null, refresh = true): Promise<void> {
    this.snapshots.clear();
    this.running.clear();
    const list: ChangeProposal[] = [];
    for (const item of (Array.isArray(raw) ? raw : []).slice(0, MAX_PROPOSALS)) {
      try {
        const proposal = await this.fromRaw(item, flow, list);
        if (proposal) list.push(proposal);
      } catch (error: unknown) {
        console.warn('[Traza] No se pudo cargar una propuesta de cambio.', error instanceof Error ? error.name : '');
      }
    }
    this.proposals = list;
    if (refresh) this.flow.refreshChange();
  }

  private async fromRaw(raw: unknown, flow: FlowDiagram | null, loaded: ChangeProposal[]): Promise<ChangeProposal | null> {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const request = typeof record?.['request'] === 'string' ? (record['request'] as string) : '';
    const proposal = sanitizeChangeProposal(raw, request, false);
    if (!proposal) {
      console.warn('[Traza] Propuesta de cambio con formato no válido: se omite.');
      return null;
    }
    const mounts = this.project.project.mounts;
    const byPath = (path: string) => this.project.fileByPath(path);
    const files: FileChange[] = [];
    const paths = new Set<string>();
    for (const change of proposal.files) {
      const target = resolveChangeTarget(mounts, byPath, change);
      if (!target || !this.allowed(target.path) || paths.has(target.path)) {
        console.warn('[Traza] Propuesta de cambio con una ruta no permitida: se omite.');
        return null;
      }
      paths.add(target.path);
      const file = this.project.fileByPath(target.path) ?? null;
      const original = file ? await this.readChangeFile(file) : null;
      if (file && original === null) {
        console.warn('[Traza] Propuesta de cambio sobre un archivo que no se puede leer: se omite.');
        return null;
      }
      const applied = applyFileChange(original, change);
      if (!applied.ok) {
        console.warn('[Traza] Propuesta de cambio cuyo diff no encaja con el archivo: se omite.');
        return null;
      }
      files.push({
        ...change,
        hunks: applied.hunks,
        additions: applied.additions,
        deletions: applied.deletions,
        baseHash: original === null ? null : await sha256Hex(original),
      });
    }
    let id = proposal.id;
    if (loaded.some((p) => p.id === id)) {
      id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `chg-${Date.now().toString(36)}-${++this.seq}`;
    }
    // flowId: solo el flujo abierto; si no lo trae, el flujo abierto cuando tiene pasos en alguno de los archivos cambiados.
    let flowId = flow && proposal.flowId === flow.id ? flow.id : null;
    if (!flowId && flow && !proposal.flowId) {
      const touches = flow.steps.some((s) => {
        if (!s.ref?.file) return false;
        const target = resolveChangeTarget(mounts, byPath, { mountId: s.ref.mountId ?? '', path: s.ref.file });
        return !!target && paths.has(target.path);
      });
      if (touches) flowId = flow.id;
    }
    return { ...proposal, id, flowId, files, status: 'pending' };
  }

  /** Rutas en las que Nexo IA puede escribir: nunca sensibles, binarias ni excluidas del contexto. */
  private allowed(path: string): boolean {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return !!name && !isSensitiveCodeFile(name) && !isBinaryCodeExtension(codeExtension(name)) && !isContextExcludedPath(path);
  }

  private async readChangeFile(file: WorkspaceCodeFile): Promise<string | null> {
    const read = await this.project.readLocalFile(file);
    return read.ok && !read.binary ? read.content : null;
  }

  /* ---------------------------- consultas ---------------------------- */

  /** Propuesta `messageId` (id de la propuesta) o, sin él, la última que cumple `accept`. */
  find(messageId?: string | null, accept: (p: ChangeProposal) => boolean = (p) => p.status === 'pending'): Found | null {
    const list = this.proposals;
    if (messageId) {
      const proposal = list.find((p) => p.id === messageId);
      return proposal ? { proposal } : null;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (accept(list[i])) return { proposal: list[i] };
    }
    return null;
  }

  canApply(messageId?: string | null): boolean {
    const found = this.find(messageId);
    return !!found && found.proposal.status === 'pending' && !this.running.has(found.proposal.id) && !this.applyBlockReason(found.proposal.id);
  }

  canDiscard(messageId?: string | null): boolean {
    const found = this.find(messageId);
    return !!found && found.proposal.status === 'pending' && !this.running.has(found.proposal.id);
  }

  canUndo(messageId?: string | null): boolean {
    const found = this.find(messageId, (p) => p.status === 'applied' && this.snapshots.has(p.id));
    return !!found && found.proposal.status === 'applied' && this.snapshots.has(found.proposal.id) && !this.running.has(found.proposal.id);
  }

  canSimulate(messageId?: string | null): boolean {
    const found = this.find(messageId, (p) => p.status === 'pending' && !!p.flowId);
    return !!found && found.proposal.status === 'pending' && !!found.proposal.flowId && !!this.flowFor(found.proposal.flowId) && !this.flow.ui.changeBusy;
  }

  /** Motivo por el que no se puede aplicar (workspace sin carpetas), o `null`. */
  applyBlockReason(messageId?: string | null): string | null {
    const found = this.find(messageId);
    if (!found) return null;
    if (!this.project.sample && this.project.project.mounts.length === 0) return this.i18n.t('aiChange.block.readOnly');
    return null;
  }

  isRunning(messageId: string): boolean {
    return this.running.has(messageId);
  }

  /** Flujo de la propuesta: el abierto si tiene ese id. */
  flowFor(flowId: string | null): FlowDiagram | null {
    if (!flowId) return null;
    return this.flow.flow?.id === flowId ? this.flow.flow : null;
  }

  private lookupFlow(flowId: string): { messageId: string; proposal: ChangeProposal } | null {
    const list = this.proposals;
    for (let i = list.length - 1; i >= 0; i--) {
      const change = list[i];
      if (change.flowId === flowId && (change.status === 'pending' || change.status === 'applied')) return { messageId: change.id, proposal: change };
    }
    return null;
  }

  /* ---------------------------- acciones ---------------------------- */

  /** Pasa la vista del flujo a «Simular cambios» y lanza la comparación antes/después. */
  async simulate(messageId?: string | null): Promise<void> {
    if (!this.canSimulate(messageId)) return;
    const found = this.find(messageId, (p) => p.status === 'pending' && !!p.flowId);
    const diagram = found ? this.flowFor(found.proposal.flowId) : null;
    if (!found || !diagram) {
      this.notify.show(this.i18n.t('aiChange.noFlow'), 'warning');
      return;
    }
    this.flow.setMode('changes');
    this.notify.show(this.i18n.t('aiChange.comparing'), 'info');
    const outcome = await this.flow.compareChange(found.proposal);
    if (outcome.status === 'error') {
      this.notify.show(outcome.message, 'danger');
      return;
    }
    if (outcome.status !== 'ok') return;
    const cases = this.flow.ui.comparison?.cases ?? [];
    this.notify.show(this.i18n.t('aiChange.simulated', {
      fixed: cases.filter((c) => c.tag === 'fixed').length,
      regressions: cases.filter((c) => c.tag === 'regression').length,
      total: cases.length,
    }), cases.some((c) => c.tag === 'regression') ? 'warning' : 'success');
  }

  async apply(messageId?: string | null): Promise<void> {
    const found = this.find(messageId);
    if (!found || found.proposal.status !== 'pending' || this.running.has(found.proposal.id)) return;
    const block = this.applyBlockReason(found.proposal.id);
    if (block) {
      this.notify.show(block, 'warning');
      return;
    }
    this.running.add(found.proposal.id);
    this.flow.refreshChange();
    try {
      await this.applyProposal(found);
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo aplicar el cambio propuesto.', error instanceof Error ? error.name : '');
      this.notify.show(this.i18n.t('aiChange.applyFailed'), 'danger');
    } finally {
      this.running.delete(found.proposal.id);
      this.flow.refreshChange();
    }
  }

  private async applyProposal({ proposal }: Found): Promise<void> {
    // 1. Rutas: resolución estricta y solo archivos permitidos.
    const targets: Target[] = [];
    for (const change of proposal.files) {
      const target = resolveChangeTarget(this.project.project.mounts, (p) => this.project.fileByPath(p), change);
      if (!target || !this.allowed(target.path)) {
        this.notify.show(this.i18n.t('aiChange.notAllowed'), 'danger');
        return;
      }
      targets.push({ change, path: target.path });
    }

    // 2. Contenido actual y `baseHash` (un archivo nuevo que ya existe también es conflicto).
    const current = new Map<string, string | null>();
    let conflict = false;
    for (const { change, path } of targets) {
      const file = this.project.fileByPath(path);
      if (change.status === 'added') {
        if (file) conflict = true;
        current.set(path, null);
        continue;
      }
      if (!file) {
        conflict = true;
        continue;
      }
      const content = await this.readChangeFile(file);
      if (content === null) {
        this.notify.show(this.i18n.t('aiChange.notAllowed'), 'danger');
        return;
      }
      if (change.baseHash && (await sha256Hex(content)) !== change.baseHash) conflict = true;
      current.set(path, content);
    }
    if (conflict) {
      this.onConflict(proposal);
      return;
    }

    // 3. Contenido nuevo.
    const writes: ApplyFileWrite[] = [];
    for (const { change, path } of targets) {
      const applied = applyFileChange(current.get(path) ?? null, change);
      if (!applied.ok) {
        this.onConflict(proposal);
        return;
      }
      writes.push({ path, content: applied.content, line: applied.hunks[0]?.newStart || 1 });
    }

    // 4. Regresiones de la última comparación: confirmación extra que nombra los casos.
    const comparison = this.flow.ui.comparison;
    if (comparison?.proposalId === proposal.id) {
      const regressions = comparison.cases.filter((c) => c.tag === 'regression');
      if (regressions.length) {
        const ok = await this.confirm(
          this.i18n.t('aiChange.regressionConfirm.title'),
          this.i18n.t('aiChange.regressionConfirm.message', { cases: regressions.map((c) => c.preset.label).join(', ') }),
          this.i18n.t('aiChange.regressionConfirm.confirm'),
        );
        if (!ok) return;
      }
    }

    // 5. Permisos de escritura.
    const block = this.applyBlockReason(proposal.id);
    if (block) {
      this.notify.show(block, 'warning');
      return;
    }

    // 6. Snapshot y escritura (si falla, se intenta restaurar lo anterior).
    const snapshot: UndoSnapshot = {
      proposalId: proposal.id,
      files: targets.map(({ change, path }) => ({ mountId: change.mountId, path, previousContent: current.get(path) ?? null, appliedHash: '' })),
      appliedAt: new Date().toISOString(),
    };
    const result = await this.writeFiles(writes);
    if (!result.ok) {
      const restore = await this.writeFiles(snapshot.files.map((f) => ({ path: f.path, content: f.previousContent })));
      if (!restore.ok) console.warn('[Traza] No se pudo restaurar el contenido tras un fallo al aplicar.');
      this.notify.show(result.error || this.i18n.t('aiChange.applyFailed'), 'danger');
      return;
    }
    const written = new Map(writes.map((w) => [w.path, w.content]));
    for (const entry of snapshot.files) {
      const content = written.get(entry.path);
      entry.appliedHash = typeof content === 'string' ? await sha256Hex(content) : '';
    }

    // 7. Estado y flujo.
    this.snapshots.set(proposal.id, snapshot);
    this.setChangeStatus(proposal.id, 'applied');
    this.notify.show(this.i18n.t('aiChange.applied', { n: targets.length }), 'success');
    this.flow.clearSimResults();
    void this.flow.revalidate();
    this.flow.refreshChange();
  }

  /** Conflicto: el archivo cambió desde que se generó la propuesta (aquí no hay chat para regenerarla). */
  private onConflict(proposal: ChangeProposal): void {
    this.setChangeStatus(proposal.id, 'conflict');
    this.flow.refreshChange();
    this.notify.show(this.i18n.t('aiChange.conflict'), 'warning');
  }

  discard(messageId?: string | null): void {
    const found = this.find(messageId);
    if (!found || found.proposal.status !== 'pending' || this.running.has(found.proposal.id)) return;
    this.setChangeStatus(found.proposal.id, 'discarded');
    this.notify.show(this.i18n.t('aiChange.discarded'), 'info');
    this.flow.refreshChange();
  }

  async undo(messageId?: string | null): Promise<void> {
    const found = this.find(messageId, (p) => p.status === 'applied' && this.snapshots.has(p.id));
    if (!found || found.proposal.status !== 'applied' || this.running.has(found.proposal.id)) return;
    const snapshot = this.snapshots.get(found.proposal.id);
    if (!snapshot) return;
    this.running.add(found.proposal.id);
    try {
      await this.undoProposal(found, snapshot);
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo deshacer el cambio aplicado.', error instanceof Error ? error.name : '');
      this.notify.show(this.i18n.t('aiChange.applyFailed'), 'danger');
    } finally {
      this.running.delete(found.proposal.id);
      this.flow.refreshChange();
    }
  }

  private async undoProposal({ proposal }: Found, snapshot: UndoSnapshot): Promise<void> {
    // Solo si ningún archivo se ha vuelto a tocar desde que se aplicó.
    const touched: string[] = [];
    for (const entry of snapshot.files) {
      const file = this.project.fileByPath(entry.path);
      if (!entry.appliedHash) {
        if (file) touched.push(entry.path);
        continue;
      }
      const content = file ? await this.readChangeFile(file) : null;
      if (content === null || (await sha256Hex(content)) !== entry.appliedHash) touched.push(entry.path);
    }
    if (touched.length) {
      const names = touched.map((p) => p.slice(p.lastIndexOf('/') + 1)).join(', ');
      const text = this.i18n.t('aiChange.undoTouched', { files: names });
      this.notify.show(text, 'warning');
      if (await this.confirm(this.i18n.t('aiChange.undo'), text, this.i18n.t('aiChange.openDiff'))) this.openFile(touched[0]);
      return;
    }
    const block = this.applyBlockReason(proposal.id);
    if (block) {
      this.notify.show(block, 'warning');
      return;
    }
    const result = await this.writeFiles(snapshot.files.map((f) => ({ path: f.path, content: f.previousContent })));
    if (!result.ok) {
      this.notify.show(result.error || this.i18n.t('aiChange.applyFailed'), 'danger');
      return;
    }
    this.snapshots.delete(proposal.id);
    this.setChangeStatus(proposal.id, 'pending');
    this.notify.show(this.i18n.t('aiChange.undone', { n: snapshot.files.length }), 'success');
    this.flow.clearSimResults();
    void this.flow.revalidate();
    this.flow.refreshChange();
  }

  /* ---------------------------- utilidades ---------------------------- */

  private setChangeStatus(id: string, status: ChangeProposal['status']): void {
    this.proposals = this.proposals.map((p) => (p.id === id ? { ...p, status } : p));
  }

  private async writeFiles(writes: ApplyFileWrite[]): Promise<ApplyFilesResult> {
    try {
      return await this.project.writeFiles(writes);
    } catch (error: unknown) {
      console.warn('[Traza] No se pudieron escribir los archivos.', error instanceof Error ? error.name : '');
      return { ok: false, error: (error instanceof Error && error.message) || this.i18n.t('aiChange.applyFailed') };
    }
  }

  /** Diálogo modal de VS Code (`window.confirm` en el navegador). */
  private async confirm(title: string, message: string, confirm: string): Promise<boolean> {
    try {
      return (await this.bridge.request<boolean>({ op: 'confirm', title: title.slice(0, 200), message: message.slice(0, 1000), confirm: confirm.slice(0, 60) })) === true;
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo mostrar la confirmación.', error instanceof Error ? error.name : '');
      this.notify.show(this.i18n.t('ai.error.generic'), 'danger');
      return false;
    }
  }

  /** Abre el archivo en el editor (sustituye al diff de Git del original). */
  private openFile(path: string, line = 1): void {
    const file = this.project.fileByPath(path);
    if (!file) return;
    this.bridge.post({
      type: 'openRef',
      fileId: file.id,
      line,
      ...(this.project.sample ? { sample: { path: file.path, content: file.content, language: file.language } } : {}),
    });
  }

  stats(proposal: ChangeProposal): { additions: number; deletions: number; files: number } {
    return proposalStats(proposal);
  }
}
