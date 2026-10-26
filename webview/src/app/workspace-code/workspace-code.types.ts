/** Subconjunto de chatFront workspace-code.types.ts (copia; mantener sincronizado). */

export const CODE_MAX_NAME_LENGTH = 100;
export const CODE_MAX_PATH_LENGTH = 260;

export type WorkspaceCodeLanguage =
  | 'html' | 'css' | 'javascript' | 'typescript' | 'json' | 'markdown' | 'xml' | 'plaintext'
  | 'java' | 'kotlin' | 'python' | 'yaml' | 'ini' | 'shell' | 'bat' | 'sql' | 'scss' | 'less'
  | 'php' | 'go' | 'rust' | 'cpp' | 'csharp' | 'ruby' | 'dockerfile';

export interface WorkspaceCodeFile {
  id: string;
  /** Ruta relativa POSIX sin barra inicial, p. ej. `assets/logo.svg`. */
  path: string;
  name: string;
  /** Extensión en minúsculas y sin punto. */
  extension: string;
  language: WorkspaceCodeLanguage;
  /** Texto del archivo; en binarios, su contenido en base64. */
  content: string;
  binary: boolean;
  lastModified: number;
  /** Solo está en la carpeta local vinculada: Traza guarda su ruta, no su contenido. */
  local?: boolean;
  /** Archivo local cuyo contenido ya se ha leído del disco. */
  loaded?: boolean;
  /** Tamaño en disco de un archivo local, en bytes. */
  size?: number;
  /** Ruta con la que se leyó del disco (no cambia al renombrarlo en el proyecto). */
  diskPath?: string;
}


/** Metadata portable; los handles permanecen en IndexedDB del usuario. */
export interface WorkspaceCodeMount {
  id: string;
  name: string;
  alias: string;
  /** Prefijo virtual; vacío en documentos antiguos de una sola carpeta. */
  path: string;
}

export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeUtf8Base64(text: string): string {
  return encodeBytesBase64(new TextEncoder().encode(text));
}

export function decodeUtf8Base64(base64: string): string {
  return new TextDecoder('utf-8').decode(decodeBase64Bytes(base64));
}

/* ====================================================================
 * Rutas
 * ==================================================================== */

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


export function codeBaseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function codeDirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function codeExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

/** Resuelve `ref` (href/src) respecto al archivo `fromPath`. `null` si es externa o sale de la raíz. */
export function resolveCodeReference(fromPath: string, ref: string): string | null {
  const clean = String(ref ?? '').trim().split('#')[0].split('?')[0];
  if (!clean || isExternalReference(clean)) return null;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* se usa tal cual */ }
  const base = decoded.startsWith('/') ? [] : codeDirName(fromPath).split('/').filter(Boolean);
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!base.length) return null;
      base.pop();
    } else base.push(segment);
  }
  return base.join('/');
}

export function isExternalReference(ref: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(String(ref ?? '').trim());
}

/* ====================================================================
 * Lenguajes y tipos de archivo
 * ==================================================================== */

const LANGUAGE_BY_EXTENSION: Record<string, WorkspaceCodeLanguage> = {
  html: 'html', htm: 'html',
  css: 'css',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript',
  json: 'json', map: 'json', webmanifest: 'json',
  md: 'markdown', markdown: 'markdown',
  svg: 'xml', xml: 'xml', iml: 'xml', xsd: 'xml',
  txt: 'plaintext',
  java: 'java', kt: 'kotlin', kts: 'kotlin', py: 'python',
  yml: 'yaml', yaml: 'yaml', properties: 'ini', ini: 'ini', toml: 'ini', conf: 'ini',
  sh: 'shell', bash: 'shell', cmd: 'bat', bat: 'bat', sql: 'sql',
  scss: 'scss', less: 'less', tsx: 'typescript', jsx: 'javascript',
  php: 'php', go: 'go', rs: 'rust', c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby',
};

const LANGUAGE_BY_NAME: Record<string, WorkspaceCodeLanguage> = {
  dockerfile: 'dockerfile', mvnw: 'shell', gradlew: 'shell',
  '.gitignore': 'ini', '.gitattributes': 'ini', '.gitconfig': 'ini', '.dockerignore': 'ini', '.editorconfig': 'ini',
  '.env': 'ini', '.env.example': 'ini',
};

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'pdf', 'zip',
  'jar', 'war', 'class', 'exe', 'dll', 'so', 'dylib', 'bin', 'gz', 'tar', '7z', 'rar', 'glb', 'psd', 'docx', 'xlsx', 'pptx',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', svg: 'image/svg+xml', xml: 'application/xml', txt: 'text/plain', md: 'text/markdown',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};

export function codeLanguageFor(name: string): WorkspaceCodeLanguage {
  return LANGUAGE_BY_NAME[name.toLowerCase()] ?? LANGUAGE_BY_EXTENSION[codeExtension(name)] ?? 'plaintext';
}

/** Claves y secretos: nunca se copian a Traza al abrir una carpeta, se quedan en el disco. */
export function isSensitiveCodeFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (/^\.env\.(example|sample|template|dist)$/.test(lower)) return false;
  return lower === '.env' || lower.startsWith('.env.')
    || /\.(pem|key|p12|pfx|jks|keystore)$/.test(lower)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower);
}

/** El archivo tiene su contenido disponible en memoria. */
export function isCodeFileReady(file: Pick<WorkspaceCodeFile, 'local' | 'loaded'>): boolean {
  return !file.local || file.loaded === true;
}

export function isBinaryCodeExtension(extension: string): boolean {
  return BINARY_EXTENSIONS.has(extension.toLowerCase());
}

export function codeMimeFor(name: string): string {
  return MIME_BY_EXTENSION[codeExtension(name)] ?? 'application/octet-stream';
}

