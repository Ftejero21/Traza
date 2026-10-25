import * as vscode from 'vscode';
import type { ApplyFileWrite, ApplyFilesResult, ProjectFileInfo, ProjectMountInfo, ProjectSnapshot, ReadFileResult, SampleDocument } from '../webview/src/app/bridge/protocol';
import { codeExtension, isBinaryCodeExtension, isSensitiveCodeFile, normalizeCodePath } from './host-guards';

const MAX_FILES = 20_000;
const MAX_TEXT_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_BYTES = 3 * 1024 * 1024;
const EXCLUDE = '{**/node_modules/**,**/dist/**,**/build/**,**/target/**,**/out/**,**/.git/**,**/.angular/**,**/coverage/**,**/.next/**}';

/** Lenguajes de los archivos virtuales del ejemplo → id de lenguaje de VS Code. */
const SAMPLE_LANGUAGES: Record<string, string> = {
  bat: 'bat', ini: 'ini', shell: 'shellscript', plaintext: 'plaintext', cpp: 'cpp', csharp: 'csharp',
};

function warn(message: string, error: unknown): void {
  console.warn(`[Nexo] ${message}`, error instanceof Error ? error.name : '');
}

function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

/** Ruta relativa POSIX del archivo dentro de su carpeta raíz (prefijada con el nombre de la carpeta si hay varias). */
function relativePath(uri: vscode.Uri, folder: vscode.WorkspaceFolder, multi: boolean): string | null {
  const root = folder.uri.path.replace(/\/+$/, '');
  const inside = process.platform === 'win32'
    ? uri.path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : uri.path.startsWith(`${root}/`);
  if (!inside) return null;
  const rel = normalizeCodePath(uri.path.slice(root.length + 1));
  if (!rel) return null;
  return multi ? normalizeCodePath(`${folder.name}/${rel}`) : rel;
}

/** URI de un archivo del workspace validada: dentro de una carpeta abierta, ruta normalizable y no sensible. */
function workspaceUri(fileId: string): vscode.Uri | null {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(fileId, true);
  } catch (error: unknown) {
    warn('Identificador de archivo no válido.', error);
    return null;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || folder.uri.scheme !== uri.scheme || folder.uri.authority !== uri.authority) return null;
  const rel = relativePath(uri, folder, false);
  if (!rel || isSensitiveCodeFile(baseName(rel))) return null;
  return uri;
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
}

async function readBytes(uri: vscode.Uri, maxBytes: number): Promise<Uint8Array | null> {
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.File) === 0 || stat.size > maxBytes) return null;
  const bytes = await vscode.workspace.fs.readFile(uri);
  return bytes.byteLength > maxBytes ? null : bytes;
}

function decodeText(bytes: Uint8Array): ReadFileResult {
  const content = new TextDecoder('utf-8').decode(bytes);
  if (content.includes('\u0000')) return { ok: true, binary: true, content: '' };
  return { ok: true, binary: false, content };
}

/** Lee texto (respetando cambios sin guardar de un documento abierto) o base64. */
async function readUri(uri: vscode.Uri, as: 'text' | 'base64', maxBytes?: number): Promise<ReadFileResult> {
  if (as === 'text') {
    const doc = openDocument(uri);
    if (doc) {
      const text = doc.getText();
      if (text.length > MAX_TEXT_BYTES) return { ok: false, binary: false, content: '' };
      return text.includes('\u0000') ? { ok: true, binary: true, content: '' } : { ok: true, binary: false, content: text };
    }
    const bytes = await readBytes(uri, MAX_TEXT_BYTES);
    return bytes ? decodeText(bytes) : { ok: false, binary: false, content: '' };
  }
  const limit = Math.min(maxBytes ?? MAX_BASE64_BYTES, MAX_BASE64_BYTES);
  const bytes = await readBytes(uri, limit);
  return bytes ? { ok: true, binary: true, content: Buffer.from(bytes).toString('base64') } : { ok: false, binary: true, content: '' };
}

/** Archivos del workspace (solo rutas). Nunca lista archivos sensibles. */
export async function listFiles(): Promise<ProjectSnapshot> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return { mounts: [], files: [] };
  const multi = folders.length > 1;
  const mounts: ProjectMountInfo[] = folders.map((f) => ({ id: f.name, name: f.name, alias: f.name, path: multi ? f.name : '' }));
  const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, MAX_FILES);
  const files: ProjectFileInfo[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) continue;
    const path = relativePath(uri, folder, multi);
    if (!path || seen.has(path)) continue;
    const name = baseName(path);
    if (isSensitiveCodeFile(name)) continue;
    seen.add(path);
    const extension = codeExtension(name);
    files.push({ id: uri.toString(), path, name, extension, binary: isBinaryCodeExtension(extension) });
  }
  return { mounts, files };
}

export async function readFile(fileId: string, as: 'text' | 'base64', maxBytes?: number): Promise<ReadFileResult> {
  const uri = workspaceUri(fileId);
  if (!uri) return { ok: false, binary: false, content: '' };
  try {
    return await readUri(uri, as, maxBytes);
  } catch (error: unknown) {
    warn('No se pudo leer el archivo.', error);
    return { ok: false, binary: false, content: '' };
  }
}

