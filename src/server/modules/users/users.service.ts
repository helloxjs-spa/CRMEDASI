import { and, asc, eq, ilike, or, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { hashPassword } from "@/server/auth/password";
import { revokeAllUserSessions } from "@/server/auth/session";
import { assertPermission, hasPermission } from "@/server/authz/permissions";
import type { ServiceContext } from "@/server/context";
import { isUniqueViolation } from "@/server/db/errors";
import { leads, sales, sellerGoals, teams, USER_ROLES, users, type UserRole } from "@/server/db/schema";
import { runTransaction } from "@/server/db/transaction";
import type { Database } from "@/server/db/types";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import {
  countOpenLeadsOfSeller,
  moveOpenLeadsWithSeller,
  lockTeamsForShare,
  unassignOpenLeadsOfSeller,
} from "@/server/modules/leads/leads.internal";
import { emailSchema, idSchema, nameSchema, parseInput, passwordSchema } from "@/server/validation";

/**
 * Colunas que podem sair do serviço. password_hash nunca é selecionado aqui.
 */
const userView = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  teamId: users.teamId,
  teamName: teams.name,
  createdAt: users.createdAt,
};

export type UserView = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  teamId: string | null;
  teamName: string | null;
  createdAt: Date;
};

const EMAIL_TAKEN = "Já existe um usuário com este e-mail.";

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

const listFiltersSchema = z.strictObject({
  role: z.enum(USER_ROLES).optional(),
  teamId: idSchema.optional(),
  active: z.boolean().optional(),
  search: z.string().trim().max(120).optional(),
});

/**
 * ADMIN e SUPERVISOR: todos os usuários. SELLER: sem acesso (usa getUser para
 * o próprio perfil).
 */
export async function listUsers({ db, actor }: ServiceContext, rawFilters: unknown = {}): Promise<UserView[]> {
  assertPermission(actor, "users:view");
  const filters = parseInput(listFiltersSchema, rawFilters);

  const conditions: (SQL | undefined)[] = [];
  if (filters.role) conditions.push(eq(users.role, filters.role));
  if (filters.teamId) conditions.push(eq(users.teamId, filters.teamId));
  if (filters.active !== undefined) conditions.push(eq(users.active, filters.active));
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(users.name, term), ilike(users.email, term)));
  }

  return db
    .select(userView)
    .from(users)
    .leftJoin(teams, eq(teams.id, users.teamId))
    .where(and(...conditions))
    .orderBy(asc(users.name));
}

/**
 * Qualquer usuário vê o próprio perfil. ADMIN e SUPERVISOR veem todos.
 * Fora do escopo → NotFound.
 */
export async function getUser({ db, actor }: ServiceContext, rawId: unknown): Promise<UserView> {
  const id = parseInput(idSchema, rawId);
  const user = await findUserView(db, id);
  if (!user) throw new NotFoundError();

  if (user.id !== actor.userId && !hasPermission(actor, "users:view")) throw new NotFoundError();
  return user;
}

/**
 * Trava a linha do usuário antes de decidir com base nela (FOR NO KEY UPDATE,
 * o mesmo modo do UPDATE que virá). É a primeira trava das operações que
 * mexem no vendedor e depois nos leads dele: ordem usuário → leads, a mesma
 * das mutações de lead (ver lockUsersForChange em leads.internal.ts).
 */
async function lockUser(db: Database, id: string): Promise<void> {
  await db.select({ id: users.id }).from(users).where(eq(users.id, id)).for("no key update");
}

async function findUserView(db: Database, id: string): Promise<UserView | undefined> {
  const [user] = await db.select(userView).from(users).leftJoin(teams, eq(teams.id, users.teamId)).where(eq(users.id, id)).limit(1);
  return user;
}

// ---------------------------------------------------------------------------
// Escrita (ADMIN e SUPERVISOR; contas ADMIN e perfil, só ADMIN)
// ---------------------------------------------------------------------------

export const ADMIN_ACCOUNT_FORBIDDEN = "Somente um administrador pode criar ou alterar a conta de um administrador.";

/**
 * Conta ADMIN só é criada ou alterada por ADMIN: quem pudesse trocar a senha
 * ou o e-mail de um ADMIN entraria como ele (Auditoria e perfis inclusos).
 */
function assertCanManageAccount(actor: ServiceContext["actor"], target: { role: UserRole } | null | undefined): void {
  if (target?.role === "ADMIN" && !hasPermission(actor, "users:manageAdmins")) throw new ForbiddenError(ADMIN_ACCOUNT_FORBIDDEN);
}

