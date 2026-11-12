import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RECEIPT_BYTES, RECEIPT_CHANGED_CONCURRENTLY, RECEIPT_EMPTY, RECEIPT_INVALID_TYPE, RECEIPT_TOO_LARGE } from "@/lib/receipts";
import { SALE_REVERSED_READ_ONLY } from "@/lib/sales";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, saleReceipts, sales } from "@/server/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { createLead } from "@/server/modules/leads/leads.service";
import { getSaleReceiptFile, getSaleReceiptInfo, removeSaleReceipt, replaceSaleReceipt } from "@/server/modules/sales/sale-receipts.service";
import { createSale, getSale, reverseSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;

const ctx = (userId: string) => org.ctx(userId);
const nextPhone = () => `(79) 95${String(++seq).padStart(7, "0")}`;
const newLead = async (sellerId: string) =>
  (await createLead(await ctx(sellerId), { name: `Cliente Comprovante ${++seq}`, phone: nextPhone(), source: "GOOGLE", interestCourseId: course })).id;

const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const receiptsOf = async (saleId: string) =>
  (await handle.db.select({ n: count() }).from(saleReceipts).where(eq(saleReceipts.saleId, saleId)))[0].n;

async function expectReceiptError(promise: Promise<unknown>, message: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).fieldErrors).toEqual({ receipt: [message] });
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
});
afterAll(() => handle.close());

