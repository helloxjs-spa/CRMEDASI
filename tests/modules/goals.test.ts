import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, sellerGoals } from "@/server/db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { getMonthlyGoals, setSellerGoal } from "@/server/modules/goals/goals.service";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale, getSale, reverseSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourseWithCost } from "../support/sales";

/**
 * Cenário: A1 vende R$ 1.000 + R$ 2.000 em julho (e uma venda de R$ 5.000
 * estornada); B1 vende R$ 4.000 em julho e R$ 1.500 em junho.
 */
let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let seq = 0;
const ctx = (userId: string) => org.ctx(userId);
const JUL = { month: "2026-07" };
/** "Hoje" fixo para a projeção: 10 de julho de 2026 ao meio-dia (Brasília). */
const NOW = new Date("2026-07-10T15:00:00Z");

async function sale(sellerId: string, saleDate: string, priceCents: number): Promise<string> {
  const lead = await createLead(await ctx(sellerId), { name: `Cliente Meta ${++seq}`, phone: `(79) 92${String(seq).padStart(7, "0")}`, source: "GOOGLE", interestCourseId: course });
  const input = { requestId: crypto.randomUUID(), leadId: lead.id, sellerId, saleDate, paymentMethod: "PIX", items: [{ courseId: course, priceCents }] };
  return (await createSale(await ctx(org.ids.admin), input)).saleId;
}

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  await sale(org.ids.sellerA1, "2026-07-05", 100_000);
  await sale(org.ids.sellerA1, "2026-07-08", 200_000);
  const reversed = await sale(org.ids.sellerA1, "2026-07-09", 500_000);
  const admin = await ctx(org.ids.admin);
  await reverseSale(admin, reversed, { expectedVersion: (await getSale(admin, reversed)).version, reason: "Desistência" });
  await sale(org.ids.sellerB1, "2026-07-02", 400_000);
  await sale(org.ids.sellerB1, "2026-06-20", 150_000);
});
afterAll(() => handle.close());

describe("leitura do resultado do mês", () => {
  it("todos os perfis veem todos os vendedores e o mesmo total (só vendas válidas)", async () => {
    for (const who of ["admin", "supA", "sellerA1", "sellerB1"] as const) {
      const goals = await getMonthlyGoals(await ctx(org.ids[who]), JUL, NOW);
      expect(goals.realizedCents, who).toBe(700_000);
      const bySeller = Object.fromEntries(goals.sellers.map((s) => [s.name, s.realizedCents]));
      expect(bySeller, who).toEqual({ "Vendedor A1": 300_000, "Vendedor A2": 0, "Vendedor B1": 400_000 });
    }
  });

  it("variação sobre o mês anterior e ritmo do mês atual", async () => {
    const goals = await getMonthlyGoals(await ctx(org.ids.admin), JUL, NOW);
    expect(goals.state).toBe("current");
    expect(goals.changeVsPrevious).toBeCloseTo(((700_000 - 150_000) / 150_000) * 100);
    // R$ 7.000 em 10 dias → 31 dias.
    expect(goals.projectedCents).toBe(2_170_000);
    expect(goals.goalCents).toBeNull();
  });

  it("mês inválido é recusado", async () => {
    await expect(getMonthlyGoals(await ctx(org.ids.admin), { month: "2026-13" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("definir meta", () => {
  it("vendedor não define meta", async () => {
    await expect(setSellerGoal(await ctx(org.ids.sellerA1), { sellerId: org.ids.sellerA1, month: "2026-07", targetCents: 1 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("supervisor define para vendedores de qualquer equipe, nunca para quem não é vendedor", async () => {
    const supA = await ctx(org.ids.supA);
    await setSellerGoal(supA, { sellerId: org.ids.sellerA1, month: "2026-07", targetCents: 600_000 });
    // Outra equipe: permitido (o teste seguinte grava o valor final de B1).
    await setSellerGoal(supA, { sellerId: org.ids.sellerB1, month: "2026-07", targetCents: 1 });
    await expect(setSellerGoal(supA, { sellerId: org.ids.supB, month: "2026-07", targetCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("admin define para qualquer vendedor; a meta do time é a soma", async () => {
    await setSellerGoal(await ctx(org.ids.admin), { sellerId: org.ids.sellerB1, month: "2026-07", targetCents: 400_000 });
    const goals = await getMonthlyGoals(await ctx(org.ids.sellerA2), JUL, NOW);
    expect(goals.goalCents).toBe(1_000_000);
    expect(goals.progress).toBe(70);
    const b1 = goals.sellers.find((s) => s.name === "Vendedor B1")!;
    expect(b1).toMatchObject({ goalCents: 400_000, progress: 100, canEdit: false });
  });

  it("canEdit acompanha o escopo de quem lê", async () => {
    const edit = async (who: "admin" | "supA" | "sellerA1") =>
      Object.fromEntries((await getMonthlyGoals(await ctx(org.ids[who]), JUL, NOW)).sellers.map((s) => [s.name, s.canEdit]));
    expect(await edit("admin")).toEqual({ "Vendedor A1": true, "Vendedor A2": true, "Vendedor B1": true });
    expect(await edit("supA")).toEqual({ "Vendedor A1": true, "Vendedor A2": true, "Vendedor B1": true });
    expect(await edit("sellerA1")).toEqual({ "Vendedor A1": false, "Vendedor A2": false, "Vendedor B1": false });
  });

  it("alterar a meta atualiza a mesma linha e audita o valor anterior", async () => {
    await setSellerGoal(await ctx(org.ids.admin), { sellerId: org.ids.sellerA1, month: "2026-07", targetCents: 650_000 });
    const rows = await handle.db.select().from(sellerGoals).where(and(eq(sellerGoals.sellerId, org.ids.sellerA1), eq(sellerGoals.month, "2026-07-01")));
    expect(rows).toHaveLength(1);
    expect(rows[0].targetCents).toBe(650_000);
    const audits = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, "goal.set"));
    expect(audits.map((a) => a.metadata)).toContainEqual(expect.objectContaining({ sellerId: org.ids.sellerA1, fromCents: 600_000, toCents: 650_000 }));
  });

  it("valida o valor e não aceita vendedor desativado", async () => {
    const admin = await ctx(org.ids.admin);
    await expect(setSellerGoal(admin, { sellerId: org.ids.sellerA1, month: "2026-07", targetCents: 0 })).rejects.toBeInstanceOf(ValidationError);
    const inactive = await insertUser(handle, { name: "Vendedor Inativo", role: "SELLER", teamId: org.ids.teamA, active: false });
    await expect(setSellerGoal(admin, { sellerId: inactive, month: "2026-07", targetCents: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("o banco recusa exclusão e meta de quem não é vendedor", async () => {
    await expect(handle.db.execute(sql`delete from seller_goals`)).rejects.toThrow();
    await expect(
      handle.db.insert(sellerGoals).values({ sellerId: org.ids.supA, month: "2026-07-01", targetCents: 1, createdBy: org.ids.admin, updatedBy: org.ids.admin }),
    ).rejects.toThrow();
  });
});
