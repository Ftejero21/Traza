/**
 * Resaltado propio de los fragmentos de Nexo IA (sin Monaco `colorize` ni `innerHTML`): parte cada línea en tokens que
 * se pintan como `<span>` por interpolación con las variables `--wce-syn-*`.
 */
export type CodeTokenKind = 'kw' | 'str' | 'type' | 'fn' | 'num' | 'com' | 'plain';

export interface CodeToken {
  text: string;
  kind: CodeTokenKind;
}

const KEYWORDS = new Set([
  // TS / JS
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'constructor', 'continue',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'keyof', 'let', 'new', 'null', 'number', 'of',
  'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'string', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
  // Java / Kotlin / C#
  'byte', 'char', 'double', 'final', 'float', 'int', 'long', 'native', 'package', 'short', 'synchronized', 'throws',
  'transient', 'volatile', 'fun', 'val', 'when', 'object', 'override', 'open', 'data', 'namespace', 'using', 'bool',
  // Python / Go
  'def', 'elif', 'except', 'lambda', 'None', 'True', 'False', 'pass', 'raise', 'with', 'func', 'go', 'defer', 'chan',
  'map', 'range', 'struct', 'select', 'and', 'or', 'not', 'is',
]);

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'join', 'left', 'right', 'inner', 'outer',
  'on', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'order', 'by', 'group', 'having', 'limit', 'offset', 'returning',
  'create', 'table', 'alter', 'drop', 'index', 'primary', 'key', 'foreign', 'references', 'distinct', 'count', 'exists',
]);

const HASH_COMMENT = new Set(['py', 'python', 'yml', 'yaml', 'properties', 'sh', 'bash', 'shell', 'rb', 'ruby', 'dockerfile', 'toml']);

const TOKEN = /(\/\/.*$|\/\*.*?(?:\*\/|$)|<!--.*?(?:-->|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d+(?:\.\d+)?[a-zA-Z]*\b)|(@?[A-Za-z_$][\w$]*)|(\s+)|([^\sA-Za-z_$\d"'`/<]+|\/|<)/g;

export function tokenizeCodeLine(line: string, language: string): CodeToken[] {
  const lang = String(language || '').toLowerCase();
  const sql = lang === 'sql';
  const hash = HASH_COMMENT.has(lang);
  let text = String(line ?? '');
  const out: CodeToken[] = [];
  const push = (value: string, kind: CodeTokenKind) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += value;
    else out.push({ text: value, kind });
  };
  // Comentarios de línea propios del lenguaje (`#`, `--`).
  let tail = '';
  const commentAt = hash ? text.search(/(^|\s)#/) : sql ? text.indexOf('--') : -1;
  if (commentAt >= 0) {
    const start = hash && text[commentAt] !== '#' ? commentAt + 1 : commentAt;
    tail = text.slice(start);
    text = text.slice(0, start);
  }
  const words = text.split(TOKEN);
  // `split` con grupos: [antes, g1..g6, entre, g1..g6, …]
  for (let i = 0; i < words.length; i += 7) {
    push(words[i] ?? '', 'plain');
    if (i + 6 >= words.length) break;
    const [comment, string, number, ident, space, other] = words.slice(i + 1, i + 7);
    if (comment) push(comment, sql || hash ? 'plain' : 'com');
    else if (string) push(string, 'str');
    else if (number) push(number, 'num');
    else if (ident) {
      const rest = words.slice(i + 7).join('');
      if (ident.startsWith('@')) push(ident, 'type');
      else if (sql ? SQL_KEYWORDS.has(ident.toLowerCase()) : KEYWORDS.has(ident)) push(ident, 'kw');
      else if (/^\s*\(/.test(rest)) push(ident, 'fn');
      else if (/^[A-Z][\w$]*$/.test(ident) && /[a-z]/.test(ident)) push(ident, 'type');
      else push(ident, 'plain');
    } else if (space) push(space, 'plain');
    else if (other) push(other, 'plain');
  }
  if (tail) push(tail, 'com');
  return out;
}
