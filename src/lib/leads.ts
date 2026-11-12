import type { LeadSource, LeadStage, LeadStatus } from "@/server/db/schema";
import { BUSINESS_RULES } from "@/server/config/business-rules";

/**
 * Rótulos e estados de exibição dos leads (puros: usados em Server e Client
 * Components). Nenhuma regra de segurança mora aqui; o backend decide.
 */

/** Ordem do funil (a mesma do enum lead_stage; um teste confere). */
export const STAGE_ORDER = [
  "NEW",
  "NO_ANSWER",
  "FOLLOW_UP_1",
  "FOLLOW_UP_2",
  "FOLLOW_UP_3",
  "NEGOTIATION",
  "CLOSED",
  "REWORK",
] as const satisfies readonly LeadStage[];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: "Em contato",
  NO_ANSWER: "Lead quente (ou potencial)",
  FOLLOW_UP_1: "FUP 1",
  FOLLOW_UP_2: "FUP 2",
  FOLLOW_UP_3: "FUP 3",
  NEGOTIATION: "Em Negociação",
  CLOSED: "Vendido",
  // Nova tentativa (redistribuição ou recuperação de Perdido): no Kanban fica na coluna "Em contato" (C59).
  REWORK: "Em contato (nova tentativa)",
};

/** Origem do lead, na ordem do enum lead_source (migration 015; um teste confere). */
export const SOURCE_LABELS: Record<LeadSource, string> = {
  PAID_TRAFFIC: "Tráfego pago",
  GOOGLE: "Google",
  REFERRAL: "Indicação",
  CALLBACK: "Rechamada",
  INTERNAL_TRANSFER: "Transferência interna",
  STUDENT: "Aluno",
  OTHER_CAMPAIGN: "Outras campanhas",
};

/** Ordem de exibição das origens (a mesma do enum; um teste confere). */
export const SOURCE_ORDER = Object.keys(SOURCE_LABELS) as LeadSource[];

/** Origem que exige o nome da campanha. */
export const SOURCE_WITH_DETAIL = "OTHER_CAMPAIGN" satisfies LeadSource;

/** Tamanho máximo do nome da campanha (CHECK leads_source_detail_consistent). */
export const SOURCE_DETAIL_MAX_LENGTH = 120;

/** Leads cadastrados antes da migration 015 não têm origem. */
export const SOURCE_UNKNOWN_LABEL = "Não informada";

/** "Google" ou "Outras campanhas: Feira 2026". */
export function sourceLabel(lead: { source: LeadSource | null; sourceDetail: string | null }): string {
  if (!lead.source) return SOURCE_UNKNOWN_LABEL;
  return lead.sourceDetail ? `${SOURCE_LABELS[lead.source]}: ${lead.sourceDetail}` : SOURCE_LABELS[lead.source];
}

/** Nome da coluna do Kanban que mostra os leads da Lixeira (C59: Perdido = Lixeira). */
export const LOST_COLUMN_LABEL = "Perdido";

/** Tamanhos de página aceitos pela listagem (o primeiro é o padrão). */
export const LEAD_PAGE_SIZES = [25, 50, 100] as const;
export type LeadPageSize = (typeof LEAD_PAGE_SIZES)[number];

export type LeadQueueReason = "UNASSIGNED";

export const QUEUE_REASON_LABELS: Record<LeadQueueReason, string> = {
  UNASSIGNED: "Sem responsável",
};

/** Etapas que o vendedor escolhe à mão no Kanban (C59: movimentação livre entre elas). */
const MANUAL_STAGES = ["NEW", "NO_ANSWER", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "NEGOTIATION"] as const satisfies readonly LeadStage[];

/**
 * Destinos permitidos para a movimentação MANUAL do vendedor. O serviço
 * moveLeadStage valida contra esta tabela.
 * - Livre entre as etapas do funil, inclusive voltar (C59).
 * - CLOSED (Vendido) só surge com uma venda; dele não se sai à mão.
 * - REWORK só surge por redistribuição ou recuperação (o banco exige); nunca é
 *   destino manual, e quem está nela pode ir para qualquer etapa do funil.
 */
const allExcept = (from: LeadStage): readonly LeadStage[] => MANUAL_STAGES.filter((to) => to !== from);

export const STAGE_TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  NEW: allExcept("NEW"),
  NO_ANSWER: allExcept("NO_ANSWER"),
  FOLLOW_UP_1: allExcept("FOLLOW_UP_1"),
  FOLLOW_UP_2: allExcept("FOLLOW_UP_2"),
  FOLLOW_UP_3: allExcept("FOLLOW_UP_3"),
  NEGOTIATION: allExcept("NEGOTIATION"),
  REWORK: MANUAL_STAGES,
  CLOSED: [],
};