describe("comprovante no registro da venda (012)", () => {
  it("é gravado com a venda: tipo detectado pelo conteúdo, nome limpo, auditoria sem o conteúdo", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(leadId, course, { receipt: { fileName: "C:\\fakepath\\pix maria.pdf", bytes: PDF } }));

    const file = await getSaleReceiptFile(seller, saleId);
    expect(file).toMatchObject({ fileName: "pix maria.pdf", contentType: "application/pdf", sizeBytes: PDF.byteLength });
    expect([...file.content]).toEqual([...PDF]);
    expect(await getSaleReceiptInfo(seller, saleId)).toMatchObject({ fileName: "pix maria.pdf", sizeBytes: PDF.byteLength });

    const [audit] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "sale.receipt_attached"), eq(auditEvents.entityId, saleId)));
    expect(audit).toMatchObject({ actorId: org.ids.sellerA1, entityType: "sale", teamId: org.ids.teamA });
    expect(audit.metadata).toEqual({ saleId, receiptId: expect.any(String), fileName: "pix maria.pdf", contentType: "application/pdf", sizeBytes: PDF.byteLength });
  });

  it("é opcional: venda sem comprovante não tem registro", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course));
    expect(await getSaleReceiptInfo(seller, saleId)).toBeNull();
    await expect(getSaleReceiptFile(seller, saleId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("arquivo vazio, acima de 5 MB ou que não é PDF/JPG/PNG (mesmo com extensão .pdf): recusado e nada é gravado", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    const attempt = (fileName: string, bytes: Uint8Array) => createSale(seller, saleInput(leadId, course, { receipt: { fileName, bytes } }));

    await expectReceiptError(attempt("vazio.pdf", new Uint8Array()), RECEIPT_EMPTY);
    const big = new Uint8Array(MAX_RECEIPT_BYTES + 1);
    big.set(PDF);
    await expectReceiptError(attempt("grande.pdf", big), RECEIPT_TOO_LARGE);
    await expectReceiptError(attempt("pagina.pdf", new TextEncoder().encode("<html><script>alert(1)</script>")), RECEIPT_INVALID_TYPE);
    expect((await handle.db.select({ n: count() }).from(sales).where(eq(sales.leadId, leadId)))[0].n).toBe(0);

    // Exatamente 5 MB é aceito.
    const limit = new Uint8Array(MAX_RECEIPT_BYTES);
    limit.set(PNG);
    const { saleId } = await attempt("foto.png", limit);
    expect(await getSaleReceiptInfo(seller, saleId)).toMatchObject({ contentType: "image/png", sizeBytes: MAX_RECEIPT_BYTES });
  });

  it("entrada forjada (sem bytes ou com campo extra) é recusada", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const leadId = await newLead(org.ids.sellerA1);
    await expect(createSale(seller, saleInput(leadId, course, { receipt: "texto" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(createSale(seller, saleInput(leadId, course, { receipt: { fileName: "a.pdf", bytes: PDF, contentType: "text/html" } }))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("reenvio da mesma solicitação (replay) não grava um segundo comprovante", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const input = saleInput(await newLead(org.ids.sellerA1), course, { receipt: { fileName: "a.pdf", bytes: PDF } });
    const first = await createSale(seller, input);
    const again = await createSale(seller, { ...input, receipt: { fileName: "b.png", bytes: PNG } });
    expect(again).toEqual({ saleId: first.saleId, replayed: true });
    expect(await receiptsOf(first.saleId)).toBe(1);
    expect((await getSaleReceiptInfo(seller, first.saleId))?.fileName).toBe("a.pdf");
  });
});

describe("anexar, trocar e remover depois do registro (013/014)", () => {
  const rows = (saleId: string) =>
    handle.db
      .select({ id: saleReceipts.id, fileName: saleReceipts.fileName, content: saleReceipts.content, removedAt: saleReceipts.removedAt, removedBy: saleReceipts.removedBy })
      .from(saleReceipts)
      .where(eq(saleReceipts.saleId, saleId));
  const audits = (saleId: string) =>
    handle.db
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "sale"), eq(auditEvents.entityId, saleId)))
      .orderBy(auditEvents.id);

  it("anexar numa venda sem comprovante; trocar apaga o arquivo anterior e mantém o registro; remover idem", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course));

    const attached = await replaceSaleReceipt(seller, { saleId, expectedReceiptId: "", receipt: { fileName: "pix.pdf", bytes: PDF } });
    expect(attached.replaced).toBe(false);
    expect(await getSaleReceiptInfo(seller, saleId)).toMatchObject({ id: attached.receiptId, fileName: "pix.pdf" });

    const swapped = await replaceSaleReceipt(seller, { saleId, expectedReceiptId: attached.receiptId, receipt: { fileName: "foto.png", bytes: PNG } });
    expect(swapped.replaced).toBe(true);
    const file = await getSaleReceiptFile(seller, saleId);
    expect(file).toMatchObject({ id: swapped.receiptId, fileName: "foto.png", contentType: "image/png" });

    await removeSaleReceipt(await ctx(org.ids.supA), { saleId, expectedReceiptId: swapped.receiptId });
    expect(await getSaleReceiptInfo(seller, saleId)).toBeNull();
    await expect(getSaleReceiptFile(seller, saleId)).rejects.toBeInstanceOf(NotFoundError);

    // Histórico: os dois registros ficam, sem o arquivo.
    const history = await rows(saleId);
    expect(history).toHaveLength(2);
    expect(history.every((r) => r.content === null && r.removedAt !== null)).toBe(true);
    expect(history.find((r) => r.id === swapped.receiptId)?.removedBy).toBe(org.ids.supA);
    expect(history.find((r) => r.id === attached.receiptId)?.removedBy).toBe(org.ids.sellerA1);

    expect((await audits(saleId)).map((a) => [a.action, a.metadata.fileName, a.metadata.replaced ?? a.metadata.replacedReceiptId ?? null])).toEqual([
      ["sale.receipt_attached", "pix.pdf", null],
      ["sale.receipt_removed", "pix.pdf", true],
      ["sale.receipt_attached", "foto.png", attached.receiptId],
      ["sale.receipt_removed", "foto.png", false],
    ]);

    // Depois de remover, dá para anexar de novo.
    await replaceSaleReceipt(seller, { saleId, expectedReceiptId: null, receipt: { fileName: "novo.pdf", bytes: PDF } });
    expect((await getSaleReceiptInfo(seller, saleId))?.fileName).toBe("novo.pdf");
  });

  it("concorrência: comprovante diferente do que a tela mostrava → nada é gravado", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course, { receipt: { fileName: "a.pdf", bytes: PDF } }));
    const current = (await getSaleReceiptInfo(seller, saleId))!;

    // Tela antiga achava que não havia comprovante.
    await expect(replaceSaleReceipt(seller, { saleId, expectedReceiptId: "", receipt: { fileName: "b.png", bytes: PNG } })).rejects.toThrow(
      RECEIPT_CHANGED_CONCURRENTLY,
    );
    await removeSaleReceipt(seller, { saleId, expectedReceiptId: current.id });
    // Remover de novo (tela antiga) ou trocar o que já foi removido.
    await expect(removeSaleReceipt(seller, { saleId, expectedReceiptId: current.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(replaceSaleReceipt(seller, { saleId, expectedReceiptId: current.id, receipt: { fileName: "b.png", bytes: PNG } })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await rows(saleId)).toHaveLength(1);
  });

  it("permissões: as da edição da venda; vendedor não mexe em venda estornada nem na de outro; sem arquivo é recusado", async () => {
    const seller = await ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course));
    const attach = async (userId: string) =>
      replaceSaleReceipt(await ctx(userId), { saleId, expectedReceiptId: "", receipt: { fileName: "a.pdf", bytes: PDF } });

    await expect(attach(org.ids.sellerA2)).rejects.toBeInstanceOf(NotFoundError);
    await expect(attach(org.ids.sellerB1)).rejects.toBeInstanceOf(NotFoundError);
    await expectReceiptError(
      replaceSaleReceipt(seller, { saleId, expectedReceiptId: "", receipt: { fileName: "x.pdf", bytes: new TextEncoder().encode("texto") } }),
      RECEIPT_INVALID_TYPE,
    );
    const missing = await replaceSaleReceipt(seller, { saleId, expectedReceiptId: "", receipt: null }).then(
      () => null,
      (e: unknown) => e as ValidationError,
    );
    expect(missing?.fieldErrors).toEqual({ receipt: ["Escolha o arquivo do comprovante."] });

    const supervisor = await ctx(org.ids.supA);
    await reverseSale(supervisor, saleId, { expectedVersion: (await getSale(supervisor, saleId)).version, reason: "Teste do comprovante" });
    await expect(attach(org.ids.sellerA1)).rejects.toThrow(SALE_REVERSED_READ_ONLY);
    const { receiptId } = await attach(org.ids.supA);
    await expect(removeSaleReceipt(seller, { saleId, expectedReceiptId: receiptId })).rejects.toThrow(SALE_REVERSED_READ_ONLY);
    await removeSaleReceipt(await ctx(org.ids.admin), { saleId, expectedReceiptId: receiptId });
    expect(await getSaleReceiptInfo(seller, saleId)).toBeNull();
  });
});

