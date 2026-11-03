import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Table, Tbody, Td, Th } from "@/components/ui/table";
import { describeAuditEvent } from "@/lib/audit-history";
import { formatDateTime } from "@/lib/format";
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE, listAuditEvents, type AuditAction } from "@/server/modules/audit/audit.service";
import { listUsers } from "@/server/modules/users/users.service";
import { orNotFound } from "@/server/next/page";
import { requireServiceContext } from "@/server/next/session";
import { auditHref, hasAuditFilters, parseAuditParams } from "./search-params";

export const metadata: Metadata = { title: "Auditoria" };

export default async function AuditPage({ searchParams }: PageProps<"/auditoria">) {
  const ctx = await requireServiceContext();
  const rawParams = await searchParams;
  const params = parseAuditParams(rawParams);
  // O serviço valida a paginação: valor inválido (texto, não inteiro, ≤ 0, fora do intervalo seguro) → 404.
  const { antes } = rawParams;
  const raw = Array.isArray(antes) ? antes[0] : antes;
  const beforeId = raw === undefined ? undefined : Number(raw);
  const events = await orNotFound(
    listAuditEvents(ctx, {
      actorId: params.user,
      action: params.action,
      from: params.from,
      to: params.to,
      ...(beforeId === undefined ? {} : { beforeId }),
    }),
  );
  const users = await listUsers(ctx);
  const last = events.at(-1);

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Registro imutável de ações administrativas e de segurança. Mais recentes primeiro. O histórico de leads e vendas fica na tela de cada um."
      />

      <Card className="mb-4 p-4">
        <form action="/auditoria" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="search" aria-label="Filtrar auditoria">
          <FilterField label="Usuário" htmlFor="audit-user">
            <Select id="audit-user" name="usuario" defaultValue={params.user ?? ""}>
              <option value="">Todos</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                  {user.active ? "" : " (inativo)"}
                </option>
              ))}
            </Select>
          </FilterField>
          <FilterField label="Ação" htmlFor="audit-action">
            <Select id="audit-action" name="acao" defaultValue={params.action ?? ""}>
              <option value="">Todas</option>
              {Object.entries(AUDIT_ACTIONS).map(([action, label]) => (
                <option key={action} value={action}>
                  {label}
                </option>
              ))}
            </Select>
          </FilterField>
          <div className="grid grid-cols-2 gap-2">
            <FilterField label="De" htmlFor="audit-from">
              <Input id="audit-from" name="de" type="date" defaultValue={params.from} />
            </FilterField>
            <FilterField label="Até" htmlFor="audit-to">
              <Input id="audit-to" name="ate" type="date" defaultValue={params.to} />
            </FilterField>
          </div>
          <div className="flex items-end gap-2">
            <button type="submit" className={buttonClasses()}>
              Filtrar
            </button>
            {hasAuditFilters(params) && (
              <Link href="/auditoria" className="inline-flex h-10 items-center px-2 text-sm text-slate-600 hover:text-slate-900">
                Limpar filtros
              </Link>
            )}
          </div>
        </form>
      </Card>

      <Card>
        {events.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={hasAuditFilters(params) ? "Nenhum evento encontrado" : "Nenhum evento registrado"}
            description={hasAuditFilters(params) ? "Ajuste ou limpe os filtros para ver outros eventos." : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Data/hora</Th>
                <Th>Usuário</Th>
                <Th>Ação</Th>
                <Th>Detalhes</Th>
              </tr>
            </thead>
            <Tbody>
              {events.map((event) => {
                const details = describeAuditEvent(event);
                const empty = !details.target && details.lines.length === 0 && !details.saleId;
                return (
                  <tr key={event.id}>
                    <Td className="align-top tabular-nums">{formatDateTime(event.occurredAt)}</Td>
                    <Td className="align-top">{event.actorName ?? <span className="text-slate-400">—</span>}</Td>
                    <Td className="align-top font-medium text-slate-900">{AUDIT_ACTIONS[event.action as AuditAction] ?? event.action}</Td>
                    <Td className="min-w-64 max-w-md whitespace-normal align-top break-words">
                      {empty && <span className="text-slate-400">—</span>}
                      {details.target && <p className="font-medium text-slate-800">{details.target}</p>}
                      {details.lines.map((line, index) => (
                        <p key={index} className="text-slate-500">
                          {line}
                        </p>
                      ))}
                      {details.saleId && (
                        <Link href={`/vendas/${details.saleId}`} className="text-brand-700 hover:underline">
                          Ver venda
                        </Link>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Card>
      <div className="mt-4 flex justify-end gap-4 text-sm">
        {beforeId && (
          <Link href={auditHref(params)} className="text-slate-500 hover:text-slate-800">
            Mais recentes
          </Link>
        )}
        {last && events.length === AUDIT_PAGE_SIZE && (
          <Link href={auditHref(params, last.id)} className="font-medium text-brand-700 hover:underline">
            Eventos anteriores →
          </Link>
        )}
      </div>
    </>
  );
}

function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-slate-600">
        {label}
      </label>
      {children}
    </div>
  );
}
