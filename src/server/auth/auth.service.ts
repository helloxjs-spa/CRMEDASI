import { eq } from "drizzle-orm";
import { z } from "zod";
import type { ServiceContext } from "@/server/context";
import { users } from "@/server/db/schema";
import type { Database } from "@/server/db/types";
import { ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { emailSchema, parseInput, passwordSchema } from "@/server/validation";
import { getDummyHash, hashPassword, verifyPassword } from "./password";
import { clearBuckets, hitBuckets, loginBuckets, pruneBuckets, refundBuckets, type Bucket } from "./rate-limit";
import { assertActorPassword } from "./reauth";
import { createSessionIfCredentialsCurrent, revokeAllUserSessions } from "./session";

const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, "Informe a senha.").max(200),
});

const INVALID_CREDENTIALS = "E-mail ou senha inválidos.";

export const LOGIN_RATE_LIMITED = "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.";

/**
 * Teto de linhas de auditoria de login, para quem não está autenticado não
 * poder encher a tabela (que é append-only): por janela de 15 minutos, as
 * primeiras falhas de cada conta existente e um total para o restante (e-mails
 * inexistentes e bloqueios). Quem passa disso continua sendo contado e bloqueado.
 */
const FAILED_LOGIN_AUDITS_PER_ACCOUNT = 3;
const FAILED_LOGIN_AUDITS_PER_WINDOW = 200;
/** Fração das tentativas que aproveita para apagar contadores vencidos. */
const PRUNE_PROBABILITY = 0.02;

export async function login(
  db: Database,
  input: unknown,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const { email, password } = parseInput(loginSchema, input);
  const buckets = loginBuckets(email, meta.ipAddress);
  const counted = new Map<string, number>();
  const attempts = (bucket: Bucket) => counted.get(bucket.key) ?? 0;
  const over = (bucket: Bucket | null) => !!bucket && attempts(bucket) > bucket.limit;

  // Primeiro e-mail + IP e IP: quem já está bloqueado não consome o limite da
  // conta, senão uma única origem bastaria para travar um usuário legítimo.
  for (const [key, value] of await hitBuckets(db, [buckets.pair, buckets.volume, ...(buckets.ip ? [buckets.ip] : [])])) counted.set(key, value);
  if (Math.random() < PRUNE_PROBABILITY) await pruneBuckets(db).catch(() => undefined);
  if (!over(buckets.pair) && !over(buckets.ip)) {
    for (const [key, value] of await hitBuckets(db, [buckets.account])) counted.set(key, value);
  }
  if (over(buckets.pair) || over(buckets.ip) || over(buckets.account)) {
    const justBlocked = attempts(buckets.account) === buckets.account.limit + 1 || (!!buckets.ip && attempts(buckets.ip) === buckets.ip.limit + 1);
    if (justBlocked && attempts(buckets.volume) <= FAILED_LOGIN_AUDITS_PER_WINDOW) {
      await recordAudit(db, {
        actorId: null,
        action: "auth.login_throttled",
        entityType: "session",
        metadata: { email, ipAddress: meta.ipAddress ?? null, scope: over(buckets.account) ? "account" : "ip" },
      });
    }
    throw new ValidationError(LOGIN_RATE_LIMITED);
  }

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, active: users.active })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // Sempre executa a verificação de senha para não revelar, pelo tempo de
  // resposta, se o e-mail existe.
  const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));

  if (!user || !passwordOk || !user.active) {
    const audit = user ? attempts(buckets.account) <= FAILED_LOGIN_AUDITS_PER_ACCOUNT : attempts(buckets.volume) <= FAILED_LOGIN_AUDITS_PER_WINDOW;
    if (audit) {
      await recordAudit(db, {
        actorId: user?.id ?? null,
        action: "auth.login_failed",
        entityType: "session",
        metadata: { email, ipAddress: meta.ipAddress ?? null, reason: !user ? "unknown_email" : !passwordOk ? "wrong_password" : "inactive_user" },
      });
    }
    throw new ValidationError(INVALID_CREDENTIALS);
  }

  const session = await createSessionIfCredentialsCurrent(db, user.id, user.passwordHash, meta);
  if (!session) throw new ValidationError(INVALID_CREDENTIALS);
  await clearBuckets(db, [buckets.pair.key]);
  await refundBuckets(db, [buckets.account.key, ...(buckets.ip ? [buckets.ip.key] : [])]);
  await recordAudit(db, {
    actorId: user.id,
    action: "auth.login",
    entityType: "session",
    entityId: user.id,
    metadata: { ipAddress: meta.ipAddress ?? null },
  });
  return session;
}

const changePasswordSchema = z
  .strictObject({
    currentPassword: z.string().min(1, "Informe a senha atual."),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "As senhas não conferem.",
  });

/** Troca a senha do próprio usuário e encerra todas as sessões dele. */
export async function changeOwnPassword(ctx: ServiceContext, input: unknown): Promise<void> {
  const { db, actor } = ctx;
  const data = parseInput(changePasswordSchema, input);
  await assertActorPassword(ctx, data.currentPassword, { field: "currentPassword", wrongMessage: "Senha atual incorreta." });
  const passwordHash = await hashPassword(data.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, actor.userId));
    await revokeAllUserSessions(tx, actor.userId);
    await recordAudit(tx, {
      actorId: actor.userId,
      action: "auth.password_changed",
      entityType: "user",
      entityId: actor.userId,
    });
  });
}
