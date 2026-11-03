import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/dashboard";
import { monthTitle, shiftMonth } from "@/lib/goals";
import { formatBRL } from "@/lib/money";
import type { ServiceContext } from "@/server/context";
import { getMonthlyGoals, type MonthlyGoals, type SellerGoalRow } from "@/server/modules/goals/goals.service";
import { SellerGoalDialog } from "./goal-dialog";

/**
 * Card "Resultado do mês": faturamento realizado, meta (soma das metas dos
 * vendedores) e ritmo do time inteiro, seguido de uma linha por vendedor.
 * Todos os perfis veem todos os vendedores; só quem pode recebe "Definir meta".
 */
export async function GoalsCard({ ctx, month }: { ctx: ServiceContext; month: string }) {
  const goals = await getMonthlyGoals(ctx, { month });
  const title = monthTitle(month);

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Resultado do mês</h2>
          <p className="text-sm text-slate-500">Time inteiro</p>
        </div>
        <nav aria-label="Mês do resultado" className="flex items-center gap-1 rounded-xl px-1 py-1 ring-1 ring-slate-200">
          <MonthLink month={shiftMonth(month, -1)} label="Mês anterior" icon={ChevronLeft} />
          <span className="min-w-40 text-center text-sm font-semibold text-slate-900">{title}</span>
          <MonthLink month={shiftMonth(month, 1)} label="Próximo mês" icon={ChevronRight} />
        </nav>
      </div>

      <div className="mt-6 grid gap-6 border-b border-slate-200 pb-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-slate-200">
        <div className="md:pr-6">
          <p className="text-sm text-slate-500">Realizado</p>
          <p className="mt-2 text-4xl font-bold tracking-tight text-slate-900">{formatBRL(goals.realizedCents)}</p>
          <Change value={goals.changeVsPrevious} />
        </div>
        <div className="md:px-6">
          <p className="text-sm text-slate-500">Meta</p>
          {goals.goalCents === null ? (
            <p className="mt-2 text-sm text-slate-600">Sem meta definida para o mês.</p>
          ) : (
            <>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatBRL(goals.goalCents)}</p>
              <p className="mt-1 text-sm text-slate-600">{formatPercent(goals.progress)} atingido · soma das metas dos vendedores</p>
            </>
          )}
        </div>
        <div className="md:pl-6">
          <p className="text-sm text-slate-500">Ritmo</p>
          <p className="mt-2 text-sm text-slate-700">
            <Pace goals={goals} />
          </p>
        </div>
      </div>

      {goals.sellers.length === 0 ? (
        <p className="pt-6 text-sm text-slate-500">Nenhum vendedor cadastrado.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {goals.sellers.map((seller) => (
            <SellerRow key={seller.sellerId} seller={seller} month={month} monthTitle={title} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function MonthLink({ month, label, icon: Icon }: { month: string; label: string; icon: typeof ChevronLeft }) {
  return (
    <Link href={`/?mes=${month}`} aria-label={label} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900">
      <Icon className="size-4" aria-hidden />
    </Link>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <p className="mt-1 text-sm text-slate-400">Sem base de comparação com o mês anterior</p>;
  const Icon = value >= 0 ? ArrowUp : ArrowDown;
  return (
    <p className={cn("mt-1 flex items-center gap-1 text-sm", value >= 0 ? "text-emerald-700" : "text-red-600")}>
      <Icon className="size-4" aria-hidden />
      {formatPercent(Math.abs(value))} vs mês anterior
    </p>
  );
}

function Pace({ goals }: { goals: MonthlyGoals }) {
  if (goals.state === "future" || goals.projectedCents === null) return <>O mês ainda não começou.</>;
  const ofGoal = goals.goalCents ? ` (${formatPercent((goals.projectedCents / goals.goalCents) * 100)} da meta)` : "";
  if (goals.state === "past") {
    return (
      <>
        O mês fechou em <strong className="font-semibold text-slate-900">{formatBRL(goals.projectedCents)}</strong>
        {ofGoal}.
      </>
    );
  }
  return (
    <>
      No ritmo atual, o mês fecha em <strong className="font-semibold text-slate-900">{formatBRL(goals.projectedCents)}</strong>
      {ofGoal}.
    </>
  );
}

function SellerRow({ seller, month, monthTitle }: { seller: SellerGoalRow; month: string; monthTitle: string }) {
  const reached = seller.progress !== null && seller.progress >= 100;
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-slate-900">{seller.name}</span>
          {seller.teamName && <span className="text-xs uppercase tracking-wide text-slate-500">{seller.teamName}</span>}
          {!seller.active && <span className="text-xs text-slate-400">(inativo)</span>}
        </p>
        {seller.canEdit && (
          <SellerGoalDialog sellerId={seller.sellerId} sellerName={seller.name} month={month} monthTitle={monthTitle} goalCents={seller.goalCents} />
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-base font-semibold tabular-nums text-slate-900">{formatBRL(seller.realizedCents)}</span>
        <span className="text-sm text-slate-500">
          {seller.goalCents === null ? "Sem meta definida" : `${formatPercent(seller.progress)} de ${formatBRL(seller.goalCents)}`}
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label={`Meta de ${seller.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(seller.progress ?? 0))}
      >
        <div
          className={cn("h-full rounded-full", reached ? "bg-emerald-500" : "bg-brand-700")}
          style={{ width: `${Math.min(100, seller.progress ?? 0)}%` }}
        />
      </div>
    </li>
  );
}
