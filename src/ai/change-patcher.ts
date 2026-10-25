/**
 * Port de `WorkspaceCodeChangePatcher.afterWindows` (chatBack): aplica en memoria un cambio propuesto sobre las
 * ventanas de código de «Simular cambios» (nunca escribe en disco). Cada bloque tiene que caber entero en una ventana
 * de su archivo y sus líneas de contexto y eliminadas tienen que coincidir (sin espacios finales) con la ventana.
 */

export const MAX_WINDOW = 8000;
export const MAX_WINDOWS = 24;

export interface CodeWindow {
  path: string;
  startLine: number | null;
  endLine: number | null;
  content: string;
}

export interface ChangeLine {
  kind: string;
  text: string;
}

export interface ChangeHunk {
  oldStart: number;
  newStart: number;
  lines: ChangeLine[];
}

export interface ChangeFile {
  path: string;
  status: string;
  hunks: ChangeHunk[];
}

/** El diff no encaja con las ventanas o el resultado no cabe. El mensaje es un código corto (sin código fuente). */
export class PatchError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PatchError';
  }
}

interface Placement {
  hunk: ChangeHunk;
  oldStart: number;
  oldCount: number;
  delta: number;
}

function oldEnd(p: Placement): number {
  return p.oldCount > 0 ? p.oldStart + p.oldCount - 1 : p.oldStart;
}

function startLine(window: CodeWindow): number {
  return window.startLine === null || window.startLine === undefined || window.startLine < 1 ? 1 : window.startLine;
}

function windowOf(windows: CodeWindow[], path: string, placement: Placement): number {
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (path !== window.path || window.content === null || window.content === undefined) continue;
    const start = startLine(window);
    const end = start + window.content.split('\n').length - 1;
    const fits = placement.oldCount > 0
      ? start <= placement.oldStart && oldEnd(placement) <= end
      : start - 1 <= placement.oldStart && placement.oldStart <= end;
    if (fits) return i;
  }
  return -1;
}

function checkContext(window: CodeWindow, placement: Placement): void {
  const lines = window.content.split('\n');
  const offset = placement.oldStart - startLine(window);
  let k = 0;
  for (const line of placement.hunk.lines) {
    if (line.kind === 'add') continue;
    const index = offset + k;
    if (index < 0 || index >= lines.length || lines[index].trimEnd() !== line.text.trimEnd()) throw new PatchError('context-mismatch');
    k++;
  }
}

function deltaBefore(all: Placement[] | undefined, inside: Placement[], windowStart: number): number {
  if (!all) return 0;
  let delta = 0;
  for (const placement of all) {
    if (!inside.includes(placement) && oldEnd(placement) < windowStart) delta += placement.delta;
  }
  return delta;
}

function length(lines: string[], from: number, to: number): number {
  if (to < from) return 0;
  let total = to - from;
  for (let i = from; i <= to; i++) total += lines[i].length;
  return total;
}

function patchWindow(window: CodeWindow, inside: Placement[], all: Placement[] | undefined): CodeWindow {
  const start = startLine(window);
  const source = window.content.split('\n');
  const sorted = [...inside].sort((a, b) => a.oldStart - b.oldStart || a.oldCount - b.oldCount);
  const result: string[] = [];
  let cursor = 0;
  let changedFrom = -1;
  let changedTo = -1;
  for (const placement of sorted) {
    const at = placement.oldCount > 0 ? placement.oldStart - start : placement.oldStart - start + 1;
    if (at < cursor) throw new PatchError('overlap');
    while (cursor < at) result.push(source[cursor++]);
    if (changedFrom < 0) changedFrom = result.length;
    for (const line of placement.hunk.lines) {
      if (line.kind === 'context') result.push(source[cursor++]);
      else if (line.kind === 'del') cursor++;
      else result.push(line.text);
    }
    changedTo = result.length - 1;
  }
  while (cursor < source.length) result.push(source[cursor++]);
  const newStart = start + deltaBefore(all, inside, start);
  let from = 0;
  let to = result.length - 1;
  let trimEnd = true;
  while (length(result, from, to) > MAX_WINDOW) {
    const canEnd = to > Math.max(changedTo, from);
    const canStart = from < Math.min(changedFrom, to);
    if (!canEnd && !canStart) throw new PatchError('window-too-large');
    if ((trimEnd && canEnd) || !canStart) to--;
    else from++;
    trimEnd = !trimEnd;
  }
  const content = result.slice(from, to + 1).join('\n');
  const first = newStart + from;
  return { path: window.path, startLine: first, endLine: first + (to - from), content };
}

/** Ventanas «después» de aplicar `files` sobre `code`. Lanza `PatchError` si no encaja. */
export function afterWindows(code: CodeWindow[] | null | undefined, files: ChangeFile[]): CodeWindow[] {
  const byPath = new Map<string, ChangeFile>();
  for (const file of files) {
    if (byPath.has(file.path)) throw new PatchError('duplicate-path');
    byPath.set(file.path, file);
  }
  const windows = code ?? [];
  const byWindow = new Map<number, Placement[]>();
  const byFile = new Map<string, Placement[]>();
  for (const file of byPath.values()) {
    if (file.status !== 'modified') continue;
    const all: Placement[] = [];
    for (const hunk of file.hunks) {
      let oldCount = 0;
      let adds = 0;
      let dels = 0;
      for (const line of hunk.lines) {
        if (line.kind === 'add') adds++;
        else oldCount++;
        if (line.kind === 'del') dels++;
      }
      const placement: Placement = { hunk, oldStart: hunk.oldStart, oldCount, delta: adds - dels };
      const index = windowOf(windows, file.path, placement);
      if (index < 0) throw new PatchError('hunk-outside-window');
      checkContext(windows[index], placement);
      const list = byWindow.get(index) ?? [];
      list.push(placement);
      byWindow.set(index, list);
      all.push(placement);
    }
    byFile.set(file.path, all);
  }

  const out: CodeWindow[] = [];
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    const file = byPath.get(window.path);
    if (!file) {
      out.push(window);
      continue;
    }
    if (file.status === 'deleted') continue;
    const inside = byWindow.get(i);
    if (!inside || !inside.length) {
      const start = startLine(window) + deltaBefore(byFile.get(window.path), [], startLine(window));
      const lines = window.content.split('\n');
      out.push({ path: window.path, startLine: start, endLine: start + lines.length - 1, content: window.content });
      continue;
    }
    out.push(patchWindow(window, inside, byFile.get(window.path)));
  }

  for (const file of byPath.values()) {
    if (file.status !== 'added') continue;
    const lines: string[] = [];
    for (const hunk of file.hunks) for (const line of hunk.lines) lines.push(line.text);
    let start = 1;
    let chunk = '';
    let count = 0;
    for (const line of lines) {
      const extra = (count > 0 ? 1 : 0) + line.length;
      if (count > 0 && chunk.length + extra > MAX_WINDOW) {
        out.push({ path: file.path, startLine: start, endLine: start + count - 1, content: chunk });
        start += count;
        chunk = '';
        count = 0;
      }
      if (count > 0) chunk += '\n';
      chunk += line;
      count++;
    }
    if (count > 0) out.push({ path: file.path, startLine: start, endLine: start + count - 1, content: chunk });
  }
  if (out.length > MAX_WINDOWS) throw new PatchError('too-many-windows');
  return out;
}
