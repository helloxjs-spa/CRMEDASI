import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { percentChange } from "@/lib/dashboard";
import { goalProgress, monthStart, monthState, previousMonth, projectedMonthCents, type MonthState } from "@/lib/goals";
import { isValidMonth, monthRange } from "@/lib/ranking";
import type { Actor } from "@/server/authz/actor";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import { canManageTeam } from "@/server/authz/scope";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { sales, sellerGoals, teams, users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { NotFoundError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { idSchema, parseInput } from "@/server/validation";

/**
 * Card "Resultado do mês": faturamento realizado × meta, por vendedor e do
 * time inteiro (decisões do cliente).
 *
 * - Realizado = soma de `sales.total_cents` das vendas VÁLIDAS (`ACTIVE`) pela
 *   data da venda, a mesma regra do "Faturamento" do dashboard.
 * - Visibilidade: TODOS os perfis veem o resultado e a meta de todos os
 *   vendedores (`goals:view`); custo e lucro nunca entram aqui.
 * - Meta do time inteiro = soma das metas individuais do mês (não é gravada).
 * - Definir meta (`goals:manage`): ADMIN para qualquer vendedor; SUPERVISOR só
 *   para os vendedores ATUALMENTE na equipe que lidera. Fora do escopo → 404.
 * - Vendedores listados: os ativos e também os inativos que tenham venda
 *   válida ou meta no mês (para o total bater com a soma das linhas).
 */

export type SellerGoalRow = {
  sellerId: string;
  name: string;
  teamName: string | null;
  active: boolean;
  realizedCents: number;
  goalCents: number | null;
  /** % da meta atingido; null sem meta. */
  progress: number | null;
  /** O ator pode definir a meta deste vendedor. */
  canEdit: boolean;
};

export type MonthlyGoals = {
  month: string;
  state: MonthState;
  realizedCents: number;
  /** Variação sobre o mês anterior; null sem base comparável. */
  changeVsPrevious: number | null;
  /** Soma das metas dos vendedores; null se nenhum tiver meta. */
  goalCents: number | null;
  progress: number | null;
  /** Projeção para o fim do mês no ritmo atual (mês encerrado: o realizado; futuro: null). */
  projectedCents: number | null;
  sellers: SellerGoalRow[];
};

/** Teto (cabe em `integer`) e proteção contra erros de digitação: R$ 20.000.000,00. */
const MAX_TARGET_CENTS = 2_000_000_000;

const monthSchema = z.string().refine(isValidMonth, { message: "Mês inválido." });

const getSchema = z.strictObject({ month: monthSchema });

const setSchema = z.strictObject({
  sellerId: idSchema,
  month: monthSchema,
  targetCents: z
    .number({ error: "Informe uma meta válida (ex.: 50.000,00)." })
    .int("Informe uma meta válida (ex.: 50.000,00).")
    .min(1, "A meta deve ser maior que zero.")
    .max(MAX_TARGET_CENTS, "Valor acima do limite permitido."),
});

function today(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_RULES.timezone }).format(now);
}

const sumCents = sql<number>`coalesce(sum(${sales.totalCents}), 0)::bigint`.mapWith(Number);

async function realizedBySeller(db: Database, month: string): Promise<Map<string, number>> {
  const { from, to } = monthRange(month);
  const rows = await db
    .select({ sellerId: sales.sellerId, cents: sumCents })
    .from(sales)
    .where(and(eq(sales.status, "ACTIVE"), gte(sales.saleDate, from), lte(sales.saleDate, to)))
    .groupBy(sales.sellerId);
  return new Map(rows.map((row) => [row.sellerId, row.cents]));
}

function canEditSeller(actor: Actor, seller: { teamId: string | null; active: boolean }): boolean {
  if (!hasPermission(actor, "goals:manage") || !seller.active) return false;
  return canManageTeam(actor, seller.teamId);
}

