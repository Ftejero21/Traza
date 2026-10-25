/**
 * Vista de pantalla (Nexo IA, fase 2.2): compilación SCSS/Sass en el navegador con el paquete `sass` (carga perezosa
 * y memoizada). Los `@use`/`@import` se resuelven SOLO con los archivos del workspace (`ScssImportLoader`); lo que no
 * se puede resolver (`~`, paquetes, `node_modules`) se sustituye por una hoja vacía y marca la vista aproximada. Ante
 * cualquier fallo (también si el bundler no admite `sass` en el navegador) se cae al transpilador ligero
 * `scssFallback`.
 */
import { sha256Hex } from './workspace-code-ai-change-patch';
import { ScssImportLoader, scssFallback } from './workspace-code-ui-preview-render';

type SassModule = typeof import('sass');

let sassModule: Promise<SassModule | null> | null = null;

function loadSass(): Promise<SassModule | null> {
  if (!sassModule) {
    sassModule = import('sass')
      .then((m) => {
        const mod = ((m as unknown as { default?: SassModule }).default ?? m) as SassModule;
        return typeof mod.compileStringAsync === 'function' ? mod : null;
      })
      .catch((error: unknown) => {
        console.warn('[Nexo IA] Compilador SCSS no disponible; se usa el transpilador ligero.', error instanceof Error ? error.name : '');
        return null;
      });
  }
  return sassModule;
}

const MAX_CACHE = 60;
const cache = new Map<string, { css: string; approximate: boolean }>();

function remember(key: string, value: { css: string; approximate: boolean }): void {
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function toFileUrl(path: string): URL {
  return new URL(`file:///${String(path).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`);
}

function fromFileUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/+/, '');
}

/** Compila `text` (SCSS o Sass indentado según `path`) a CSS. */
export async function compileScss(text: string, path: string, loader: ScssImportLoader): Promise<{ css: string; approximate: boolean }> {
  const source = String(text ?? '');
  let key = '';
  try {
    key = await sha256Hex(`${path}\u0000${source}`);
    const hit = cache.get(key);
    if (hit) return hit;
  } catch (error: unknown) {
    console.warn('[Nexo IA] Hash SCSS no disponible.', error instanceof Error ? error.name : '');
  }
  const fallback = async (): Promise<{ css: string; approximate: boolean }> => {
    const r = await scssFallback(source, path, loader);
    return { css: r.css, approximate: true };
  };
  const sass = await loadSass();
  if (!sass) {
    const r = await fallback();
    if (key) remember(key, r);
    return r;
  }
  let approximate = false;
  const loaded = new Map<string, { text: string; indented: boolean }>();
  let empty = 0;
  try {
    const result = await sass.compileStringAsync(source, {
      syntax: /\.sass$/i.test(path) ? 'indented' : 'scss',
      style: 'expanded',
      url: toFileUrl(path),
      logger: { warn: () => undefined, debug: () => undefined },
      importer: {
        canonicalize: async (url: string): Promise<URL | null> => {
          if (/^nx-empty:/.test(url)) return new URL(url);
          let spec: string;
          if (url.startsWith('file:///')) spec = `/${fromFileUrl(new URL(url))}`;
          else spec = url;
          const found = spec.includes('/node_modules/') || spec.startsWith('~') || spec.includes('/~')
            ? null
            : await loader(spec, path);
          if (!found) {
            approximate = true;
            return new URL(`nx-empty:${++empty}`);
          }
          const canonical = toFileUrl(found.path);
          loaded.set(canonical.href, { text: found.text, indented: /\.sass$/i.test(found.path) });
          return canonical;
        },
        load: (canonicalUrl: URL) => {
          if (canonicalUrl.protocol === 'nx-empty:') return { contents: '', syntax: 'scss' as const };
          const hit = loaded.get(canonicalUrl.href);
          if (!hit) {
            approximate = true;
            return { contents: '', syntax: 'scss' as const };
          }
          const isCss = /\.css$/i.test(canonicalUrl.pathname);
          return { contents: hit.text, syntax: hit.indented ? ('indented' as const) : isCss ? ('css' as const) : ('scss' as const) };
        },
      },
    });
    const r = { css: result.css, approximate };
    if (key) remember(key, r);
    return r;
  } catch (error: unknown) {
    console.warn('[Nexo IA] SCSS no compilado; se usa el transpilador ligero.', error instanceof Error ? error.name : '');
    const r = await fallback();
    if (key) remember(key, r);
    return r;
  }
}
