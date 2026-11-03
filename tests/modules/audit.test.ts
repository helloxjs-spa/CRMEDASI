import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents } from "@/server/db/schema";
import { ForbiddenError, ValidationError } from "@/server/errors";
import { listAuditEvents, recordAudit, type AuditAction } from "@/server/modules/audit/audit.service";
import { createCourse } from "@/server/modules/courses/courses.service";
import { orNotFound } from "@/server/next/page";
import { createTestDatabase, seedOrganization } from "../support/db";

// notFound() do Next lança um erro próprio; aqui ele é identificável.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  for (let i = 0; i < 3; i++) await recordAudit(handle.db, { actorId: org.ids.admin, action: "user.updated", entityType: "user" });
});
afterAll(() => handle.close());

describe("listAuditEvents: entrada validada", () => {
  it("sem filtros e com beforeId válido (paginação por id)", async () => {
    const admin = await org.ctx(org.ids.admin);
    const all = await listAuditEvents(admin);
    expect(all.length).toBeGreaterThanOrEqual(3);
    const older = await listAuditEvents(admin, { beforeId: all[0].id });
    expect(older.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));
    expect(await listAuditEvents(admin, { beforeId: Number.MAX_SAFE_INTEGER })).toHaveLength(all.length);
    expect(await listAuditEvents(admin, { entityType: "user" })).not.toHaveLength(0);
  });

  it("beforeId inválido, não inteiro, não positivo ou fora do intervalo seguro e campos extras são recusados", async () => {
    const admin = await org.ctx(org.ids.admin);
    for (const filters of [
      { beforeId: 0 },
      { beforeId: -5 },
      { beforeId: 1.5 },
      { beforeId: Number.NaN },
      { beforeId: Number.MAX_SAFE_INTEGER + 1 },
      { beforeId: 1e20 },
      { beforeId: "12" },
      { entityType: "lead" },
      { actorId: "nao-e-uuid" },
      { action: "nao.existe" },
      { from: "2026-13-45" },
      { to: "ontem" },
      { campoExtra: 1 },
    ]) {
      await expect(listAuditEvents(admin, filters)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("filtra por usuário e ação", async () => {
    const admin = await org.ctx(org.ids.admin);
    await recordAudit(handle.db, { actorId: org.ids.supA, action: "auth.logout", entityType: "session" });
    const bySupervisor = await listAuditEvents(admin, { actorId: org.ids.supA });
    expect(bySupervisor.length).toBeGreaterThan(0);
    expect(bySupervisor.every((e) => e.actorName === "Supervisor A")).toBe(true);
    const byAction = await listAuditEvents(admin, { action: "auth.logout" });
    expect(byAction.length).toBeGreaterThan(0);
    expect(byAction.every((e) => e.action === "auth.logout")).toBe(true);
    expect(await listAuditEvents(admin, { actorId: org.ids.sellerB1, action: "auth.logout" })).toHaveLength(0);
  });

  it("período usa o dia no fuso do negócio, inclusive nas duas pontas", async () => {
    const admin = await org.ctx(org.ids.admin);
    // 02:30 UTC do dia 10 ainda é 23:30 do dia 9 em São Paulo.
    const [event] = await handle.db
      .insert(auditEvents)
      .values({ actorId: org.ids.admin, action: "team.created", entityType: "team", occurredAt: new Date("2020-03-10T02:30:00Z") })
      .returning({ id: auditEvents.id });
    const ids = async (filters: object) => (await listAuditEvents(admin, { action: "team.created", ...filters })).map((e) => e.id);
    expect(await ids({ from: "2020-03-09", to: "2020-03-09" })).toContain(event.id);
    expect(await ids({ from: "2020-03-10", to: "2020-03-10" })).not.toContain(event.id);
    expect(await ids({ to: "2020-03-08" })).not.toContain(event.id);
  });

  it("paginação mantém os filtros", async () => {
    const admin = await org.ctx(org.ids.admin);
    const all = await listAuditEvents(admin, { action: "user.updated" });
    const older = await listAuditEvents(admin, { action: "user.updated", beforeId: all[0].id });
    expect(older.map((e) => e.id)).toEqual(all.slice(1).map((e) => e.id));
  });

  it("resolve o nome de quem ou do que foi afetado, sem duplicar eventos", async () => {
    const admin = await org.ctx(org.ids.admin);
    const course = await createCourse(admin, { name: "Enfermagem", institutionName: "Inst", scholarshipCostCents: 1000, commissionCents: 500 });
    await recordAudit(handle.db, { actorId: org.ids.admin, action: "user.password_reset", entityType: "user", entityId: org.ids.sellerA1 });
    await recordAudit(handle.db, { actorId: org.ids.admin, action: "team.updated", entityType: "team", entityId: org.ids.teamA });
    await recordAudit(handle.db, {
      actorId: org.ids.admin,
      action: "certificate.created",
      entityType: "certificate",
      entityId: "33333333-3333-4333-8333-333333333333",
      metadata: { courseId: course.id },
    });
    await recordAudit(handle.db, { actorId: org.ids.admin, action: "auth.login", entityType: "session", entityId: org.ids.admin });

    const nameOf = async (action: AuditAction) => (await listAuditEvents(admin, { action }))[0].targetName;
    expect(await nameOf("user.password_reset")).toBe("Vendedor A1");
    expect(await nameOf("team.updated")).toBe("Equipe A");
    expect(await nameOf("course.created")).toBe("Enfermagem — Inst");
    expect(await nameOf("certificate.created")).toBe("Enfermagem — Inst");
    expect(await nameOf("auth.login")).toBeNull();

    const events = await listAuditEvents(admin);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("na página, entrada inválida vira 404 (não 500); sem permissão também", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(orNotFound(listAuditEvents(admin, { beforeId: Number("99999999999999999999") }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(orNotFound(listAuditEvents(admin, { beforeId: Number("abc") }))).rejects.toThrow("NEXT_NOT_FOUND");
    const supervisor = await org.ctx(org.ids.supA);
    await expect(listAuditEvents(supervisor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(orNotFound(listAuditEvents(supervisor))).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
