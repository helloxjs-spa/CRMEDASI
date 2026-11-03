import { and, eq } from "drizzle-orm";
import type { ServiceContext } from "@/server/context";
import { users } from "@/server/db/schema";
import { ValidationError } from "@/server/errors";
import { recordAudit } from "@/server/modules/audit/audit.service";
import { verifyPassword } from "./password";
import { clearBuckets, hitBuckets, type Bucket } from "./rate-limit";

export const ACTOR_PASSWORD_REQUIRED = "Confirme com a sua senha para continuar.";
export const ACTOR_PASSWORD_WRONG = "Sua senha está incorreta.";
export const REAUTH_LOCKED = "Muitas tentativas de confirmação de senha. Aguarde alguns minutos e tente novamente.";

const REAUTH_LIMIT = 5;

/**
 * Prova de identidade para operações sensíveis: uma sessão roubada não basta,
 * é preciso a senha de quem está logado. O limite por usuário impede usar esta
 * verificação para adivinhar a senha, e cada falha é auditada (no máximo o
 * limite por janela, porque depois dele a senha nem é conferida).
 */
export async function assertActorPassword(
  { db, actor }: ServiceContext,
  password: string | undefined,
  { field = "actorPassword", wrongMessage = ACTOR_PASSWORD_WRONG }: { field?: string; wrongMessage?: string } = {},
): Promise<void> {
  if (!password) throw new ValidationError(ACTOR_PASSWORD_REQUIRED, { [field]: [ACTOR_PASSWORD_REQUIRED] });

  const bucket: Bucket = { key: `reauth:${actor.userId}`, limit: REAUTH_LIMIT };
  const attempts = (await hitBuckets(db, [bucket])).get(bucket.key) ?? 0;
  if (attempts > bucket.limit) throw new ValidationError(REAUTH_LOCKED, { [field]: [REAUTH_LOCKED] });

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.active, true)))
    .limit(1);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    await recordAudit(db, { actorId: actor.userId, action: "auth.reauth_failed", entityType: "user", entityId: actor.userId });
    throw new ValidationError(wrongMessage, { [field]: [wrongMessage] });
  }
  await clearBuckets(db, [bucket.key]);
}
