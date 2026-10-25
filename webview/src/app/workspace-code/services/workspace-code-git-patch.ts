/** Subconjunto de chatFront services/workspace-code-git-patch.ts (copia). */

export interface GitTextLine {
  body: string;
  /** `\n`, `\r\n` o vacío (última línea sin salto final). */
  eol: string;
}

/** Divide un texto conservando los terminadores de línea. */
export function gitSplitLines(text: string): GitTextLine[] {
  const out: GitTextLine[] = [];
  const source = String(text ?? '');
  let start = 0;
  while (start < source.length) {
    const nl = source.indexOf('\n', start);
    if (nl < 0) {
      out.push({ body: source.slice(start), eol: '' });
      break;
    }
    const crlf = nl > start && source.charAt(nl - 1) === '\r';
    out.push({ body: source.slice(start, crlf ? nl - 1 : nl), eol: crlf ? '\r\n' : '\n' });
    start = nl + 1;
  }
  return out;
}

export function gitJoinLines(lines: GitTextLine[]): string {
  return lines.map((line) => line.body + line.eol).join('');
}

/** Terminador dominante de un texto (`\r\n` si hay más CRLF que LF sueltos). */
export function gitDominantEol(text: string): string {
  const source = String(text ?? '');
  let crlf = 0;
  let lf = 0;
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) {
    if (i > 0 && source.charAt(i - 1) === '\r') crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}
