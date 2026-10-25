/**
 * Enmascarado de secretos antes de enviar logs o datos de entrada a Nexo IA (chatBack repite lo mismo como defensa
 * en profundidad con `WorkspaceCodeSecretMasker`). Todo lo que coincide se sustituye por `«oculto»`.
 */
export const MASK = '«oculto»';

const SENSITIVE_KEY = /^(?:.*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie).*)$/i;

const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const HEADER = /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)(\s*:\s*)([^\r\n]+)/gi;
const KEY_VALUE = /\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key)[\w.-]*)(["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\])]+)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function maskSensitiveText(text: string): string {
  if (!text) return text;
  return String(text)
    // Se conserva el esquema (`Bearer`, `Basic`…): saber que había credencial y de qué tipo importa para el diagnóstico.
    .replace(HEADER, (_m, name: string, sep: string, value: string) => `${name}${sep}${/^(Bearer|Basic|Digest|Token)\b/i.exec(value.trim())?.[1].concat(' ') ?? ''}${MASK}`)
    .replace(BEARER, `Bearer ${MASK}`)
    .replace(JWT, MASK)
    .replace(KEY_VALUE, (match: string, key: string, sep: string, value: string) => (value === MASK || value.startsWith('Bearer') ? match : `${key}${sep}${MASK}`))
    .replace(EMAIL, MASK)
    .replace(CARD, (match: string) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? MASK : match;
    });
}

const CONFIG_FILE = /(?:\.(?:properties|ya?ml|conf|cfg|ini|toml|env|npmrc)|(?:^|\/)(?:appsettings[\w.-]*|secrets?[\w.-]*|credentials[\w.-]*)\.json)$/i;
const URL_CREDENTIALS = /(\b[a-z][\w+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi;

/**
 * Archivos de configuración (application.properties, *.yml…) que se envían como contexto de código: se ocultan los
 * valores de claves sensibles, credenciales en URLs, tokens y emails. Línea a línea, así no cambia la numeración que
 * usan las referencias del flujo. El código fuente no se toca: el enmascarado rompería anclas y búsquedas de Editar.
 */
export function maskConfigSecrets(path: string, text: string): string {
  if (!text || !CONFIG_FILE.test(String(path ?? ''))) return text;
  return maskSensitiveText(String(text).replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`));
}

/** Enmascara recursivamente cada string del JSON ya parseado y los valores de claves con nombre sensible. */
export function maskSensitiveJson(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (typeof value === 'string') return maskSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => maskSensitiveJson(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = maskSensitiveText(key);
      out[safeKey] = SENSITIVE_KEY.test(key) && item !== null && item !== undefined ? MASK : maskSensitiveJson(item, depth + 1);
    }
    return out;
  }
  return value;
}
