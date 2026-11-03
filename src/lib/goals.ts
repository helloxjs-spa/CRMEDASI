/**
 * Card "Resultado do mês" (metas): regras puras usadas pelo serviço e pela tela.
 * Meses no formato "AAAA-MM"; datas "AAAA-MM-DD" no fuso do negócio.
 */

import { lastMonths } from "./dashboard";
import { monthRange, periodLabel } from "./ranking";

/** "2026-11" + 1 → "2026-12"; "2026-01" − 1 → "2025-12". */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Mês anterior ("AAAA-MM"). */
export function previousMonth(month: string): string {
  return lastMonths(month, 2)[0];
}

/** "2026-11" → "Novembro de 2026". */
export function monthTitle(month: string): string {
  const label = periodLabel({ kind: "month", month });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "2026-11" → "2026-11-01" (coluna `seller_goals.month`). */
export function monthStart(month: string): string {
  return `${month}-01`;
}

export type MonthState = "past" | "current" | "future";

/** Situação do mês em relação a `today` ("AAAA-MM-DD"). */
export function monthState(month: string, today: string): MonthState {
  const current = today.slice(0, 7);
  return month < current ? "past" : month > current ? "future" : "current";
}

/**
 * Ritmo: faturamento projetado para o fim do mês, mantendo a média diária até
 * hoje (dias corridos). Mês encerrado → o próprio realizado; futuro → null.
 */
export function projectedMonthCents(realizedCents: number, month: string, today: string): number | null {
  const state = monthState(month, today);
  if (state === "future") return null;
  if (state === "past") return realizedCents;
  const elapsedDays = Number(today.slice(8, 10));
  const daysInMonth = Number(monthRange(month).to.slice(8, 10));
  return Math.round((realizedCents / elapsedDays) * daysInMonth);
}

/** Percentual da meta atingido (sem teto: pode passar de 100%); sem meta → null. */
export function goalProgress(realizedCents: number, goalCents: number | null): number | null {
  return goalCents && goalCents > 0 ? (realizedCents / goalCents) * 100 : null;
}
