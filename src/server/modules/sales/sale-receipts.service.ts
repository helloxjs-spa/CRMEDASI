import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  cleanReceiptFileName,
  detectReceiptType,
  MAX_RECEIPT_BYTES,
  RECEIPT_CHANGED_CONCURRENTLY,
  RECEIPT_EMPTY,
  RECEIPT_INVALID_TYPE,
  RECEIPT_TOO_LARGE,
  type ReceiptContentType,
} from "@/lib/receipts";
import { SALE_REVERSED_READ_ONLY } from "@/lib/sales";
import type { Actor } from "@/server/authz/actor";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { ownedScope } from "@/server/authz/scope";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { saleReceipts, sales } from "@/server/db/schema";
import { runTransaction } from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Comprovante de pagamento da venda (opcional; migrations 012–014).
 *
 * - No registro da venda: gravado na MESMA transação dela (createSale).
 * - Depois, na edição da venda: anexar, trocar ou remover
 *   (`replaceSaleReceipt` / `removeSaleReceipt`), com as mesmas permissões da
 *   edição (`sales:edit` + escopo; venda estornada só com
 *   `sales:editReversed`). Remover = marcar como removido; o banco APAGA o
 *   arquivo e mantém o registro (nome, tamanho, quem anexou e removeu).
 *   Trocar = remover o atual e incluir o novo, na mesma transação.
 * - Concorrência: a tela envia o id do comprovante que mostrou
 *   (`expectedReceiptId`, vazio = nenhum); se o atual for outro, nada é
 *   gravado (ConflictError) e a tela pede para atualizar.
 * - PDF, JPG ou PNG de até 5 MB. O tipo gravado é o detectado pela assinatura
 *   do arquivo, nunca o informado pelo navegador.
 * - Quem vê a venda vê o comprovante atual (`sales:view` + escopo da venda).
 * - Auditoria `sale.receipt_attached` / `sale.receipt_removed` (sem o conteúdo).
 */

/** Entrada do serviço: o nome original e os bytes do arquivo (a action lê do FormData). */
export const receiptInputSchema = z.strictObject({
  fileName: z.string({ error: "Comprovante inválido." }).max(10_000, "Comprovante inválido."),
  bytes: z.instanceof(Uint8Array, { error: "Comprovante inválido." }),
}, { error: "Escolha o arquivo do comprovante." });
export type ReceiptInput = z.output<typeof receiptInputSchema>;

export type PreparedReceipt = { fileName: string; contentType: ReceiptContentType; sizeBytes: number; content: Uint8Array };

const receiptError = (message: string) => new ValidationError(message, { receipt: [message] });

/** Confere tamanho e tipo real; chamar ANTES de travar ou gravar qualquer coisa. */
export function prepareReceipt(input: ReceiptInput): PreparedReceipt {
  const { bytes } = input;
  if (bytes.byteLength === 0) throw receiptError(RECEIPT_EMPTY);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) throw receiptError(RECEIPT_TOO_LARGE);
  const contentType = detectReceiptType(bytes);
  if (!contentType) throw receiptError(RECEIPT_INVALID_TYPE);
  return { fileName: cleanReceiptFileName(input.fileName), contentType, sizeBytes: bytes.byteLength, content: bytes };
}