/** Archivo por montaje (carpeta raíz) y ruta relativa; `null` si no existe o no está permitido. */
export async function readMountFile(mountId: string, path: string, as: 'text' | 'base64', maxBytes: number): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders.find((f) => f.name === mountId) ?? (!mountId && folders.length === 1 ? folders[0] : undefined);
  const rel = normalizeCodePath(path);
  if (!folder || !rel || isSensitiveCodeFile(baseName(rel))) return null;
  const uri = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
  if (!workspaceUri(uri.toString())) return null;
  try {
    const read = await readUri(uri, as, maxBytes);
    if (!read.ok || (as === 'text' && read.binary)) return null;
    if (as === 'text' && new TextEncoder().encode(read.content).byteLength > maxBytes) return null;
    return read.content;
  } catch (error: unknown) {
    warn('No se pudo leer el archivo del montaje.', error);
    return null;
  }
}

async function reveal(doc: vscode.TextDocument, line: number): Promise<void> {
  const n = Math.min(Math.max(1, line), Math.max(1, doc.lineCount)) - 1;
  const range = new vscode.Range(n, 0, n, 0);
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true, selection: range });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/** «Abrir en el editor»: archivo del workspace (o documento sin título con el contenido del ejemplo) en la línea. */
export async function openRef(fileId: string, line: number, sample?: SampleDocument): Promise<void> {
  try {
    if (sample) {
      const language = SAMPLE_LANGUAGES[sample.language] ?? sample.language ?? 'plaintext';
      const doc = await vscode.workspace.openTextDocument({ content: sample.content, language });
      await reveal(doc, line);
      return;
    }
    const uri = workspaceUri(fileId);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    await reveal(doc, line);
  } catch (error: unknown) {
    warn('No se pudo abrir el archivo en el editor.', error);
    void vscode.window.showWarningMessage('No se pudo abrir el archivo en el editor.');
  }
}

/**
 * URI de escritura de una ruta de la webview (no confiable): normalizada, primer segmento = carpeta raíz si hay varias,
 * sin archivos sensibles, binarios, `.git` ni `node_modules`, dentro de una carpeta del workspace y en un sistema de
 * archivos con escritura. `null` si no cumple.
 */
function writableUri(raw: string): vscode.Uri | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const rel = normalizeCodePath(raw);
  if (!folders.length || !rel) return null;
  let folder: vscode.WorkspaceFolder | undefined;
  let inner = rel;
  if (folders.length > 1) {
    const slash = rel.indexOf('/');
    if (slash < 0) return null;
    const name = rel.slice(0, slash);
    folder = folders.find((f) => f.name === name);
    inner = rel.slice(slash + 1);
  } else {
    folder = folders[0];
  }
  if (!folder || !inner) return null;
  const segments = inner.split('/');
  const name = segments[segments.length - 1];
  if (isSensitiveCodeFile(name) || isBinaryCodeExtension(codeExtension(name))) return null;
  if (segments.some((s) => s.toLowerCase() === '.git' || s.toLowerCase() === 'node_modules')) return null;
  if (vscode.workspace.fs.isWritableFileSystem(folder.uri.scheme) === false) return null;
  const uri = vscode.Uri.joinPath(folder.uri, ...segments);
  return workspaceUri(uri.toString()) ? uri : null;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error: unknown) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return false;
    throw error;
  }
}

/**
 * Aplica las escrituras de una propuesta en un solo `WorkspaceEdit` (reemplazo completo, archivo nuevo o borrado),
 * guarda los documentos y abre el primero en su línea. Nunca confía en las rutas de la webview.
 */
export async function applyFiles(writes: ApplyFileWrite[]): Promise<ApplyFilesResult> {
  const targets: { uri: vscode.Uri; content: string | null; line?: number }[] = [];
  const seen = new Set<string>();
  for (const write of writes) {
    const uri = writableUri(write.path);
    if (!uri || seen.has(uri.toString())) return { ok: false, error: 'Ruta no permitida para escribir.' };
    seen.add(uri.toString());
    targets.push({ uri, content: write.content, line: write.line });
  }
  const edit = new vscode.WorkspaceEdit();
  const touched: vscode.Uri[] = [];
  try {
    for (const target of targets) {
      if (target.content === null) {
        edit.deleteFile(target.uri, { ignoreIfNotExists: true });
        continue;
      }
      if (await exists(target.uri)) {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        edit.replace(target.uri, full, target.content);
      } else {
        edit.createFile(target.uri, { overwrite: false });
        edit.insert(target.uri, new vscode.Position(0, 0), target.content);
      }
      touched.push(target.uri);
    }
  } catch (error: unknown) {
    warn('No se pudieron preparar los cambios.', error);
    return { ok: false, error: 'No se pudieron preparar los cambios.' };
  }
  let applied: boolean;
  try {
    applied = await vscode.workspace.applyEdit(edit);
  } catch (error: unknown) {
    warn('No se pudieron aplicar los cambios.', error);
    applied = false;
  }
  if (!applied) return { ok: false, error: 'No se pudieron aplicar los cambios.' };
  try {
    let first: vscode.TextDocument | null = null;
    for (const uri of touched) {
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty && !(await doc.save())) return { ok: false, error: 'No se pudieron guardar los cambios.' };
      first = first ?? doc;
    }
    const firstTarget = targets.find((t) => t.content !== null);
    if (first && firstTarget) await reveal(first, firstTarget.line ?? 1);
  } catch (error: unknown) {
    warn('No se pudieron guardar los cambios.', error);
    return { ok: false, error: 'No se pudieron guardar los cambios.' };
  }
  return { ok: true };
}
