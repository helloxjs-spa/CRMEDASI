import { describe, expect, it } from "vitest";
import type { Actor } from "@/server/authz/actor";
import { hasPermission } from "@/server/authz/permissions";
import { canAccessOwned, hasCompanyScope } from "@/server/authz/scope";

const admin: Actor = { userId: "admin", name: "", email: "", role: "ADMIN", teamId: null, supervisedTeamId: null };
const supA: Actor = { userId: "supA", name: "", email: "", role: "SUPERVISOR", teamId: null, supervisedTeamId: "teamA" };
const supWithoutTeam: Actor = { ...supA, userId: "supX", supervisedTeamId: null };
const sellerA1: Actor = { userId: "a1", name: "", email: "", role: "SELLER", teamId: "teamA", supervisedTeamId: null };

const recordOfA1 = { ownerId: "a1", teamId: "teamA" };
const recordOfA2 = { ownerId: "a2", teamId: "teamA" };
const recordOfB1 = { ownerId: "b1", teamId: "teamB" };

describe("RBAC — matriz de permissões", () => {
  it("custo de bolsa, lucro e gestão de cursos: ADMIN e SUPERVISOR; vendedor não", () => {
    for (const permission of ["courses:viewCost", "courses:manage", "finance:viewCostAndProfit"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("gestão de usuários e equipes: ADMIN e SUPERVISOR; vendedor não", () => {
    for (const permission of ["users:manage", "teams:manage"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("exclusivo do ADMIN: Auditoria, contas ADMIN e alteração de perfil", () => {
    for (const permission of ["audit:view", "users:manageAdmins", "users:changeRole"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(false);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("vendedor não transfere, redistribui, recupera, estorna nem reativa venda", () => {
    for (const permission of ["leads:transfer", "leads:redistribute", "leads:restore", "sales:reverse", "sales:reactivate"] as const) {
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("cadastro de leads (C41): SELLER, SUPERVISOR e ADMIN; papel desconhecido é negado", () => {
    for (const actor of [sellerA1, supA, supWithoutTeam, admin]) expect(hasPermission(actor, "leads:create")).toBe(true);
    const unknownRole = { ...sellerA1, role: "VISITANTE" } as unknown as Actor;
    expect(hasPermission(unknownRole, "leads:create")).toBe(false);
  });

  it("vendas (C36): todos registram e consultam (com escopo); ADMIN e SUPERVISOR escolhem a data", () => {
    for (const actor of [admin, supA, sellerA1]) {
      expect(hasPermission(actor, "sales:create")).toBe(true);
      expect(hasPermission(actor, "sales:view")).toBe(true);
    }
    expect(hasPermission(admin, "sales:setDate")).toBe(true);
    expect(hasPermission(supA, "sales:setDate")).toBe(true);
    expect(hasPermission(sellerA1, "sales:setDate")).toBe(false);
  });

  it("leads: todos veem (com escopo); só o vendedor registra observação; supervisor e admin operam a carteira", () => {
    for (const actor of [admin, supA, sellerA1]) {
      expect(hasPermission(actor, "leads:view")).toBe(true);
      expect(hasPermission(actor, "leads:edit")).toBe(true);
    }
    expect(hasPermission(sellerA1, "leads:addNote")).toBe(true);
    expect(hasPermission(sellerA1, "leads:move")).toBe(true);
    expect(hasPermission(supA, "leads:move")).toBe(false);
    expect(hasPermission(admin, "leads:move")).toBe(false);
    expect(hasPermission(supA, "leads:addNote")).toBe(false);
    expect(hasPermission(admin, "leads:addNote")).toBe(false);
    for (const permission of ["leads:transfer", "leads:redistribute", "leads:trash", "leads:restore"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("edição de venda (C36): todos editam itens; só supervisor e admin mexem no financeiro, no responsável e em venda estornada", () => {
    for (const actor of [admin, supA, sellerA1]) expect(hasPermission(actor, "sales:edit")).toBe(true);
    for (const permission of ["sales:editFinancial", "sales:changeSeller", "sales:editReversed"] as const) {
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("supervisor e admin estornam e reativam vendas (C36, substitui C1); vendedor não", () => {
    for (const permission of ["sales:reverse", "sales:reactivate"] as const) {
      expect(hasPermission(supA, permission)).toBe(true);
      expect(hasPermission(admin, permission)).toBe(true);
      expect(hasPermission(sellerA1, permission)).toBe(false);
    }
  });

  it("todos os perfis veem o ranking e as parcelas; só ADMIN e SUPERVISOR confirmam pagamento", () => {
    for (const actor of [admin, supA, sellerA1]) {
      expect(hasPermission(actor, "ranking:view")).toBe(true);
      expect(hasPermission(actor, "installments:view")).toBe(true);
    }
    expect(hasPermission(admin, "installments:markPaid")).toBe(true);
    expect(hasPermission(supA, "installments:markPaid")).toBe(true);
    expect(hasPermission(sellerA1, "installments:markPaid")).toBe(false);
  });
});

describe("Escopo — ownership e empresa", () => {
  it("vendedor acessa apenas registros dos quais é responsável", () => {
    expect(canAccessOwned(sellerA1, recordOfA1)).toBe(true);
    expect(canAccessOwned(sellerA1, recordOfA2)).toBe(false);
    expect(canAccessOwned(sellerA1, recordOfB1)).toBe(false);
    expect(hasCompanyScope(sellerA1)).toBe(false);
  });

  it("supervisor acessa registros de todas as equipes, como o administrador", () => {
    for (const actor of [supA, supWithoutTeam, admin]) {
      expect(canAccessOwned(actor, recordOfA1)).toBe(true);
      expect(canAccessOwned(actor, recordOfB1)).toBe(true);
      expect(canAccessOwned(actor, { ownerId: null, teamId: null })).toBe(true);
      expect(hasCompanyScope(actor)).toBe(true);
    }
  });
});
