import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { assertPermission } from "@/server/authz/permissions";
import { BUSINESS_RULES } from "@/server/config/business-rules";
import type { ServiceContext } from "@/server/context";
import { auditEvents, courses, teams, users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { idSchema, parseInput } from "@/server/validation";

export const AUDIT_ACTIONS = {
  "auth.login": "Login",
  "auth.login_failed": "Falha de login",
  "auth.login_throttled": "Login bloqueado por excesso de tentativas",
  "auth.reauth_failed": "Confirmação de senha recusada",
  "auth.logout": "Logout",
  "auth.password_changed": "Senha alterada pelo próprio usuário",
  "auth.admin_bootstrapped": "Primeiro administrador criado (bootstrap)",
  "user.created": "Usuário criado",
  "user.updated": "Usuário atualizado",
  "user.activated": "Usuário reativado",
  "user.deactivated": "Usuário desativado",
  "user.password_reset": "Senha redefinida pelo administrador",
  "user.team_changed": "Vendedor trocou de equipe",
  "team.created": "Equipe criada",
  "team.updated": "Equipe atualizada",
  "team.supervisor_changed": "Supervisor da equipe alterado",
  "course.created": "Curso criado",
  "course.updated": "Curso atualizado",
  "course.cost_changed": "Custo da bolsa alterado",
  "course.commission_changed": "Comissão do curso alterada",
  "course.activated": "Curso reativado",
  "course.deactivated": "Curso desativado",
  "certificate.created": "Certificado registrado",
  "installment.paid": "Parcela marcada como paga",
  "sale.receipt_attached": "Comprovante de pagamento anexado à venda",
  "sale.receipt_removed": "Comprovante de pagamento removido da venda",
  "goal.set": "Meta mensal do vendedor definida",
  "report.exported": "Relatório exportado",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const AUDIT_ENTITY_TYPES = ["user", "team", "session", "course", "certificate", "installment", "sale", "seller_goal", "report"] as const;

export type AuditInput = {
  actorId: string | null;
  action: AuditAction;
  entityType: (typeof AUDIT_ENTITY_TYPES)[number];
  entityId?: string | null;
  teamId?: string | null;
  metadata?: Record<string, unknown>;
};

/** Grava um evento. Deve ser chamado dentro da mesma transação da mudança auditada. */
export async function recordAudit(db: Database, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    teamId: input.teamId ?? null,
    metadata: input.metadata ?? {},
  });
}

export const AUDIT_PAGE_SIZE = 50;

const listFiltersSchema = z.strictObject({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  actorId: idSchema.optional(),
  action: z.enum(Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]]).optional(),
  /** Período pela data do evento, no fuso do negócio (inclusive nas duas pontas). */
  from: z.iso.date({ error: "Data inválida." }).optional(),
  to: z.iso.date({ error: "Data inválida." }).optional(),
  /** Paginação: eventos com id menor que este (inteiro positivo, dentro do intervalo seguro). */
  beforeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

export async function listAuditEvents({ db, actor }: ServiceContext, rawFilters: unknown = {}) {
  assertPermission(actor, "audit:view");
  const filters = parseInput(listFiltersSchema, rawFilters);
  const conditions: SQL[] = [];
  if (filters.entityType) conditions.push(eq(auditEvents.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditEvents.entityId, filters.entityId));
  if (filters.actorId) conditions.push(eq(auditEvents.actorId, filters.actorId));
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  const occurredDay = sql`(${auditEvents.occurredAt} at time zone ${BUSINESS_RULES.timezone})::date`;
  if (filters.from) conditions.push(sql`${occurredDay} >= ${filters.from}::date`);
  if (filters.to) conditions.push(sql`${occurredDay} <= ${filters.to}::date`);
  if (filters.beforeId) conditions.push(lt(auditEvents.id, filters.beforeId));

  const actorUser = alias(users, "actor_user");
  const targetUser = alias(users, "target_user");
  return db
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      metadata: auditEvents.metadata,
      actorName: actorUser.name,
      /** Nome atual de quem ou do que foi afetado; o certificado aponta para o curso. */
      targetName: sql<string | null>`coalesce(${targetUser.name}, ${teams.name}, ${courses.name} || ' — ' || ${courses.institutionName})`,
    })
    .from(auditEvents)
    .leftJoin(actorUser, eq(actorUser.id, auditEvents.actorId))
    .leftJoin(targetUser, and(eq(auditEvents.entityType, "user"), sql`${targetUser.id}::text = ${auditEvents.entityId}`))
    .leftJoin(teams, and(eq(auditEvents.entityType, "team"), sql`${teams.id}::text = ${auditEvents.entityId}`))
    .leftJoin(
      courses,
      or(
        and(eq(auditEvents.entityType, "course"), sql`${courses.id}::text = ${auditEvents.entityId}`),
        and(eq(auditEvents.entityType, "certificate"), sql`${courses.id}::text = ${auditEvents.metadata} ->> 'courseId'`),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(auditEvents.id))
    .limit(AUDIT_PAGE_SIZE);
}