/** Etapas com prazo (horas corridas a partir da entrada: BUSINESS_RULES). As demais não têm prazo. */
export const STAGES_WITH_DEADLINE: readonly LeadStage[] = ["FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "NEGOTIATION"];

export function canTransition(from: LeadStage, to: LeadStage): boolean {
  return STAGE_TRANSITIONS[from].includes(to);
}

/** Curso + instituição: diferencia a mesma graduação em faculdades diferentes. */
export function courseLabel(course: { name: string; institutionName: string }): string {
  return `${course.name} — ${course.institutionName}`;
}

/** Slug da etapa na URL ("follow-up-1") e volta. */
export function stageToSlug(stage: LeadStage): string {
  return stage.toLowerCase().replace(/_/g, "-");
}

export function stageFromSlug(slug: string | undefined): LeadStage | undefined {
  return STAGE_ORDER.find((stage) => stageToSlug(stage) === slug);
}

// ---------------------------------------------------------------------------
// Prazo da etapa
// ---------------------------------------------------------------------------

type DeadlineFields = { status: LeadStatus; ownerId: string | null; stage: LeadStage; stageDueAt: Date | null };

export type DeadlineInfo =
  | { kind: "none" }
  | { kind: "unassigned" }
  | { kind: "overdue"; dueAt: Date }
  | { kind: "due_today"; dueAt: Date }
  | { kind: "on_time"; dueAt: Date };

const dayKey = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_RULES.timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function sameBusinessDay(a: Date, b: Date): boolean {
  return dayKey.format(a) === dayKey.format(b);
}

/**
 * Situação do prazo calculada a partir de stage_due_at (nada é gravado quando
 * vence). Vencer o FUP 3 só muda a cor: o vendedor continua operando (C59).
 */
export function deadlineInfo(lead: DeadlineFields, now: Date): DeadlineInfo {
  if (lead.status !== "ACTIVE") return { kind: "none" };
  if (lead.ownerId === null) return { kind: "unassigned" };
  const dueAt = lead.stageDueAt;
  if (!dueAt) return { kind: "none" };
  if (dueAt < now) return { kind: "overdue", dueAt };
  return sameBusinessDay(dueAt, now) ? { kind: "due_today", dueAt } : { kind: "on_time", dueAt };
}

type FollowUpStage = keyof typeof BUSINESS_RULES.followUpDeadlineHours;

export type FollowUpAlert = "none" | (typeof BUSINESS_RULES.followUpAlertSteps)[FollowUpStage][number]["alert"];

function isFollowUpStage(stage: LeadStage): stage is FollowUpStage {
  return stage in BUSINESS_RULES.followUpDeadlineHours;
}

/** Horas de prazo da etapa (follow-ups e negociação); null nas etapas sem prazo. */
export function stageDeadlineHours(stage: LeadStage): number | null {
  if (isFollowUpStage(stage)) return BUSINESS_RULES.followUpDeadlineHours[stage];
  return stage === "NEGOTIATION" ? BUSINESS_RULES.negotiationDeadlineHours : null;
}

/** FUP 3 com prazo vencido: o supervisor pode redistribuir (novo ciclo), sem travar o vendedor. */
export function isFollowUp3Expired(lead: DeadlineFields, now: Date): boolean {
  return lead.status === "ACTIVE" && lead.stage === "FOLLOW_UP_3" && lead.stageDueAt !== null && lead.stageDueAt < now;
}

/**
 * Cor do card do Kanban nas etapas de follow-up (C59): faixas de
 * `followUpAlertSteps` pelas horas na etapa (FUP 1: vermelho após 24 h; FUP 2:
 * laranja após 24 h, vermelho após 48 h; FUP 3: amarelo após 24 h, laranja após
 * 48 h, vermelho após 72 h). Conta a partir do prazo gravado, que a
 * transferência de responsável não reinicia; prazo vencido é sempre vermelho.
 * Lead sem responsável, na Lixeira ou em outra etapa não muda de cor.
 */
export function followUpAlert(lead: DeadlineFields, now: Date): FollowUpAlert {
  if (!isFollowUpStage(lead.stage)) return "none";
  const info = deadlineInfo(lead, now);
  if (info.kind === "overdue") return "red";
  if (info.kind !== "due_today" && info.kind !== "on_time") return "none";
  const enteredAt = info.dueAt.getTime() - BUSINESS_RULES.followUpDeadlineHours[lead.stage] * 3_600_000;
  const hoursInStage = (now.getTime() - enteredAt) / 3_600_000;
  let alert: FollowUpAlert = "none";
  for (const step of BUSINESS_RULES.followUpAlertSteps[lead.stage]) {
    if (hoursInStage >= step.afterHours) alert = step.alert;
  }
  return alert;
}