describe("acesso ao comprovante: quem vê a venda vê o comprovante", () => {
  it("vendedor responsável, supervisor da equipe e ADMIN veem; outro vendedor recebe NotFound", async () => {
    const { saleId } = await createSale(
      await ctx(org.ids.sellerA1),
      saleInput(await newLead(org.ids.sellerA1), course, { receipt: { fileName: "a.png", bytes: PNG } }),
    );
    for (const userId of [org.ids.sellerA1, org.ids.supA, org.ids.admin]) {
      expect((await getSaleReceiptFile(await ctx(userId), saleId)).contentType, userId).toBe("image/png");
    }
    for (const userId of [org.ids.sellerA2, org.ids.sellerB1]) {
      await expect(getSaleReceiptFile(await ctx(userId), saleId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getSaleReceiptInfo(await ctx(userId), saleId)).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(getSaleReceiptFile(await ctx(org.ids.admin), "não-é-uuid")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("integridade no banco (012–014)", () => {
  const fails = async (statement: ReturnType<typeof sql>, pattern: RegExp) => {
    const error = (await handle.db.execute(statement).then(
      () => null,
      (e: unknown) => e,
    )) as { message: string; cause?: { message?: string } } | null;
    expect(error, String(pattern)).not.toBeNull();
    expect(`${error!.message} ${error!.cause?.message ?? ""}`).toMatch(pattern);
  };

  it("imutável, sem exclusão, um por venda, tipos e tamanho conferidos", async () => {
    const { saleId } = await createSale(
      await ctx(org.ids.sellerA1),
      saleInput(await newLead(org.ids.sellerA1), course, { receipt: { fileName: "a.pdf", bytes: PDF } }),
    );
    await fails(sql`update sale_receipts set file_name = 'outro.pdf' where sale_id = ${saleId}`, /imutáveis/);
    await fails(sql`update sale_receipts set content = null where sale_id = ${saleId}`, /única alteração permitida é a remoção/);
    await fails(sql`delete from sale_receipts where sale_id = ${saleId}`, /não permitida/);
    await fails(sql`truncate sale_receipts`, /não permitida/);
    const insert = (contentType: string, content: ReturnType<typeof sql>, size: number) =>
      sql`insert into sale_receipts (sale_id, file_name, content_type, size_bytes, content, uploaded_by)
          values (${saleId}, 'x', ${contentType}, ${size}, ${content}, ${org.ids.admin})`;
    await fails(insert("application/pdf", sql`'\\x255044462d'::bytea`, 5), /sale_receipts_current_unique/);

    const { saleId: other } = await createSale(await ctx(org.ids.sellerA1), saleInput(await newLead(org.ids.sellerA1), course));
    const insertOther = (contentType: string, content: ReturnType<typeof sql>, size: number) =>
      sql`insert into sale_receipts (sale_id, file_name, content_type, size_bytes, content, uploaded_by)
          values (${other}, 'x', ${contentType}, ${size}, ${content}, ${org.ids.admin})`;
    await fails(insertOther("text/html", sql`'\\x3c68746d6c3e'::bytea`, 6), /sale_receipts_content_type_allowed/);
    await fails(insertOther("application/pdf", sql`'\\x255044462d'::bytea`, 4), /sale_receipts_size_limit/);
    await fails(insertOther("application/pdf", sql`''::bytea`, 0), /sale_receipts_size_limit/);
  });
});
