import { Injectable } from '@angular/core';
import { NexoBridge } from '../bridge/nexo-bridge';
import { ApplyFileWrite, ApplyFilesResult, ProjectSnapshot, ReadFileResult } from '../bridge/protocol';
import { isContextExcludedPath } from '../workspace-code/ai/workspace-code-context-exclude';
import {
  WorkspaceCodeFile,
  WorkspaceCodeMount,
  codeBaseName,
  codeExtension,
  codeLanguageFor,
  isSensitiveCodeFile,
  normalizeCodePath,
} from '../workspace-code/workspace-code.types';

/** Lectura de un archivo local (misma forma que `WorkspaceCodeFsService.readLocalFile`). */
export interface NexoLocalRead {
  ok: boolean;
  binary: boolean;
  content: string;
}

/**
 * Fachada del proyecto para el validador y la vista de pantalla: imita lo que usan de `WorkspaceCodeStateService`,
 * `WorkspaceCodeFsService` y `WorkspaceCodeAiService` en chatFront. Los archivos del workspace de VS Code se leen
 * bajo demanda por el puente; el ejemplo usa archivos virtuales en memoria.
 */
@Injectable({ providedIn: 'root' })
export class NexoProjectService {
  project: { files: WorkspaceCodeFile[]; mounts: WorkspaceCodeMount[] } = { files: [], mounts: [] };
  /** El proyecto es el ejemplo (archivos virtuales). */
  sample = false;
  private byPath = new Map<string, WorkspaceCodeFile>();

  constructor(private bridge: NexoBridge) {}

  fileByPath(path: string): WorkspaceCodeFile | null {
    return this.byPath.get(path) ?? null;
  }

  isExcluded(_path: string): boolean {
    return false;
  }

  canRead(file: WorkspaceCodeFile): boolean {
    return !!file.local;
  }

  /** Filtro de archivos permitidos para Nexo IA (sin binarios, sensibles ni rutas excluidas del contexto). */
  async fileFilter(): Promise<(file: WorkspaceCodeFile) => boolean> {
    return (f: WorkspaceCodeFile) => !f.binary && !isSensitiveCodeFile(f.name) && !isContextExcludedPath(f.path);
  }

  /** Proyecto de ejemplo: archivos virtuales ya cargados y un único montaje. */
  useSample(files: Record<string, string>): void {
    const list: WorkspaceCodeFile[] = [];
    for (const [raw, content] of Object.entries(files)) {
      const path = normalizeCodePath(raw);
      if (!path) continue;
      const name = codeBaseName(path);
      list.push({
        id: `sample:${path}`, path, name, extension: codeExtension(name), language: codeLanguageFor(name),
        content, binary: false, lastModified: 0, local: false, loaded: true,
      });
    }
    this.setProject(list, [{ id: '', name: 'sample', alias: 'sample', path: '' }]);
    this.sample = true;
  }

  /** Lista de archivos del workspace de VS Code (solo rutas; el contenido se lee al validar). */
  async loadFromHost(): Promise<void> {
    let snapshot: ProjectSnapshot | null = null;
    try {
      snapshot = await this.bridge.request<ProjectSnapshot>({ op: 'listFiles' });
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo listar los archivos del workspace.', error instanceof Error ? error.name : '');
    }
    const files: WorkspaceCodeFile[] = [];
    for (const f of snapshot?.files ?? []) {
      const path = normalizeCodePath(f.path);
      if (!path || typeof f.id !== 'string') continue;
      const name = codeBaseName(path);
      files.push({
        id: f.id, path, name, extension: codeExtension(name), language: codeLanguageFor(name),
        content: '', binary: !!f.binary, lastModified: 0, local: true, loaded: false,
      });
    }
    const mounts = (snapshot?.mounts ?? []).map(({ id, name, alias, path }) => ({ id, name, alias, path }));
    this.setProject(files, mounts);
    this.sample = false;
  }

  async readLocalFile(file: WorkspaceCodeFile): Promise<NexoLocalRead> {
    if (!file.local) return { ok: true, binary: file.binary, content: file.content };
    try {
      const read = await this.bridge.request<ReadFileResult | null>({ op: 'readFile', fileId: file.id, as: 'text' });
      if (!read || typeof read.content !== 'string') return { ok: false, binary: false, content: '' };
      return { ok: !!read.ok, binary: !!read.binary, content: read.content };
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo leer el archivo.', error instanceof Error ? error.name : '');
      return { ok: false, binary: false, content: '' };
    }
  }

  async readLocalBase64(file: WorkspaceCodeFile, maxBytes: number): Promise<string | null> {
    if (!file.local) return null;
    try {
      const read = await this.bridge.request<ReadFileResult | null>({ op: 'readFile', fileId: file.id, as: 'base64', maxBytes });
      return read && read.ok && typeof read.content === 'string' ? read.content : null;
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo leer el archivo binario.', error instanceof Error ? error.name : '');
      return null;
    }
  }

  async readMountDisk(mountId: string, relPath: string, maxBytes: number, as: 'text' | 'base64'): Promise<string | null> {
    if (this.sample) return null;
    try {
      const read = await this.bridge.request<string | null>({ op: 'readMountFile', mountId, path: relPath, as, maxBytes });
      return typeof read === 'string' ? read : null;
    } catch (error: unknown) {
      console.warn('[Traza] No se pudo leer el archivo del montaje.', error instanceof Error ? error.name : '');
      return null;
    }
  }

  /**
   * Escribe archivos (`content: null` = borrar). En el ejemplo, en memoria; en VS Code, el host valida las rutas, aplica
   * un `WorkspaceEdit`, guarda y abre el primero. Después se vuelve a listar el workspace.
   */
  async writeFiles(writes: ApplyFileWrite[]): Promise<ApplyFilesResult> {
    if (this.sample) {
      const files = [...this.project.files];
      for (const write of writes) {
        const path = normalizeCodePath(write.path);
        if (!path) return { ok: false, error: 'Ruta no válida.' };
        const index = files.findIndex((f) => f.path === path);
        if (write.content === null) {
          if (index >= 0) files.splice(index, 1);
          continue;
        }
        const name = codeBaseName(path);
        const file: WorkspaceCodeFile = {
          id: `sample:${path}`, path, name, extension: codeExtension(name), language: codeLanguageFor(name),
          content: write.content, binary: false, lastModified: Date.now(), local: false, loaded: true,
        };
        if (index >= 0) files[index] = file;
        else files.push(file);
      }
      this.setProject(files, this.project.mounts);
      return { ok: true };
    }
    const result = await this.bridge.request<ApplyFilesResult>({ op: 'applyFiles', writes });
    if (!result?.ok) return { ok: false, error: result?.error };
    await this.loadFromHost();
    return { ok: true };
  }

  private setProject(files: WorkspaceCodeFile[], mounts: WorkspaceCodeMount[]): void {
    this.project = { files, mounts };
    this.byPath = new Map(files.map((f) => [f.path, f]));
  }
}
