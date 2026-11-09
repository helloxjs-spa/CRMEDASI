/**
 * Comprovante de pagamento da venda (opcional; migration 012). Valores usados
 * pelo formulário (conveniência) e pelo serviço (validação real). O banco
 * repete o tamanho e os tipos (CHECKs de sale_receipts).
 */

/** 5 MB: limite do comprovante (o banco confere o mesmo valor). */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export const RECEIPT_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type ReceiptContentType = (typeof RECEIPT_CONTENT_TYPES)[number];

/** `accept` do campo de arquivo (só filtra a janela de seleção; o servidor confere o conteúdo). */
export const RECEIPT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

export const RECEIPT_TOO_LARGE = "O comprovante pode ter no máximo 5 MB.";
export const RECEIPT_INVALID_TYPE = "O comprovante precisa ser um arquivo PDF, JPG ou PNG.";
export const RECEIPT_EMPTY = "O arquivo do comprovante está vazio.";
export const RECEIPT_CHANGED_CONCURRENTLY =
  "O comprovante desta venda mudou desde que você abriu esta tela e nada foi gravado agora. Atualize a página para ver o comprovante atual.";
export const RECEIPT_CHANGE_UNCERTAIN =
  "Não foi possível confirmar se o comprovante foi alterado: a resposta do servidor não chegou. Atualize a página e confira o comprovante antes de tentar de novo.";

/**
 * Tipo real do arquivo pela assinatura (primeiros bytes), não pela extensão
 * nem pelo tipo informado pelo navegador. null = não é PDF, JPG nem PNG.
 */
export function detectReceiptType(bytes: Uint8Array): ReceiptContentType | null {
  const starts = (signature: number[]) => bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

/** Conferência rápida no navegador (tamanho e extensão/tipo); o servidor valida o conteúdo de novo. */
export function receiptFileError(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return RECEIPT_EMPTY;
  if (file.size > MAX_RECEIPT_BYTES) return RECEIPT_TOO_LARGE;
  const byType = (RECEIPT_CONTENT_TYPES as readonly string[]).includes(file.type);
  const byName = /\.(pdf|jpe?g|png)$/i.test(file.name);
  return byType || byName ? null : RECEIPT_INVALID_TYPE;
}

/**
 * Nome exibido/baixado: sem caminho, sem caracteres de controle, espaços
 * normalizados e no máximo 255 caracteres (preservando a extensão quando dá).
 */
export function cleanReceiptFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "comprovante";
  if (clean.length <= 255) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : "";
  return clean.slice(0, 255 - ext.length) + ext;
}

/** Tamanho legível: "830 KB", "1,2 MB". */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}
