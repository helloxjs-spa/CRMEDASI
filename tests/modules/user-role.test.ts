import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { auditEvents, users } from "@/server/db/schema";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { createLead } from "@/server/modules/leads/leads.service";
import { setTeamSupervisor } from "@/server/modules/teams/teams.service";
import {
  changeUserRole,
  SELF_ROLE_CHANGE_FORBIDDEN,
  SELLER_HAS_HISTORY,
  supervisorLeadsTeam,
} from "@/server/modules/users/users.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";
import { insertCourse } from "../support/leads";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let courseId: string;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  courseId = await insertCourse(handle, "Pedagogia");
});
afterAll(() => handle.close());

const rowOf = async (id: string) => (await handle.db.select().from(users).where(eq(users.id, id)))[0];
const adminCtx = () => org.ctx(org.ids.admin);

describe("alterar perfil", () => {
  it("só o ADMIN altera perfil", async () => {
    const target = await insertUser(handle, { name: "Alvo Permissao", role: "SUPERVISOR" });
    for (const actorId of [org.ids.supA, org.ids.sellerA1]) {
      await expect(changeUserRole(await org.ctx(actorId), target, { role: "ADMIN" })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect((await rowOf(target)).role).toBe("SUPERVISOR");
  });

  it("promove supervisor sem equipe a ADMIN e audita", async () => {
    const target = await insertUser(handle, { name: "Supervisor Livre", role: "SUPERVISOR" });
    await changeUserRole(await adminCtx(), target, { role: "ADMIN" });
    expect((await rowOf(target)).role).toBe("ADMIN");

    const [event] = await handle.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "user.role_changed"), eq(auditEvents.entityId, target)));
    expect(event).toMatchObject({ actorId: org.ids.admin, metadata: { fromRole: "SUPERVISOR", toRole: "ADMIN" } });

    // O ator é recarregado do banco: o novo ADMIN já tem as permissões dele.
    const promoted = await org.ctx(target);
    expect(promoted.actor.role).toBe("ADMIN");
  });

  it("rebaixa ADMIN e transforma em vendedor de uma equipe", async () => {
    const target = await insertUser(handle, { name: "Admin Temporario", role: "ADMIN" });
    await changeUserRole(await adminCtx(), target, { role: "SELLER", teamId: org.ids.teamB });
    expect(await rowOf(target)).toMatchObject({ role: "SELLER", teamId: org.ids.teamB });
  });

  it("não altera o próprio perfil", async () => {
    await expect(changeUserRole(await adminCtx(), org.ids.admin, { role: "SELLER" })).rejects.toThrow(
      SELF_ROLE_CHANGE_FORBIDDEN,
    );
  });

  it("supervisor que lidera equipe só muda depois de trocar o supervisor da equipe", async () => {
    await expect(changeUserRole(await adminCtx(), org.ids.supB, { role: "ADMIN" })).rejects.toThrow(
      supervisorLeadsTeam("Equipe B"),
    );
    // O banco recusa mesmo sem passar pelo serviço.
    await expect(handle.db.update(users).set({ role: "ADMIN" }).where(eq(users.id, org.ids.supB))).rejects.toThrow();

    await setTeamSupervisor(await adminCtx(), org.ids.teamB, { supervisorId: null });
    await changeUserRole(await adminCtx(), org.ids.supB, { role: "ADMIN" });
    expect((await rowOf(org.ids.supB)).role).toBe("ADMIN");
  });

  it("vendedor sem histórico muda de perfil e sai da equipe", async () => {
    const target = await insertUser(handle, { name: "Vendedor Novo", role: "SELLER", teamId: org.ids.teamA });
    await changeUserRole(await adminCtx(), target, { role: "SUPERVISOR" });
    expect(await rowOf(target)).toMatchObject({ role: "SUPERVISOR", teamId: null });
  });

  it("vendedor com leads não muda de perfil (serviço e banco)", async () => {
    await createLead(await org.ctx(org.ids.sellerA2), { name: "Cliente Perfil", phone: "(79) 98765-4321", source: "GOOGLE", interestCourseId: courseId });
    const error = await changeUserRole(await adminCtx(), org.ids.sellerA2, { role: "SUPERVISOR" }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toBe(SELLER_HAS_HISTORY);
    await expect(handle.db.update(users).set({ role: "ADMIN", teamId: null }).where(eq(users.id, org.ids.sellerA2))).rejects.toThrow();
    expect(await rowOf(org.ids.sellerA2)).toMatchObject({ role: "SELLER", teamId: org.ids.teamA });
  });

  it("equipe só para quem vira vendedor, e precisa estar ativa", async () => {
    const target = await insertUser(handle, { name: "Supervisor Equipe", role: "SUPERVISOR" });
    await expect(
      changeUserRole(await adminCtx(), target, { role: "ADMIN", teamId: org.ids.teamA }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await rowOf(target)).role).toBe("SUPERVISOR");
  });

  it("rejeita campos não previstos", async () => {
    const target = await insertUser(handle, { name: "Alvo Extra", role: "SUPERVISOR" });
    await expect(
      changeUserRole(await adminCtx(), target, { role: "ADMIN", active: false }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
