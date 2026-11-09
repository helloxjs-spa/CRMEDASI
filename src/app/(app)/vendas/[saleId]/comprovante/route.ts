import { AppError } from "@/server/errors";
import { getSaleReceiptFile } from "@/server/modules/sales/sale-receipts.service";
import { requireServiceContext } from "@/server/next/session";

/**
 * Comprovante de pagamento da venda (012). A sessão é revalidada no banco e o
 * serviço aplica RBAC (`sales:view`) e o escopo da venda. Sem acesso, venda
 * inexistente ou sem comprovante → 404 (não revela a existência).
 *
 * O tipo enviado é o detectado pela assinatura do arquivo no registro (PDF,
 * JPG ou PNG), com `nosniff` (cabeçalho global): o navegador não o interpreta
 * como página. `?download=1` baixa em vez de abrir.
 */
export async function GET(request: Request, { params }: { params: Promise<{ saleId: string }> }): Promise<Response> {
  const ctx = await requireServiceContext();
  const { saleId } = await params;
  let file;
  try {
    file = await getSaleReceiptFile(ctx, saleId);
  } catch (error) {
    if (error instanceof AppError) return new Response("Comprovante não encontrado.", { status: 404, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = {
    "Content-Type": file.contentType,
    "Content-Length": String(file.sizeBytes),
    "Content-Disposition": `${download ? "attachment" : "inline"}; ${dispositionFileName(file.fileName)}`,
    "Cache-Control": "private, no-store",
  };
  if (file.contentType.startsWith("image/")) headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
  return new Response(new Uint8Array(file.content), { headers });
}

/** filename (ASCII, sem aspas) + filename* (UTF-8, RFC 5987) para nomes com acento. */
function dispositionFileName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_").trim() || "comprovante";
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
