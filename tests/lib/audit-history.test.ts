import { describe, expect, it } from "vitest";
import { auditHref, hasAuditFilters, parseAuditParams } from "@/app/(app)/auditoria/search-params";
import { describeAuditEvent } from "@/lib/audit-history";
import { formatBRL } from "@/lib/money";
import { AUDIT_ACTIONS } from "@/server/modules/audit/audit.service";

const USER = "11111111-1111-4111-8111-111111111111";
const SALE = "22222222-2222-4222-8222-222222222222";

describe("describeAuditEvent", () => {
  it("falha de login: e-mail, motivo traduzido e IP", () => {
    const text = describeAuditEvent({
      action: "auth.login_failed",
      metadata: { email: "a@b.com", ipAddress: "1.2.3.4", reason: "wrong_password" },
    });
    expect(text).toEqual({ target: null, lines: ["E-mail: a@b.com", "Motivo: Senha incorreta", "IP: 1.2.3.4"] });
  });

  it("login sem IP conhecido não mostra linha vazia", () => {
    expect(describeAuditEvent({ action: "auth.login", metadata: { ipAddress: null } }).lines).toEqual([]);
  });

  it("valores em centavos aparecem em reais, de → para", () => {
    const text = describeAuditEvent({
      action: "course.commission_changed",
      targetName: "Enfermagem — Inst",
      metadata: { name: "Enfermagem", fromCents: 10000, toCents: 15000 },
    });
    expect(text.target).toBe("Enfermagem — Inst");
    expect(text.lines).toEqual([`Comissão: ${formatBRL(10000)} → ${formatBRL(15000)}`]);
  });

  it("alterações: rótulos traduzidos e situação da equipe por extenso", () => {
    const text = describeAuditEvent({
      action: "team.updated",
      targetName: "Equipe A",
      metadata: { changes: { name: { from: "A", to: "B" }, active: { from: true, to: false } } },
    });
    expect(text.lines).toEqual(["Nome: A → B", "Situação: Ativa → Inativa"]);
  });

  it("troca de equipe usa o retrato gravado e aceita vendedor sem equipe", () => {
    const text = describeAuditEvent({
      action: "user.team_changed",
      targetName: "Ana",
      metadata: { from: null, to: { teamName: "Equipe B", supervisorName: "Bia" }, movedLeads: 2 },
    });
    expect(text.lines).toEqual(["De: Sem equipe", "Para: Equipe B (supervisor: Bia)", "Leads movidos junto: 2"]);
  });

  it("supervisor removido aparece como 'Sem supervisor'", () => {
    const text = describeAuditEvent({ action: "team.supervisor_changed", metadata: { fromSupervisorName: "Bia", toSupervisorName: null } });
    expect(text.lines).toEqual(["Supervisor: Bia → Sem supervisor"]);
  });

  it("parcela e certificado trazem datas em pt-BR e a venda ligada", () => {
    const paid = describeAuditEvent({ action: "installment.paid", metadata: { saleId: SALE, number: 2, amountCents: 30000, dueDate: "2026-11-10" } });
    expect(paid.saleId).toBe(SALE);
    expect(paid.lines).toEqual([`Parcela 2: ${formatBRL(30000)}`, "Vencimento: 10/11/2026"]);
    const certificate = describeAuditEvent({
      action: "certificate.created",
      metadata: { saleId: SALE, completedOn: "2026-10-01", deliveredOn: "2026-10-05", certifier: "Cert" },
    });
    expect(certificate.saleId).toBe(SALE);
    expect(certificate.lines).toEqual(["Conclusão: 01/10/2026", "Entrega: 05/10/2026", "Certificadora: Cert"]);
  });

  it("comprovante anexado: nome e tamanho do arquivo, com link para a venda", () => {
    const receipt = describeAuditEvent({
      action: "sale.receipt_attached",
      metadata: { saleId: SALE, receiptId: "id-interno", fileName: "pix.pdf", contentType: "application/pdf", sizeBytes: 2048 },
    });
    expect(receipt.saleId).toBe(SALE);
    expect(receipt.lines).toEqual(["Comprovante: pix.pdf", "Tamanho: 2 KB"]);
    const swapped = describeAuditEvent({ action: "sale.receipt_attached", metadata: { saleId: SALE, fileName: "b.png", sizeBytes: 1024, replacedReceiptId: "id-interno" } });
    expect(swapped.lines).toEqual(["Comprovante: b.png", "Tamanho: 1 KB", "Substituiu o comprovante anterior"]);
    const removed = describeAuditEvent({ action: "sale.receipt_removed", metadata: { saleId: SALE, fileName: "pix.pdf", sizeBytes: 2048, replaced: false } });
    expect(removed.saleId).toBe(SALE);
    expect(removed.lines).toEqual(["Comprovante: pix.pdf", "Tamanho: 2 KB", "Arquivo apagado"]);
  });

  it("meta: nome gravado do vendedor; primeira definição não mostra valor anterior", () => {
    const first = describeAuditEvent({ action: "goal.set", metadata: { sellerName: "Ana", month: "2026-11", fromCents: null, toCents: 50000 } });
    expect(first.target).toBe("Ana");
    expect(first.lines).toEqual(["Mês: Novembro de 2026", `Meta: ${formatBRL(50000)}`]);
    const changed = describeAuditEvent({ action: "goal.set", metadata: { sellerName: "Ana", month: "2026-11", fromCents: 40000, toCents: 50000 } });
    expect(changed.lines[1]).toBe(`Meta: ${formatBRL(40000)} → ${formatBRL(50000)}`);
  });

  it("nenhum evento conhecido cai no texto genérico nem expõe identificador interno", () => {
    const metadata = { saleItemId: "id-interno", courseId: "id-interno", fromTeamId: "id-interno", toTeamId: "id-interno", sellerId: "id-interno", supervisorId: "id-interno" };
    for (const action of Object.keys(AUDIT_ACTIONS)) {
      const { lines } = describeAuditEvent({ action, metadata });
      expect(lines.join(" "), action).not.toContain("id-interno");
    }
  });

  it("evento desconhecido não perde o que foi gravado", () => {
    const text = describeAuditEvent({ action: "novo.evento", metadata: { a: 1, b: { c: 2 } } });
    expect(text.lines).toEqual(["a: 1", 'b: {"c":2}']);
  });
});

describe("filtros da auditoria na URL", () => {
  it("lê valores válidos e monta o link de volta, com o cursor", () => {
    const params = parseAuditParams({ usuario: USER, acao: "auth.login_failed", de: "2026-11-01", ate: "2026-11-03" });
    expect(params).toEqual({ user: USER, action: "auth.login_failed", from: "2026-11-01", to: "2026-11-03" });
    expect(hasAuditFilters(params)).toBe(true);
    expect(parseAuditParams(Object.fromEntries(new URL(auditHref(params, 42), "http://x").searchParams))).toEqual(params);
    expect(auditHref(params, 42)).toContain("antes=42");
  });

  it("ignora valores inválidos, inclusive propriedades herdadas do objeto", () => {
    const params = parseAuditParams({ usuario: "abc", acao: "constructor", de: "ontem", ate: "2026-99-99" });
    expect(params).toEqual({ user: undefined, action: undefined, from: undefined, to: undefined });
    expect(hasAuditFilters(params)).toBe(false);
    expect(auditHref(params)).toBe("/auditoria");
  });
});