const createUserSchema = z
  .strictObject({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(USER_ROLES, { error: "Selecione um perfil." }),
    teamId: idSchema.nullish(),
  })
  .refine((v) => v.role === "SELLER" || !v.teamId, {
    path: ["teamId"],
    message: "Somente vendedores pertencem a uma equipe.",
  });

export async function createUser(ctx: ServiceContext, input: unknown): Promise<UserView> {
  const { db, actor } = ctx;
  assertPermission(actor, "users:manage");
  const data = parseInput(createUserSchema, input);
  assertCanManageAccount(actor, data);
  const passwordHash = await hashPassword(data.password);

  try {
    const id = await db.transaction(async (tx) => {
      if (data.teamId) await assertActiveTeam(tx, data.teamId);
      const [created] = await tx
        .insert(users)
        .values({
          name: data.name,
          email: data.email,
          passwordHash,
          role: data.role,
          teamId: data.teamId ?? null,
        })
        .returning({ id: users.id });
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "user.created",
        entityType: "user",
        entityId: created.id,
        teamId: data.teamId ?? null,
        metadata: { name: data.name, email: data.email, role: data.role },
      });
      return created.id;
    });
    return (await findUserView(db, id))!;
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) {
      throw new ConflictError(EMAIL_TAKEN);
    }
    throw error;
  }
}

const updateUserSchema = z.strictObject({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
});

