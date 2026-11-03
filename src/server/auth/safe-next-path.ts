const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const BASE = "http://crm.invalid";

/** Decodifica até estabilizar (ou recusa): `%252F` não pode esconder `/`. `null` = codificação inválida. */
function fullyDecoded(value: string): string | null {
  let current = value;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * Destino depois do login (`?next=`): só caminhos internos. O navegador remove
 * tabulação e quebra de linha de uma URL e trata `\` como `/`, então olhar só o
 * início do texto não basta: `/<TAB>/site.com` vira `//site.com`, que é externo.
 * A decisão é tomada sobre a URL resolvida do mesmo jeito que o navegador faria,
 * e o valor devolvido é o normalizado.
 */
export function safeNextPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (CONTROL_CHARS.test(value)) return "/";

  const decoded = fullyDecoded(value);
  if (decoded === null || CONTROL_CHARS.test(decoded)) return "/";

  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";

  const path = fullyDecoded(url.pathname);
  if (path === null || path.includes("\\") || path.includes("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
