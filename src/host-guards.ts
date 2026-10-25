/**
 * Validación de los mensajes de la webview (no confiables) y utilidades de rutas compartidas con chatFront
 * (`normalizeCodePath`, `isSensitiveCodeFile`, `codeExtension`, `BINARY_EXTENSIONS`: copias literales).
 */
import type { ApplyFileWrite, BridgeRequest, FlowKind, NexoLanguage, NotifyLevel, SampleDocument } from '../webview/src/app/bridge/protocol';

export const CODE_MAX_NAME_LENGTH = 100;
export const CODE_MAX_PATH_LENGTH = 260;
export const MAX_CONTEXT_BASE64 = 400_000;
export const MAX_COPY_CHARS = 10_000;
export const MAX_ASK_CHARS = 4_000;
export const MAX_NOTIFY_CHARS = 500;
export const MAX_SAMPLE_CHARS = 2 * 1024 * 1024;
export const MAX_APPLY_FILES = 12;
export const MAX_APPLY_FILE_CHARS = 3 * 1024 * 1024;
export const MAX_APPLY_TOTAL_CHARS = 8 * 1024 * 1024;
export const MAX_APPLY_PATH = 520;
export const MAX_DB_EXPLAIN_BASE64 = 80_000;
export const DB_KEY_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
/** Hosts locales (http:// y conexiones sin TLS solo se permiten aquí). */
export const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/** Normaliza una ruta relativa; devuelve `null` si intenta salir de la raíz o es inválida. */
export function normalizeCodePath(raw: string): string | null {
  const parts = String(raw ?? '').replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    const segment = part.trim();
    if (!segment || segment === '.') continue;
    if (segment === '..' || INVALID_NAME_CHARS.test(segment) || segment.length > CODE_MAX_NAME_LENGTH) return null;
    out.push(segment);
  }
  const path = out.join('/');
  return path.length > CODE_MAX_PATH_LENGTH ? null : path;
}

export function codeExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'zip',
  'jar', 'war', 'class', 'exe', 'dll', 'so', 'dylib', 'bin', 'gz', 'tar', '7z', 'rar', 'glb', 'psd', 'docx', 'xlsx', 'pptx',
]);

export function isBinaryCodeExtension(extension: string): boolean {
  return BINARY_EXTENSIONS.has(extension.toLowerCase());
}

/** Claves y secretos: nunca se leen ni se listan. */
export function isSensitiveCodeFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (/^\.env\.(example|sample|template|dist)$/.test(lower)) return false;
  return lower === '.env' || lower.startsWith('.env.')
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(lower)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower);
}

/* ---------------------------- type guards ---------------------------- */

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function str(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

const OPS = new Set([
  'listFiles', 'readFile', 'readMountFile', 'flow', 'copy',
  'compareChange', 'dbExplain', 'applyFiles', 'confirm', 'dbConnections', 'dbMetadata',
]);
const KINDS = new Set<FlowKind>(['simulate', 'logs', 'ui-plan', 'db-map']);
const PROPOSAL_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const BASE64 = /^[A-Za-z0-9+/=]*$/;
const LANGUAGES = new Set<NexoLanguage>(['es', 'en']);
const LEVELS = new Set<NotifyLevel>(['info', 'success', 'warning', 'danger']);
const READ_AS = new Set(['text', 'base64']);
const MAX_ID = 128;

export type GuardedMessage =
  | { type: 'ready' }
  | { type: 'request'; id: string; req: BridgeRequest }
  | { type: 'cancel'; id: string }
  | { type: 'openRef'; fileId: string; line: number; sample?: SampleDocument }
  | { type: 'notify'; level: NotifyLevel; text: string }
  | { type: 'ask'; text: string };

function languageOf(value: unknown): NexoLanguage | null {
  return typeof value === 'string' && LANGUAGES.has(value as NexoLanguage) ? (value as NexoLanguage) : null;
}

function base64Of(value: unknown, max: number): string | null {
  return str(value, max) && BASE64.test(value) ? value : null;
}

/** Escrituras de `applyFiles`: 1–12, ruta ≤ 520, contenido ≤ 3 MiB (o `null`), línea ≥ 1 opcional, total ≤ 8 MiB. */
function writesOf(value: unknown): ApplyFileWrite[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_APPLY_FILES) return null;
  const out: ApplyFileWrite[] = [];
  let total = 0;
  for (const item of value) {
    const w = obj(item);
    if (!w || !str(w['path'], MAX_APPLY_PATH) || !w['path']) return null;
    const content = w['content'];
    if (content !== null && !str(content, MAX_APPLY_FILE_CHARS)) return null;
    total += typeof content === 'string' ? content.length : 0;
    if (total > MAX_APPLY_TOTAL_CHARS) return null;
    const line = w['line'];
    if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) return null;
    out.push({ path: w['path'] as string, content: content as string | null, ...(typeof line === 'number' ? { line } : {}) });
  }
  return out;
}