/** Grava o comprovante atual da venda e a auditoria (dentro da transação de quem chama). */
export async function insertSaleReceipt(
  tx: Database,
  actor: Actor,
  sale: { id: string; teamId: string },
  receipt: PreparedReceipt,
  replacedReceiptId: string | null = null,
): Promise<string> {
  const [row] = await tx
    .insert(saleReceipts)
    .values({ saleId: sale.id, uploadedBy: actor.userId, ...receipt })
    .returning({ id: saleReceipts.id });
  await recordAudit(tx, {
    actorId: actor.userId,
    action: "sale.receipt_attached",
    entityType: "sale",
    entityId: sale.id,
    teamId: sale.teamId,
    metadata: {
      saleId: sale.id,
      receiptId: row.id,
      fileName: receipt.fileName,
      contentType: receipt.contentType,
      sizeBytes: receipt.sizeBytes,
      ...(replacedReceiptId ? { replacedReceiptId } : {}),
    },
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Edição: anexar, trocar, remover
// ---------------------------------------------------------------------------

const expectedReceiptIdSchema = z.union([idSchema, z.literal("").transform(() => null), z.null()]);

const replaceSchema = z.strictObject({
  saleId: idSchema,
  /** Comprovante que a tela mostrava (vazio/null = nenhum). */
  expectedReceiptId: expectedReceiptIdSchema,
  receipt: receiptInputSchema,
});

const removeSchema = z.strictObject({
  saleId: idSchema,
  expectedReceiptId: idSchema,
});

type CurrentReceipt = { id: string; fileName: string; sizeBytes: number };

/**
 * Venda (no escopo, FOR SHARE — a mesma ordem das demais operações: venda
 * antes do comprovante) e o comprovante atual dela (FOR UPDATE), conferido
 * contra o que a tela mostrava.
 */
async function lockForReceiptChange(
  tx: Database,
  actor: Actor,
  saleId: string,
  expectedReceiptId: string | null,
): Promise<{ sale: { id: string; teamId: string }; current: CurrentReceipt | null }> {
  const [sale] = await tx
    .select({ id: sales.id, teamId: sales.teamId, status: sales.status })
    .from(sales)
    .where(and(eq(sales.id, saleId), ownedScope(actor, { ownerId: sales.sellerId, teamId: sales.teamId })))
    .for("share")
    .limit(1);
  if (!sale) throw new NotFoundError();
  if (sale.status === "REVERSED" && !hasPermission(actor, "sales:editReversed")) throw new ValidationError(SALE_REVERSED_READ_ONLY);

  const [current] = await tx
    .select({ id: saleReceipts.id, fileName: saleReceipts.fileName, sizeBytes: saleReceipts.sizeBytes })
    .from(saleReceipts)
    .where(and(eq(saleReceipts.saleId, saleId), isNull(saleReceipts.removedAt)))
    .for("update")
    .limit(1);
  if ((current?.id ?? null) !== expectedReceiptId) throw new ConflictError(RECEIPT_CHANGED_CONCURRENTLY);
  return { sale: { id: sale.id, teamId: sale.teamId }, current: current ?? null };
}

/** Marca o comprovante como removido (o banco apaga o arquivo) e audita. */
async function markRemoved(tx: Database, actor: Actor, sale: { id: string; teamId: string }, current: CurrentReceipt, replaced: boolean) {
  await tx.update(saleReceipts).set({ removedBy: actor.userId }).where(eq(saleReceipts.id, current.id));
  await recordAudit(tx, {
    actorId: actor.userId,
    action: "sale.receipt_removed",
    entityType: "sale",
    entityId: sale.id,
    teamId: sale.teamId,
    metadata: { saleId: sale.id, receiptId: current.id, fileName: current.fileName, sizeBytes: current.sizeBytes, replaced },
  });
}

/** Anexa (venda sem comprovante) ou troca o comprovante atual. */
export async function replaceSaleReceipt(ctx: ServiceContext, input: unknown): Promise<{ receiptId: string; replaced: boolean }> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:edit");
  const data = parseInput(replaceSchema, input);
  const receipt = prepareReceipt(data.receipt);
  try {
    return await runTransaction(db, async (tx) => {
      const { sale, current } = await lockForReceiptChange(tx, actor, data.saleId, data.expectedReceiptId);
      if (current) await markRemoved(tx, actor, sale, current, true);
      const receiptId = await insertSaleReceipt(tx, actor, sale, receipt, current?.id ?? null);
      return { receiptId, replaced: !!current };
    });
  } catch (error) {
    // Dois "anexar" simultâneos numa venda sem comprovante: um só fica.
    if (isUniqueViolation(error, "sale_receipts_current_unique")) throw new ConflictError(RECEIPT_CHANGED_CONCURRENTLY);
    throw error;
  }
}

/** Remove o comprovante atual (o arquivo é apagado; o registro fica). */
export async function removeSaleReceipt(ctx: ServiceContext, input: unknown): Promise<void> {
  const { db, actor } = ctx;
  assertPermission(actor, "sales:edit");
  const data = parseInput(removeSchema, input);
  await runTransaction(db, async (tx) => {
    const { sale, current } = await lockForReceiptChange(tx, actor, data.saleId, data.expectedReceiptId);
    await markRemoved(tx, actor, sale, current!, false);
  });
}

// ---------------------------------------------------------------------------
// Consultas (só o comprovante ATUAL)
// ---------------------------------------------------------------------------

export type SaleReceiptInfo = { id: string; fileName: string; contentType: string; sizeBytes: number; createdAt: Date };
export type SaleReceiptFile = SaleReceiptInfo & { content: Uint8Array };

const infoColumns = {
  id: saleReceipts.id,
  fileName: saleReceipts.fileName,
  contentType: saleReceipts.contentType,
  sizeBytes: saleReceipts.sizeBytes,
  createdAt: saleReceipts.createdAt,
};

const currentOf = (saleId: string) => and(eq(saleReceipts.saleId, saleId), isNull(saleReceipts.removedAt));

/** Comprovante atual (sem o conteúdo) para o detalhe e a edição da venda. null = sem comprovante. Fora do escopo → NotFound. */
export async function getSaleReceiptInfo({ db, actor }: ServiceContext, rawSaleId: unknown): Promise<SaleReceiptInfo | null> {
  assertPermission(actor, "sales:view");
  const saleId = parseInput(idSchema, rawSaleId);
  const [sale] = await db
    .select({ id: sales.id })
    .from(sales)
    .where(and(eq(sales.id, saleId), ownedScope(actor, { ownerId: sales.sellerId, teamId: sales.teamId })))
    .limit(1);
  if (!sale) throw new NotFoundError();
  const [row] = await db.select(infoColumns).from(saleReceipts).where(currentOf(saleId)).limit(1);
  return row ?? null;
}

/** Arquivo do comprovante atual, para download. Sem comprovante ou fora do escopo → NotFound. */
export async function getSaleReceiptFile({ db, actor }: ServiceContext, rawSaleId: unknown): Promise<SaleReceiptFile> {
  assertPermission(actor, "sales:view");
  const saleId = parseInput(idSchema, rawSaleId);
  const [row] = await db
    .select({ ...infoColumns, content: saleReceipts.content })
    .from(saleReceipts)
    .innerJoin(sales, eq(sales.id, saleReceipts.saleId))
    .where(and(currentOf(saleId), ownedScope(actor, { ownerId: sales.sellerId, teamId: sales.teamId })))
    .limit(1);
  // O atual sempre tem conteúdo (CHECK sale_receipts_content_only_current, 014).
  if (!row?.content) throw new NotFoundError();
  return { ...row, content: row.content };
}
