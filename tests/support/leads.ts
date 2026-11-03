import { eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "@/server/db/connect";
import { courses, leads, type LeadStage } from "@/server/db/schema";

/** Curso ativo para os cadastros de lead dos testes. */
/** Comissão padrão dos cursos criados nos testes (R$ 100,00). */
export const TEST_COMMISSION_CENTS = 100_00;

export async function insertCourse(handle: DatabaseHandle, name = "Pedagogia", active = true, commissionCents = TEST_COMMISSION_CENTS): Promise<string> {
  const [course] = await handle.db.insert(courses).values({ name, institutionName: "Faculdade Teste", active, commissionCents }).returning({ id: courses.id });
  return course.id;
}

/**
 * Coloca o lead numa etapa diretamente no banco (a movimentação de etapas é
 * da fase Kanban). `dueInHours` negativo = prazo já vencido.
 */
export async function setLeadStage(handle: DatabaseHandle, leadId: string, stage: LeadStage, dueInHours?: number): Promise<void> {
  await handle.db
    .update(leads)
    .set({
      stage,
      stageEnteredAt: dueInHours === undefined ? sql`now()` : sql`now() - interval '48 hours'`,
      stageDueAt: dueInHours === undefined ? null : sql`now() + make_interval(hours => ${dueInHours})`,
    })
    .where(eq(leads.id, leadId));
}
