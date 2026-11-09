import { sql } from "drizzle-orm";
import { check, customType, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";
import { sales } from "./sales";

/** bytea ↔ Uint8Array (o `pg` devolve Buffer, que é um Uint8Array; o PGlite devolve Uint8Array). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

/**
 * Comprovante de pagamento da venda (opcional). Espelha database/migrations/
 * 012_sale_receipts.sql, 013 e 014, que são a fonte do schema. Ficam SÓ no SQL
 * os triggers: a única alteração é marcar como removido (uma vez; o banco
 * carimba `removed_at` e APAGA o conteúdo), sem DELETE/TRUNCATE e
 * `created_at` do banco.
 *
 * Comprovante atual = `removedAt` NULL (no máximo um por venda; sempre com
 * conteúdo). Removidos ficam como histórico, sem o arquivo.
 *
 * O conteúdo fica nesta tabela separada para que nenhuma listagem de vendas o
 * leia: só a rota de download seleciona `content`.
 */
export const saleReceipts = pgTable(
  "sale_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "restrict" }),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** NULL só em comprovante removido (o banco apaga o arquivo na remoção, 014). */
    content: bytea("content"),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Do banco. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Do banco (na remoção). */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("sale_receipts_current_unique").on(t.saleId).where(sql`removed_at IS NULL`),
    index("sale_receipts_sale_idx").on(t.saleId),
    check("sale_receipts_file_name_present", sql`btrim(${t.fileName}) <> '' AND char_length(${t.fileName}) <= 255`),
    check("sale_receipts_content_type_allowed", sql`${t.contentType} IN ('application/pdf', 'image/jpeg', 'image/png')`),
    check("sale_receipts_size_limit", sql`${t.sizeBytes} BETWEEN 1 AND 5242880 AND (${t.content} IS NULL OR octet_length(${t.content}) = ${t.sizeBytes})`),
    check("sale_receipts_removed_consistent", sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
    check("sale_receipts_content_only_current", sql`(${t.removedAt} IS NULL) = (${t.content} IS NOT NULL)`),
  ],
);
