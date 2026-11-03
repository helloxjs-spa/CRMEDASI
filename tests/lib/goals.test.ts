import { describe, expect, it } from "vitest";
import { goalProgress, monthState, monthTitle, previousMonth, projectedMonthCents, shiftMonth } from "@/lib/goals";

describe("meses", () => {
  it("navega entre meses, inclusive na virada do ano", () => {
    expect(shiftMonth("2026-11", 1)).toBe("2026-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });

  it("título com inicial maiúscula", () => {
    expect(monthTitle("2026-11")).toBe("Novembro de 2026");
    expect(monthTitle("2026-03")).toBe("Março de 2026");
  });

  it("situação do mês em relação a hoje", () => {
    expect(monthState("2026-10", "2026-11-02")).toBe("past");
    expect(monthState("2026-11", "2026-11-02")).toBe("current");
    expect(monthState("2026-12", "2026-11-02")).toBe("future");
  });
});

describe("ritmo", () => {
  it("mês atual: média diária até hoje × dias do mês", () => {
    // 10 de novembro (30 dias): R$ 1.000 → R$ 3.000.
    expect(projectedMonthCents(100_000, "2026-11", "2026-11-10")).toBe(300_000);
    expect(projectedMonthCents(0, "2026-11", "2026-11-10")).toBe(0);
  });

  it("mês encerrado: o próprio realizado; mês futuro: sem projeção", () => {
    expect(projectedMonthCents(123_45, "2026-10", "2026-11-02")).toBe(123_45);
    expect(projectedMonthCents(0, "2026-12", "2026-11-02")).toBeNull();
  });
});

describe("progresso da meta", () => {
  it("percentual sem teto; sem meta → null", () => {
    expect(goalProgress(50_000, 100_000)).toBe(50);
    expect(goalProgress(150_000, 100_000)).toBe(150);
    expect(goalProgress(50_000, null)).toBeNull();
  });
});