export async function updateUser(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<UserView> {
  const { db, actor } = ctx;
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(updateUserSchema, input);
  assertCanManageAccount(actor, await findUserView(db, id));

  try {
    await db.transaction(async (tx) => {
      await lockUser(tx, id);
      const before = await findUserView(tx, id);
      if (!before) throw new NotFoundError();
      assertCanManageAccount(actor, before);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (data.name !== undefined && data.name !== before.name) changes.name = { from: before.name, to: data.name };
      if (data.email !== undefined && data.email !== before.email) changes.email = { from: before.email, to: data.email };
      if (Object.keys(changes).length === 0) return;

      await tx.update(users).set({ name: data.name, email: data.email }).where(eq(users.id, id));
      await recordAudit(tx, {
        actorId: actor.userId,
        action: "user.updated",
        entityType: "user",
        entityId: id,
        teamId: before.teamId,
        metadata: { changes },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_unique")) throw new ConflictError(EMAIL_TAKEN);
    throw error;
  }
  return (await findUserView(db, id))!;
}

export async function setUserActive(ctx: ServiceContext, rawId: unknown, rawActive: unknown): Promise<void> {
  const { db, actor } = ctx;
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  const active = parseInput(z.boolean(), rawActive);
  if (id === actor.userId && !active) {
    throw new ValidationError("Você não pode desativar o próprio usuário.");
  }
  assertCanManageAccount(actor, await findUserView(db, id));

  // READ COMMITTED (exigido pelo 003 para desativar vendedor) e nova
  // tentativa em caso de deadlock/serialização.
  await runTransaction(db, async (tx) => {
    await lockUser(tx, id);
    const user = await findUserView(tx, id);
    if (!user) throw new NotFoundError();
    assertCanManageAccount(actor, user);
    if (user.active === active) return;

    if (!active && user.role === "SUPERVISOR") {
      const [ledTeam] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.supervisorId, id)).limit(1);
      if (ledTeam) {
        throw new ConflictError(
          `Este supervisor lidera a equipe "${ledTeam.name}". Defina outro supervisor para a equipe antes de desativá-lo.`,
        );
      }
    }

    // Equipe do vendedor (FOR SHARE, depois do usuário e antes dos leads):
    // - desativação: fixa o supervisor gravado nos eventos UNASSIGNED até o COMMIT;
    // - reativação: vendedor de equipe INATIVA não é reativado (regularizar
    //   reativando a equipe ou transferindo o vendedor). Com a equipe travada,
    //   uma desativação concorrente dela espera esta transação (e então vê o
    //   vendedor ativo) ou termina antes (e esta transação vê a equipe inativa).
    if (user.role === "SELLER" && user.teamId) {
      const team = (await lockTeamsForShare(tx, [user.teamId])).get(user.teamId);
      if (active && !team?.active) throw new ValidationError(SELLER_TEAM_INACTIVE);
    }

    await tx.update(users).set({ active }).where(eq(users.id, id));
    if (!active) await revokeAllUserSessions(tx, id);
    // Vendedor desativado: os leads em operação ficam sem responsável, na fila
    // do supervisor da mesma equipe (sem Retrabalho). Reativar não os devolve.
    const unassignedLeads = !active && user.role === "SELLER" ? await unassignOpenLeadsOfSeller(tx, actor.userId, id) : 0;
    await recordAudit(tx, {
      actorId: actor.userId,
      action: active ? "user.activated" : "user.deactivated",
      entityType: "user",
      entityId: id,
      teamId: user.teamId,
      metadata: unassignedLeads > 0 ? { unassignedLeads } : undefined,
    });
  });
}

const changeRoleSchema = z
  .strictObject({
    role: z.enum(USER_ROLES, { error: "Selecione um perfil." }),
    teamId: idSchema.nullish(),
  })
  .refine((v) => v.role === "SELLER" || !v.teamId, {
    path: ["teamId"],
    message: "Somente vendedores pertencem a uma equipe.",
  });

export const SELF_ROLE_CHANGE_FORBIDDEN = "Você não pode alterar o próprio perfil.";

export const SELLER_HAS_HISTORY =
  "Este vendedor tem leads, vendas ou metas registrados, e esse histórico precisa continuar ligado a um vendedor. Para dar outro perfil a esta pessoa, cadastre um novo usuário.";

export const supervisorLeadsTeam = (teamName: string) =>
  `Este supervisor lidera a equipe "${teamName}". Defina outro supervisor para a equipe antes de alterar o perfil.`;

/**
 * Altera o perfil (papel) de outro usuário. Apenas ADMIN (o SUPERVISOR não).
 * Recusado para:
 * - o próprio usuário (evita perder o último acesso de administrador);
 * - SUPERVISOR que lidera uma equipe (trocar o supervisor da equipe antes);
 * - SELLER com leads, vendas ou metas (o histórico comercial exige um SELLER).
 * Quem passa a ser SELLER pode entrar direto numa equipe ativa; quem deixa de
 * ser SELLER sai da equipe. O banco (010) repete as duas recusas.
 * O ator é recarregado do banco a cada requisição: o novo perfil vale no
 * próximo clique do usuário, sem derrubar a sessão.
 */
export async function changeUserRole(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  const { db, actor } = ctx;
  assertPermission(actor, "users:changeRole");
  const id = parseInput(idSchema, rawId);
  const data = parseInput(changeRoleSchema, input);
  if (id === actor.userId) throw new ValidationError(SELF_ROLE_CHANGE_FORBIDDEN);

  // READ COMMITTED: cada consulta abaixo vê o que foi gravado até ela, depois
  // da trava do usuário (leads, vendas e equipes leem essa linha com FOR SHARE).
  await runTransaction(db, async (tx) => {
    await lockUser(tx, id);
    const user = await findUserView(tx, id);
    if (!user) throw new NotFoundError();
    if (user.role === data.role) return;

    if (user.role === "SUPERVISOR") {
      const [ledTeam] = await tx.select({ name: teams.name }).from(teams).where(eq(teams.supervisorId, id)).limit(1);
      if (ledTeam) throw new ConflictError(supervisorLeadsTeam(ledTeam.name));
    }
    if (user.role === "SELLER" && (await sellerHasCommercialHistory(tx, id))) {
      throw new ConflictError(SELLER_HAS_HISTORY);
    }

    const teamId = data.role === "SELLER" ? (data.teamId ?? null) : null;
    if (teamId) await assertActiveTeam(tx, teamId);

    await tx.update(users).set({ role: data.role, teamId }).where(eq(users.id, id));
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "user.role_changed",
      entityType: "user",
      entityId: id,
      teamId: teamId ?? user.teamId,
      metadata: {
        fromRole: user.role,
        toRole: data.role,
        ...(user.teamName ? { fromTeamName: user.teamName } : {}),
        ...(teamId ? { toTeamName: (await teamSnapshot(tx, teamId))?.teamName ?? null } : {}),
      },
    });
  });
}

/** Leads (inclusive encerrados e na Lixeira), vendas (inclusive estornadas) ou metas do vendedor. */
async function sellerHasCommercialHistory(db: Database, sellerId: string): Promise<boolean> {
  const [lead] = await db.select({ id: leads.id }).from(leads).where(eq(leads.ownerId, sellerId)).limit(1);
  if (lead) return true;
  const [sale] = await db.select({ id: sales.id }).from(sales).where(eq(sales.sellerId, sellerId)).limit(1);
  if (sale) return true;
  const [goal] = await db.select({ id: sellerGoals.id }).from(sellerGoals).where(eq(sellerGoals.sellerId, sellerId)).limit(1);
  return !!goal;
}

const resetPasswordSchema = z.strictObject({ password: passwordSchema });

export const SELF_RESET_FORBIDDEN = "Para alterar a própria senha, use a tela Perfil, que pede a senha atual.";

export async function resetUserPassword(ctx: ServiceContext, rawId: unknown, input: unknown): Promise<void> {
  const { db, actor } = ctx;
  assertPermission(actor, "users:manage");
  const id = parseInput(idSchema, rawId);
  if (id === actor.userId) throw new ValidationError(SELF_RESET_FORBIDDEN);
  const { password } = parseInput(resetPasswordSchema, input);
  assertCanManageAccount(actor, await findUserView(db, id));
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    await lockUser(tx, id);
    assertCanManageAccount(actor, await findUserView(tx, id));
    const [updated] = await tx.update(users).set({ passwordHash }).where(eq(users.id, id)).returning({ teamId: users.teamId });
    if (!updated) throw new NotFoundError();
    await revokeAllUserSessions(tx, id);
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "user.password_reset",
      entityType: "user",
      entityId: id,
      teamId: updated.teamId,
    });
  });
}

