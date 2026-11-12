import type { Metadata } from "next";
import { Suspense } from "react";
import { Drawer } from "@/components/ui/drawer";
import { PageHeader } from "@/components/ui/page-header";
import { courseLabel, LOST_COLUMN_LABEL, STAGE_LABELS } from "@/lib/leads";
import { formatPhone } from "@/lib/phone";
import { hasPermission } from "@/server/authz/permissions";
import { hasCompanyScope } from "@/server/authz/scope";
import type { LeadStage } from "@/server/db/schema";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import { getNegotiationBlock, listLeads, listLeadSellers } from "@/server/modules/leads/leads.service";
import { listTeams } from "@/server/modules/teams/teams.service";
import { requireServiceContext } from "@/server/next/session";
import { LeadActionsProvider } from "../leads/lead-actions";
import { LeadDetail, LeadDetailSkeleton } from "../leads/lead-detail";
import { actionTarget } from "../leads/leads-results";
import { LeadsToolbar, type ToolbarOptions } from "../leads/leads-toolbar";
import { NegotiationBanner } from "../leads/negotiation-banner";
import { leadActionsFor, moveTargetsFor } from "../leads/policy";
import { boardParams, leadsHref, parseLeadsParams, type LeadsParams } from "../leads/search-params";
import { KanbanBoard, type KanbanCard, type KanbanColumn } from "./kanban-board";

export const metadata: Metadata = { title: "Kanban" };

type BoardColumn = {
  key: string;
  /** Etapa que recebe o card ao soltar; null = coluna que não aceita arrastar. */
  stage: LeadStage | null;
  title: string;
  hint?: string;
  filters: { status: "ACTIVE" | "TRASHED"; stage?: LeadStage; stages?: LeadStage[] };
};

/**
 * Colunas do quadro (C59). "Em contato" inclui REWORK (nova tentativa após
 * redistribuição ou recuperação de Perdido).
 * Perdido = leads na Lixeira (só SUPERVISOR/ADMIN os veem e marcam). Vendido
 * só recebe leads pelo registro de venda: nenhuma transição de etapa leva a ele.
 */
const BOARD_COLUMNS: BoardColumn[] = [
  { key: "NEW", stage: "NEW", title: STAGE_LABELS.NEW, filters: { status: "ACTIVE", stages: ["NEW", "REWORK"] } },
  ...(["NO_ANSWER", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "NEGOTIATION"] as const).map(
    (stage): BoardColumn => ({ key: stage, stage, title: STAGE_LABELS[stage], filters: { status: "ACTIVE", stage } }),
  ),
  { key: "LOST", stage: null, title: LOST_COLUMN_LABEL, hint: "Lixeira: marcado pelo supervisor", filters: { status: "TRASHED" } },
  { key: "CLOSED", stage: null, title: STAGE_LABELS.CLOSED, hint: "Entra pelo registro de venda", filters: { status: "ACTIVE", stage: "CLOSED" } },
];
/** Cards por coluna; o total aparece no cabeçalho e o restante fica na lista. */
const CARDS_PER_COLUMN = 50;

export default async function KanbanPage({ searchParams }: PageProps<"/kanban">) {
  const ctx = await requireServiceContext();
  const { actor } = ctx;
  const canManage = hasPermission(actor, "leads:transfer");
  const allTeams = hasCompanyScope(actor);
  const canSell = hasPermission(actor, "sales:create");

  const raw = parseLeadsParams(await searchParams);
  const params: LeadsParams = boardParams(raw, canManage);

  const [courses, sellers, teams, block, ...pages] = await Promise.all([
    listCourseFilterOptions(ctx),
    canManage ? listLeadSellers(ctx) : Promise.resolve([]),
    allTeams ? listTeams(ctx) : Promise.resolve([]),
    getNegotiationBlock(ctx),
    ...BOARD_COLUMNS.map(({ filters }) =>
      listLeads(ctx, {
        ...filters,
        search: params.q,
        courseId: params.course,
        ownerId: canManage ? params.seller : undefined,
        teamId: allTeams ? params.team : undefined,
        pageSize: CARDS_PER_COLUMN,
        order: filters.status === "ACTIVE" ? "deadline" : undefined,
      }),
    ),
  ]);
  const situation = { negotiationBlocked: (block?.count ?? 0) > 0 };
  const now = new Date();

  const columns: KanbanColumn[] = BOARD_COLUMNS.map((column, i) => ({
    key: column.key,
    stage: column.stage,
    title: column.title,
    hint: column.hint,
    emptyText:
      column.key === "LOST" && !canManage
        ? "O supervisor marca e acompanha os leads perdidos"
        : column.key === "CLOSED"
          ? "Nenhum lead vendido"
          : "Nenhum lead",
    total: pages[i].total,
    listHref:
      column.filters.status === "TRASHED"
        ? leadsHref(params, { view: "lixeira", lead: undefined })
        : leadsHref(params, { stage: column.filters.stage, lead: undefined }),
    cards: pages[i].items.map(
      (lead): KanbanCard => ({
        id: lead.id,
        name: lead.name,
        phone: formatPhone(lead.phone),
        course: courseLabel({ name: lead.interestCourseName, institutionName: lead.interestCourseInstitution }),
        ownerName: canManage ? (lead.ownerName ?? "Sem responsável") : null,
        teamName: allTeams ? lead.teamName : null,
        stage: lead.stage,
        status: lead.status,
        ownerId: lead.ownerId,
        stageDueAt: lead.stageDueAt?.toISOString() ?? null,
        href: leadsHref(params, { lead: lead.id }, "/kanban"),
        targets: moveTargetsFor(lead, actor, situation, now),
        adminActions: leadActionsFor(lead, actor, situation, now),
        actionTarget: actionTarget(lead),
        saleHref: canSell && lead.status === "ACTIVE" ? `/vendas/nova?lead=${lead.id}` : null,
      }),
    ),
  }));

  const toolbarOptions: ToolbarOptions = {
    stages: false,
    courses: courses.map((c) => ({ id: c.id, label: `${courseLabel(c)}${c.active ? "" : " (inativo)"}` })),
    sellers: canManage
      ? sellers.map((s) => ({ id: s.id, label: `${s.name}${allTeams && s.teamName ? ` — ${s.teamName}` : ""}${s.active ? "" : " (inativo)"}` }))
      : undefined,
    teams: allTeams ? teams.map((t) => ({ id: t.id, label: `${t.name}${t.active ? "" : " (inativa)"}` })) : undefined,
  };

  return (
    <LeadActionsProvider sellers={sellers} groupByTeam={allTeams}>
      <PageHeader
        title="Kanban"
        description={
          hasPermission(actor, "leads:move")
            ? "Arraste o card para qualquer etapa. Vendido entra pelo registro de venda; Perdido é marcado pelo supervisor."
            : "Acompanhe o funil da equipe. A movimentação de etapas é feita pelo vendedor responsável."
        }
      />
      <NegotiationBanner block={block} openHref={(id) => leadsHref(params, { lead: id }, "/kanban")} />
      <LeadsToolbar params={params} options={toolbarOptions} basePath="/kanban" />

      <KanbanBoard columns={columns} now={now.toISOString()} canMove={hasPermission(actor, "leads:move")} />

      {params.lead && (
        <Drawer closeHref={leadsHref(params, { lead: undefined }, "/kanban")} label="Detalhes do lead">
          <Suspense key={params.lead} fallback={<LeadDetailSkeleton />}>
            <LeadDetail ctx={ctx} id={params.lead} courses={courses} situation={situation} />
          </Suspense>
        </Drawer>
      )}
    </LeadActionsProvider>
  );
}
