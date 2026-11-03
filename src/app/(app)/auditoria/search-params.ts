import { AUDIT_ACTIONS, type AuditAction } from "@/server/modules/audit/audit.service";

/**
 * Filtros da auditoria na URL. Valores inválidos são ignorados; o serviço
 * valida de novo. `antes` é o cursor da paginação e fica de fora: o serviço o
 * recusa quando inválido e a página responde 404.
 */
export type AuditParams = {
  user?: string;
  action?: AuditAction;
  from?: string;
  to?: string;
};

type RawParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function first(raw: RawParams, key: string): string | undefined {
  const value = raw[key];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || undefined;
}

function date(raw: RawParams, key: string): string | undefined {
  const value = first(raw, key);
  return value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

export function parseAuditParams(raw: RawParams): AuditParams {
  const user = first(raw, "usuario");
  const action = first(raw, "acao");
  return {
    user: user && UUID.test(user) ? user : undefined,
    action: action && Object.hasOwn(AUDIT_ACTIONS, action) ? (action as AuditAction) : undefined,
    from: date(raw, "de"),
    to: date(raw, "ate"),
  };
}

export function auditHref(params: AuditParams, before?: number): string {
  const query = new URLSearchParams();
  if (params.user) query.set("usuario", params.user);
  if (params.action) query.set("acao", params.action);
  if (params.from) query.set("de", params.from);
  if (params.to) query.set("ate", params.to);
  if (before !== undefined) query.set("antes", String(before));
  const text = query.toString();
  return text ? `/auditoria?${text}` : "/auditoria";
}

export function hasAuditFilters(p: AuditParams): boolean {
  return !!(p.user || p.action || p.from || p.to);
}