function maxBytesOf(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Petición del puente con todos sus campos validados; `null` si algo no cumple la lista blanca. */
export function guardRequest(o: Obj): BridgeRequest | null {
  const op = o['op'];
  if (typeof op !== 'string' || !OPS.has(op)) return null;
  switch (op) {
    case 'listFiles':
      return { op };
    case 'readFile': {
      const maxBytes = maxBytesOf(o['maxBytes']);
      if (!str(o['fileId'], 4096) || !READ_AS.has(String(o['as'])) || maxBytes === null) return null;
      return { op, fileId: o['fileId'] as string, as: o['as'] as 'text' | 'base64', ...(maxBytes !== undefined ? { maxBytes } : {}) };
    }
    case 'readMountFile': {
      const maxBytes = maxBytesOf(o['maxBytes']);
      if (!str(o['mountId'], 200) || !str(o['path'], CODE_MAX_PATH_LENGTH * 2) || !READ_AS.has(String(o['as'])) || typeof maxBytes !== 'number') return null;
      return { op, mountId: o['mountId'] as string, path: o['path'] as string, as: o['as'] as 'text' | 'base64', maxBytes };
    }
    case 'flow': {
      const kind = o['kind'];
      const body = obj(o['body']);
      if (typeof kind !== 'string' || !KINDS.has(kind as FlowKind) || !body) return null;
      const language = body['language'];
      const contextBase64 = body['contextBase64'];
      if (typeof language !== 'string' || !LANGUAGES.has(language as NexoLanguage)) return null;
      if (!str(contextBase64, MAX_CONTEXT_BASE64) || !BASE64.test(contextBase64)) return null;
      return { op, kind: kind as FlowKind, body: { language: language as NexoLanguage, contextBase64 } };
    }
    case 'copy':
      return str(o['text'], MAX_COPY_CHARS) ? { op, text: o['text'] as string } : null;
    case 'compareChange': {
      const body = obj(o['body']);
      const proposalId = o['proposalId'];
      if (typeof proposalId !== 'string' || !PROPOSAL_ID.test(proposalId) || !body) return null;
      const flowId = body['flowId'];
      const language = languageOf(body['language']);
      const contextBase64 = base64Of(body['contextBase64'], MAX_CONTEXT_BASE64);
      if (!str(flowId, 200) || !flowId || !language || contextBase64 === null) return null;
      return { op, proposalId, body: { flowId, language, contextBase64 } };
    }
    case 'dbExplain': {
      const body = obj(o['body']);
      if (!body) return null;
      const language = languageOf(body['language']);
      const contextBase64 = base64Of(body['contextBase64'], MAX_DB_EXPLAIN_BASE64);
      if (!language || contextBase64 === null) return null;
      return { op, body: { language, contextBase64 } };
    }
    case 'applyFiles': {
      const writes = writesOf(o['writes']);
      return writes ? { op, writes } : null;
    }
    case 'confirm': {
      if (!str(o['title'], 200) || !str(o['message'], 1000) || !str(o['confirm'], 60) || !(o['confirm'] as string).trim()) return null;
      return { op, title: o['title'] as string, message: o['message'] as string, confirm: o['confirm'] as string };
    }
    case 'dbConnections':
      return { op };
    case 'dbMetadata': {
      const key = o['key'];
      return typeof key === 'string' && DB_KEY_PATTERN.test(key) ? { op, key } : null;
    }
    default:
      return null;
  }
}

/** Valida un mensaje de la webview. Tipos desconocidos o campos inválidos → `null` (se ignora). */
export function guardMessage(raw: unknown): GuardedMessage | null {
  const o = obj(raw);
  if (!o) return null;
  switch (o['type']) {
    case 'ready':
      return { type: 'ready' };
    case 'request': {
      if (!str(o['id'], MAX_ID) || !o['id']) return null;
      const req = guardRequest(o);
      return req ? { type: 'request', id: o['id'] as string, req } : null;
    }
    case 'cancel':
      return str(o['id'], MAX_ID) && o['id'] ? { type: 'cancel', id: o['id'] as string } : null;
    case 'openRef': {
      const line = o['line'];
      if (!str(o['fileId'], 4096) || typeof line !== 'number' || !Number.isFinite(line)) return null;
      const msg: GuardedMessage = { type: 'openRef', fileId: o['fileId'] as string, line: Math.max(1, Math.floor(line)) };
      if (o['sample'] !== undefined) {
        const s = obj(o['sample']);
        if (!s || !str(s['path'], CODE_MAX_PATH_LENGTH * 2) || !str(s['content'], MAX_SAMPLE_CHARS) || !str(s['language'], 40)) return null;
        msg.sample = { path: s['path'] as string, content: s['content'] as string, language: s['language'] as string };
      }
      return msg;
    }
    case 'notify': {
      const level = o['level'];
      if (typeof level !== 'string' || !LEVELS.has(level as NotifyLevel) || typeof o['text'] !== 'string') return null;
      return { type: 'notify', level: level as NotifyLevel, text: (o['text'] as string).slice(0, MAX_NOTIFY_CHARS) };
    }
    case 'ask':
      return str(o['text'], MAX_ASK_CHARS) && (o['text'] as string).trim() ? { type: 'ask', text: o['text'] as string } : null;
    default:
      return null;
  }
}
