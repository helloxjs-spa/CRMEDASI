import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "@/server/db/connect";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import {
  createTeam,
  getMyTeam,
  getTeam,
  listAvailableSupervisors,
  listTeams,
  setTeamSupervisor,
  updateTeam,
} from "@/server/modules/teams/teams.service";
import { createTestDatabase, insertUser, seedOrganization } from "../support/db";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
});
afterAll(() => handle.close());

describe("escopo de equipes", () => {
  it("vendedor não acessa equipes", async () => {
    const ctx = await org.ctx(org.ids.sellerA1);
    await expect(listTeams(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTeam(ctx, org.ids.teamA)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("supervisor lista todas as equipes, com contagem de vendedores", async () => {
    const list = await listTeams(await org.ctx(org.ids.supA));
    expect(list.map((t) => t.id)).toEqual([org.ids.teamA, org.ids.teamB]);
    expect(list[0]).toMatchObject({ id: org.ids.teamA, supervisorName: "Supervisor A", sellerCount: 2 });
  });

  it("supervisor vê os membros de qualquer equipe, inclusive de outra", async () => {
    const ctx = await org.ctx(org.ids.supA);
    const team = await getTeam(ctx, org.ids.teamA);
    expect(team.members.map((m) => m.id).sort()).toEqual([org.ids.sellerA1, org.ids.sellerA2].sort());
    expect((await getTeam(ctx, org.ids.teamB)).members.map((m) => m.id)).toEqual([org.ids.sellerB1]);
  });

  it("supervisor gerencia equipes como o administrador", async () => {
    const ctx = await org.ctx(org.ids.supA);
    const supS = await insertUser(handle, { name: "Supervisor S", role: "SUPERVISOR" });
    const team = await createTeam(ctx, { name: "Equipe do Supervisor", supervisorId: supS });
    await updateTeam(ctx, team.id, { name: "Equipe do Supervisor 2" });
    await setTeamSupervisor(ctx, team.id, { supervisorId: null });
    expect(await getTeam(ctx, team.id)).toMatchObject({ name: "Equipe do Supervisor 2", supervisorId: null });
    await updateTeam(ctx, team.id, { active: false });
  });

  it("getMyTeam devolve apenas a equipe do próprio usuário, sem membros", async () => {
    const sellerTeam = await getMyTeam(await org.ctx(org.ids.sellerB1));
    expect(sellerTeam).toMatchObject({ id: org.ids.teamB, supervisorName: "Supervisor B" });
    expect(sellerTeam).not.toHaveProperty("members");
    expect(await getMyTeam(await org.ctx(org.ids.supA))).toMatchObject({ id: org.ids.teamA });
    expect(await getMyTeam(await org.ctx(org.ids.admin))).toBeNull();
  });

  it("administrador vê todas as equipes", async () => {
    const list = await listTeams(await org.ctx(org.ids.admin));
    expect(list.map((t) => t.name)).toEqual(["Equipe A", "Equipe B", "Equipe do Supervisor 2"]);
  });
});

describe("gestão de equipes (administrador)", () => {
  it("cria equipe com supervisor disponível", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const supC = await insertUser(handle, { name: "Supervisor C", role: "SUPERVISOR" });
    expect((await listAvailableSupervisors(ctx)).map((s) => s.id)).toContain(supC);

    const team = await createTeam(ctx, { name: "Equipe C", supervisorId: supC });
    expect(team).toMatchObject({ name: "Equipe C", supervisorId: supC, supervisorName: "Supervisor C" });
    expect((await listAvailableSupervisors(ctx)).map((s) => s.id)).not.toContain(supC);

    // O novo supervisor enxerga todas as equipes, inclusive a dele.
    const visible = await listTeams(await org.ctx(supC));
    expect(visible.map((t) => t.id)).toContain(team.id);
    expect(visible.map((t) => t.id)).toContain(org.ids.teamB);
  });

  it("nome de equipe é único sem diferenciar maiúsculas", async () => {
    await expect(createTeam(await org.ctx(org.ids.admin), { name: "equipe a" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("supervisor não pode liderar duas equipes", async () => {
    await expect(createTeam(await org.ctx(org.ids.admin), { name: "Equipe D", supervisorId: org.ids.supA })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("somente usuário SUPERVISOR pode ser supervisor", async () => {
    await expect(
      setTeamSupervisor(await org.ctx(org.ids.admin), org.ids.teamA, { supervisorId: org.ids.sellerA1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("supervisor continua vendo a equipe depois de deixar de liderá-la (escopo da empresa)", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const supE = await insertUser(handle, { name: "Supervisor E", role: "SUPERVISOR" });
    const team = await createTeam(ctx, { name: "Equipe E" });
    await setTeamSupervisor(ctx, team.id, { supervisorId: supE });
    await expect(getTeam(await org.ctx(supE), team.id)).resolves.toMatchObject({ id: team.id });

    await setTeamSupervisor(ctx, team.id, { supervisorId: null });
    await expect(getTeam(await org.ctx(supE), team.id)).resolves.toMatchObject({ id: team.id });
    expect((await listTeams(await org.ctx(supE))).map((t) => t.id)).toContain(team.id);
  });

  it("não inativa equipe com vendedores ativos", async () => {
    await expect(updateTeam(await org.ctx(org.ids.admin), org.ids.teamA, { active: false })).rejects.toBeInstanceOf(ConflictError);
  });

  it("criações simultâneas com o mesmo nome: apenas uma vence", async () => {
    const ctx = await org.ctx(org.ids.admin);
    const results = await Promise.allSettled([createTeam(ctx, { name: "Concorrente" }), createTeam(ctx, { name: "CONCORRENTE" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });

  it("rejeita campos não previstos (mass assignment)", async () => {
    await expect(
      updateTeam(await org.ctx(org.ids.admin), org.ids.teamA, { name: "X Y", supervisorId: org.ids.supB }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
