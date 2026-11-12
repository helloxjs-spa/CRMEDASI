import type { UserRole } from "@/server/db/schema";
import { ROLE_LABELS } from "./format";
import { monthTitle } from "./goals";
import { REPORT_LABELS, type ReportType } from "./reports";
import { formatBRL } from "./money";
import { formatFileSize } from "./receipts";
import { formatSaleDate } from "./sales";

/**
 * Texto de cada evento da auditoria, montado a partir do metadata gravado em
 * audit_events. `target` é quem ou o que foi afetado (nome resolvido pelo
 * serviço) e `saleId` permite abrir a venda ligada ao evento. Identificadores
 * internos não são exibidos.
 */
export type AuditEventText = { target: string | null; lines: string[]; saleId?: string };

type Change = { from?: unknown; to?: unknown };
type TeamSnapshot = { teamName?: string; supervisorName?: string | null } | null;

const FAILED_LOGIN_REASONS: Record<string, string> = {
  unknown_email: "E-mail não cadastrado",
  wrong_password: "Senha incorreta",
  inactive_user: "Usuário inativo",
};

const CHANGE_LABELS: Record<string, string> = {
  name: "Nome",
  email: "E-mail",
  institutionName: "Instituição",
  active: "Situação",
};

const text = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : String(value));
const money = (value: unknown) => (typeof value === "number" ? formatBRL(value) : "—");
const day = (value: unknown) => (typeof value === "string" ? formatSaleDate(value) : "—");

// O único booleano em `changes` é `active` de equipe.
const changeValue = (value: unknown) => (typeof value === "boolean" ? (value ? "Ativa" : "Inativa") : text(value));

function changeLines(changes: unknown): string[] {
  return Object.entries((changes ?? {}) as Record<string, Change>).map(
    ([key, change]) => `${CHANGE_LABELS[key] ?? key}: ${changeValue(change.from)} → ${changeValue(change.to)}`,
  );
}

function teamLabel(team: TeamSnapshot | undefined): string {
  if (!team) return "Sem equipe";
  return team.supervisorName ? `${text(team.teamName)} (supervisor: ${team.supervisorName})` : text(team.teamName);
}

const ipLine = (m: Record<string, unknown>) => (typeof m.ipAddress === "string" ? [`IP: ${m.ipAddress}`] : []);
const moneyChange = (label: string, m: Record<string, unknown>) => `${label}: ${money(m.fromCents)} → ${money(m.toCents)}`;

export function describeAuditEvent(event: { action: string; targetName?: string | null; metadata: Record<string, unknown> }): AuditEventText {
  const m = event.metadata;
  const target = event.targetName ?? null;
  const saleId = typeof m.saleId === "string" ? m.saleId : undefined;

  switch (event.action) {
    case "auth.login":
      return { target: null, lines: ipLine(m) };
    case "auth.login_failed":
      return {
        target: null,
        lines: [`E-mail: ${text(m.email)}`, `Motivo: ${FAILED_LOGIN_REASONS[String(m.reason)] ?? text(m.reason)}`, ...ipLine(m)],
      };
    case "auth.login_throttled":
      return { target: null, lines: [...(m.scope === "account" ? [`E-mail: ${text(m.email)}`] : []), ...ipLine(m)] };
    case "report.exported":
      return {
        target: REPORT_LABELS[m.reportType as ReportType]?.title ?? text(m.reportType),
        lines: [
          `Registros: ${text(m.rowCount)}`,
          ...Object.entries((m.filters ?? {}) as Record<string, unknown>).map(([key, value]) => `${key}: ${text(value)}`),
        ],
      };
    case "user.created":
      return { target, lines: [`E-mail: ${text(m.email)}`, `Perfil: ${ROLE_LABELS[m.role as UserRole] ?? text(m.role)}`] };
    case "user.updated":
    case "team.updated":
    case "course.updated":
      return { target, lines: changeLines(m.changes) };
    case "user.deactivated":
      return { target, lines: typeof m.unassignedLeads === "number" ? [`Leads devolvidos à fila do supervisor: ${m.unassignedLeads}`] : [] };
    case "user.team_changed":
      return {
        target,
        lines: [
          `De: ${teamLabel(m.from as TeamSnapshot)}`,
          `Para: ${teamLabel(m.to as TeamSnapshot)}`,
          ...(typeof m.movedLeads === "number" && m.movedLeads > 0 ? [`Leads movidos junto: ${m.movedLeads}`] : []),
        ],
      };
    case "user.role_changed":
      return {
        target,
        lines: [
          `Perfil: ${ROLE_LABELS[m.fromRole as UserRole] ?? text(m.fromRole)} → ${ROLE_LABELS[m.toRole as UserRole] ?? text(m.toRole)}`,
          ...(typeof m.fromTeamName === "string" ? [`Saiu da equipe: ${m.fromTeamName}`] : []),
          ...(typeof m.toTeamName === "string" ? [`Equipe: ${m.toTeamName}`] : []),
        ],
      };
    case "team.supervisor_changed":
      return { target, lines: [`Supervisor: ${text(m.fromSupervisorName ?? "Sem supervisor")} → ${text(m.toSupervisorName ?? "Sem supervisor")}`] };
    case "course.created":
      return { target, lines: [`Custo da bolsa: ${money(m.scholarshipCostCents)}`, `Comissão: ${money(m.commissionCents)}`] };
    case "course.cost_changed":
      return { target, lines: [moneyChange("Custo da bolsa", m)] };
    case "course.commission_changed":
      return { target, lines: [moneyChange("Comissão", m)] };
    case "certificate.created":
      return { target, saleId, lines: [`Conclusão: ${day(m.completedOn)}`, `Entrega: ${day(m.deliveredOn)}`, `Certificadora: ${text(m.certifier)}`] };
    case "sale.receipt_attached":
    case "sale.receipt_removed":
      return {
        target,
        saleId,
        lines: [
          `Comprovante: ${text(m.fileName)}`,
          `Tamanho: ${typeof m.sizeBytes === "number" ? formatFileSize(m.sizeBytes) : "—"}`,
          ...(event.action === "sale.receipt_attached" && m.replacedReceiptId ? ["Substituiu o comprovante anterior"] : []),
          ...(event.action === "sale.receipt_removed" ? [m.replaced ? "Trocado por um novo arquivo (o anterior foi apagado)" : "Arquivo apagado"] : []),
        ],
      };
    case "installment.paid":
      return { target, saleId, lines: [`Parcela ${text(m.number)}: ${money(m.amountCents)}`, `Vencimento: ${day(m.dueDate)}`] };
    case "goal.set":
      return {
        target: typeof m.sellerName === "string" ? m.sellerName : target,
        lines: [
          `Mês: ${typeof m.month === "string" ? monthTitle(m.month) : "—"}`,
          m.fromCents === null || m.fromCents === undefined ? `Meta: ${money(m.toCents)}` : moneyChange("Meta", m),
        ],
      };
    case "auth.logout":
    case "auth.reauth_failed":
    case "auth.password_changed":
    case "auth.admin_bootstrapped":
    case "user.activated":
    case "user.password_reset":
    case "team.created":
    case "course.activated":
    case "course.deactivated":
      return { target, lines: [] };
    default:
      // Evento sem texto próprio: o que foi gravado não pode sumir da tela.
      return { target, saleId, lines: Object.entries(m).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : text(value)}`) };
  }
}