const changeTeamSchema = z.strictObject({ teamId: idSchema.nullable() });

export const SELLER_TEAM_INACTIVE =
  "A equipe deste vendedor está inativa. Reative a equipe ou transfira o vendedor para uma equipe ativa antes de reativá-lo.";

export const SELLER_HAS_OPEN_LEADS =
  "Este vendedor possui leads em aberto. Transfira os leads antes de removê-lo da equipe.";

/**
 * Move um vendedor para outra equipe (ou o deixa sem equipe). ADMIN e SUPERVISOR.
 * Os leads em operação do vendedor o acompanham para a nova equipe (decisão
 * C4). Deixá-lo sem equipe é recusado enquanto houver leads em operação.
 */
export async function changeSellerTeam(
  { db, actor }: ServiceContext,
  rawSellerId: unknown,
  input: unknown,
): Promise<void> {
  assertPermission(actor, "users:manage");
  const sellerId = parseInput(idSchema, rawSellerId);
  const { teamId } = parseInput(changeTeamSchema, input);

  // READ COMMITTED (exigido pelo 003 para trocar vendedor de equipe) e nova
  // tentativa em caso de deadlock/serialização.
  await runTransaction(db, async (tx) => {
    await lockUser(tx, sellerId);
    const seller = await findUserView(tx, sellerId);
    if (!seller) throw new NotFoundError();
    if (seller.role !== "SELLER") throw new ValidationError("Apenas vendedores podem ser movidos entre equipes.");
    if (seller.teamId === teamId) return;
    // Equipes de origem e destino (FOR SHARE, depois do vendedor e antes dos
    // leads): a desativação da equipe destino espera esta troca (ou a troca vê
    // a equipe já inativa), e os supervisores gravados nos eventos ficam estáveis.
    await lockTeamsForShare(tx, [seller.teamId, teamId]);
    if (teamId) await assertActiveTeam(tx, teamId);
    if (!teamId && (await countOpenLeadsOfSeller(tx, sellerId)) > 0) throw new ConflictError(SELLER_HAS_OPEN_LEADS);

    // Retrato de origem e destino no momento da mudança (equipe e supervisor),
    // para que o histórico continue legível mesmo após renomeações ou trocas
    // de supervisor.
    const [from, to] = await Promise.all([teamSnapshot(tx, seller.teamId), teamSnapshot(tx, teamId)]);

    await tx.update(users).set({ teamId }).where(eq(users.id, sellerId));
    const movedLeads =
      seller.teamId && teamId ? await moveOpenLeadsWithSeller(tx, actor.userId, sellerId, seller.teamId, teamId) : 0;
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "user.team_changed",
      entityType: "user",
      entityId: sellerId,
      teamId,
      metadata: { fromTeamId: seller.teamId, toTeamId: teamId, from, to, movedLeads },
    });
  });
}

type TeamSnapshot = { teamId: string; teamName: string; supervisorId: string | null; supervisorName: string | null };

async function teamSnapshot(db: Database, teamId: string | null): Promise<TeamSnapshot | null> {
  if (!teamId) return null;
  const supervisor = alias(users, "supervisor");
  const [row] = await db
    .select({ teamId: teams.id, teamName: teams.name, supervisorId: teams.supervisorId, supervisorName: supervisor.name })
    .from(teams)
    .leftJoin(supervisor, eq(supervisor.id, teams.supervisorId))
    .where(eq(teams.id, teamId))
    .limit(1);
  return row ?? null;
}

/**
 * Equipe de destino de um vendedor: existe e está ativa. Trava a equipe
 * (FOR SHARE) até o COMMIT, para que uma desativação concorrente espere esta
 * transação ou seja vista por ela.
 */
async function assertActiveTeam(db: Database, teamId: string): Promise<void> {
  const [team] = await db.select({ active: teams.active }).from(teams).where(eq(teams.id, teamId)).limit(1).for("share");
  if (!team) throw new ValidationError("Equipe não encontrada.", { teamId: ["Equipe não encontrada."] });
  if (!team.active) throw new ValidationError("A equipe está inativa.", { teamId: ["A equipe está inativa."] });
}