export async function getMonthlyGoals({ db, actor }: ServiceContext, input: unknown, now = new Date()): Promise<MonthlyGoals> {
  assertPermission(actor, "goals:view");
  const { month } = parseInput(getSchema, input);

  const [realized, previous, goals, sellers] = await Promise.all([
    realizedBySeller(db, month),
    realizedBySeller(db, previousMonth(month)),
    db
      .select({ sellerId: sellerGoals.sellerId, targetCents: sellerGoals.targetCents })
      .from(sellerGoals)
      .where(eq(sellerGoals.month, monthStart(month))),
    db
      .select({ id: users.id, name: users.name, active: users.active, teamId: users.teamId, teamName: teams.name })
      .from(users)
      .leftJoin(teams, eq(teams.id, users.teamId))
      .where(eq(users.role, "SELLER"))
      .orderBy(asc(users.name)),
  ]);
  const goalBySeller = new Map(goals.map((g) => [g.sellerId, g.targetCents]));

  const rows: SellerGoalRow[] = sellers
    .filter((s) => s.active || realized.has(s.id) || goalBySeller.has(s.id))
    .map((s) => {
      const realizedCents = realized.get(s.id) ?? 0;
      const goalCents = goalBySeller.get(s.id) ?? null;
      return {
        sellerId: s.id,
        name: s.name,
        teamName: s.teamName,
        active: s.active,
        realizedCents,
        goalCents,
        progress: goalProgress(realizedCents, goalCents),
        canEdit: canEditSeller(actor, s),
      };
    });

  const realizedCents = [...realized.values()].reduce((sum, cents) => sum + cents, 0);
  const previousCents = [...previous.values()].reduce((sum, cents) => sum + cents, 0);
  const goalCents = goals.length > 0 ? goals.reduce((sum, g) => sum + g.targetCents, 0) : null;
  const day = today(now);

  return {
    month,
    state: monthState(month, day),
    realizedCents,
    changeVsPrevious: percentChange(realizedCents, previousCents),
    goalCents,
    progress: goalProgress(realizedCents, goalCents),
    projectedCents: projectedMonthCents(realizedCents, month, day),
    sellers: rows,
  };
}

/** Cria ou altera a meta do vendedor no mês (auditado com o valor anterior). */
export async function setSellerGoal({ db, actor }: ServiceContext, input: unknown): Promise<void> {
  assertPermission(actor, "goals:manage");
  const data = parseInput(setSchema, input);
  const month = monthStart(data.month);

  await db.transaction(async (tx) => {
    const [seller] = await tx
      .select({ name: users.name, teamId: users.teamId, active: users.active })
      .from(users)
      .where(and(eq(users.id, data.sellerId), eq(users.role, "SELLER")))
      .limit(1);
    if (!seller || !canEditSeller(actor, seller)) throw new NotFoundError();

    const [before] = await tx
      .select({ targetCents: sellerGoals.targetCents })
      .from(sellerGoals)
      .where(and(eq(sellerGoals.sellerId, data.sellerId), eq(sellerGoals.month, month)))
      .for("update")
      .limit(1);
    if (before?.targetCents === data.targetCents) return;

    const [saved] = await tx
      .insert(sellerGoals)
      .values({ sellerId: data.sellerId, month, targetCents: data.targetCents, createdBy: actor.userId, updatedBy: actor.userId })
      .onConflictDoUpdate({
        target: [sellerGoals.sellerId, sellerGoals.month],
        set: { targetCents: data.targetCents, updatedBy: actor.userId, updatedAt: new Date() },
      })
      .returning({ id: sellerGoals.id });

    await recordAudit(tx, {
      actorId: actor.userId,
      action: "goal.set",
      entityType: "seller_goal",
      entityId: saved.id,
      teamId: seller.teamId,
      metadata: { sellerId: data.sellerId, sellerName: seller.name, month: data.month, fromCents: before?.targetCents ?? null, toCents: data.targetCents },
    });
  });
}
