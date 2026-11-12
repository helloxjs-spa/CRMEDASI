import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { NotFoundError } from "@/server/errors";
import type { Actor } from "./actor";

/**
 * Escopo de dados (ownership + equipe). Complementa o RBAC de ./permissions.ts:
 *
 *   ADMIN e SUPERVISOR → tudo (decisão do cliente, 2026-11-06: o supervisor
 *                        vê o mesmo que o ADMIN; a diferença fica só no RBAC).
 *   SELLER             → registros dos quais ele é o responsável (owner).
 *
 * Toda consulta de recurso com dono (leads, vendas, parcelas, certificados...)
 * deve compor `ownedScope()` no WHERE, inclusive buscas por ID. Assim, trocar um
 * ID na URL ou no payload simplesmente não encontra o registro (proteção IDOR).
 */

const NOTHING = sql`false`;

/** Vê os dados da empresa toda (todas as equipes): ADMIN e SUPERVISOR. */
export function hasCompanyScope(actor: Pick<Actor, "role">): boolean {
  return actor.role === "ADMIN" || actor.role === "SUPERVISOR";
}

export type OwnedRecord = { ownerId: string | null; teamId: string | null };

export function canAccessOwned(actor: Actor, record: OwnedRecord): boolean {
  return hasCompanyScope(actor) || record.ownerId === actor.userId;
}

export function assertCanAccessOwned(actor: Actor, record: OwnedRecord | null | undefined): asserts record {
  if (!record || !canAccessOwned(actor, record)) throw new NotFoundError();
}

/** Filtro SQL equivalente a `canAccessOwned`. `undefined` = sem restrição. */
export function ownedScope(
  actor: Actor,
  columns: { ownerId: AnyPgColumn; teamId: AnyPgColumn },
): SQL | undefined {
  return hasCompanyScope(actor) ? undefined : eq(columns.ownerId, actor.userId);
}

/** Visão de gestão (equipes, membros, dados agregados): fora dela → NotFound. */
export function assertCompanyScope(actor: Pick<Actor, "role">): void {
  if (!hasCompanyScope(actor)) throw new NotFoundError();
}

/** Filtro SQL equivalente a `hasCompanyScope`. `undefined` = sem restrição. */
export function companyScope(actor: Pick<Actor, "role">): SQL | undefined {
  return hasCompanyScope(actor) ? undefined : NOTHING;
}
