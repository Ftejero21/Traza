/** Copia de las exclusiones de chatFront services/workspace-code-ai-context.ts. */


const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'out', '.git', '.angular', '.next', 'coverage', 'vendor', '__pycache__', '.idea', '.vscode']);
const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock', 'poetry.lock', 'cargo.lock', 'gemfile.lock']);
const EXCLUDED_EXTENSIONS = new Set([
  // imágenes
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tif', 'tiff', 'avif', 'heic', 'psd',
  // fuentes
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // audio y vídeo
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'mp4', 'webm', 'mov', 'avi', 'mkv',
  // comprimidos y documentos
  'zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'bz2', 'xz', 'jar', 'war', 'ear', 'pdf',
  // binarios
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'o', 'obj', 'a', 'lib', 'pyc', 'pyo', 'wasm', 'db', 'sqlite', 'sqlite3', 'dat',
]);

/** Ruta con algún segmento de directorio excluido (dependencias, salidas de build…); no mira extensión ni lockfiles. */
export function isContextExcludedDir(path: string): boolean {
  const segments = String(path ?? '').split('/');
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i].toLowerCase())) return true;
  }
  return false;
}

/** Rutas que nunca forman parte del contexto de la IA (dependencias, salidas de build, lockfiles, binarios…). */
export function isContextExcludedPath(path: string): boolean {
  const segments = String(path ?? '').split('/');
  const name = (segments[segments.length - 1] || '').toLowerCase();
  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRS.has(segments[i].toLowerCase())) return true;
  }
  if (LOCKFILES.has(name) || name.endsWith('.lock') || name.endsWith('.min.js') || name.endsWith('.map')) return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && EXCLUDED_EXTENSIONS.has(name.slice(dot + 1));
}
