import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { rateLimitBuckets } from "@/server/db/schema";
import type { Database } from "@/server/db/types";

/**
 * Limitador de tentativas compartilhado entre instâncias do Worker (tabela
 * rate_limit_buckets, migration 009). Janela fixa de 15 minutos por chave: o
 * bloqueio vence sozinho, então tentativas de terceiros não travam uma conta de
 * forma permanente. A contagem acontece ANTES do trabalho caro (scrypt), num
 * único comando atômico: rajadas simultâneas não passam todas pela checagem.
 * As chaves são gravadas como SHA-256, sem e-mail ou IP em claro.
 */
export type Bucket = { key: string; limit: number };

const ATTEMPTS_CAP = 1_000_000;
const WINDOW = sql`interval '15 minutes'`;

/** Falhas por e-mail + IP, por conta e por IP, a cada 15 minutos. */
export const LOGIN_LIMITS = { pair: 10, account: 30, ip: 100 } as const;

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Conta uma tentativa em cada balde e devolve o total de cada um na janela atual, por `key`. */
export async function hitBuckets(db: Database, buckets: Bucket[]): Promise<Map<string, number>> {
  const hashed = buckets.map((bucket) => ({ key: bucket.key, hash: hashKey(bucket.key) })).sort((a, b) => a.hash.localeCompare(b.hash));
  const expired = sql`${rateLimitBuckets.windowStartedAt} <= now() - ${WINDOW}`;
  const rows = await db
    .insert(rateLimitBuckets)
    .values(hashed.map(({ hash }) => ({ key: hash, attempts: 1 })))
    .onConflictDoUpdate({
      target: rateLimitBuckets.key,
      set: {
        attempts: sql`case when ${expired} then 1 else least(${rateLimitBuckets.attempts} + 1, ${ATTEMPTS_CAP}) end`,
        windowStartedAt: sql`case when ${expired} then now() else ${rateLimitBuckets.windowStartedAt} end`,
      },
    })
    .returning({ key: rateLimitBuckets.key, attempts: rateLimitBuckets.attempts });
  const byHash = new Map(rows.map((row) => [row.key, row.attempts]));
  return new Map(hashed.map(({ key, hash }) => [key, byHash.get(hash) ?? 0]));
}

/** Consulta sem contar: o balde já atingiu o limite na janela atual? */
export async function isBucketFull(db: Database, bucket: Bucket): Promise<boolean> {
  const [row] = await db
    .select({ attempts: rateLimitBuckets.attempts })
    .from(rateLimitBuckets)
    .where(and(eq(rateLimitBuckets.key, hashKey(bucket.key)), gt(rateLimitBuckets.windowStartedAt, sql`now() - ${WINDOW}`)))
    .limit(1);
  return !!row && row.attempts >= bucket.limit;
}

export async function clearBuckets(db: Database, keys: string[]): Promise<void> {
  await db.delete(rateLimitBuckets).where(inArray(rateLimitBuckets.key, keys.map(hashKey)));
}

/** Devolve uma tentativa que deu certo (ela não conta como falha). */
export async function refundBuckets(db: Database, keys: string[]): Promise<void> {
  await db
    .update(rateLimitBuckets)
    .set({ attempts: sql`greatest(${rateLimitBuckets.attempts} - 1, 0)` })
    .where(inArray(rateLimitBuckets.key, keys.map(hashKey)));
}

/** Apaga as linhas vencidas, mantendo a tabela do tamanho das últimas tentativas. */
export async function pruneBuckets(db: Database): Promise<void> {
  await db.delete(rateLimitBuckets).where(lte(rateLimitBuckets.windowStartedAt, sql`now() - ${WINDOW}`));
}

/**
 * Valor do IP nos baldes: IPv6 é contado por /64, pois um único cliente costuma
 * controlar o prefixo inteiro e trocar de endereço não pode zerar o limite.
 */
export function ipBucketValue(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("%")[0].split("::");
  const start = head ? head.split(":") : [];
  const end = tail ? tail.split(":") : [];
  const groups = [...start, ...Array(Math.max(0, 8 - start.length - end.length)).fill("0"), ...end];
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export const accountBucket = (email: string): Bucket => ({ key: `login:account:${email}`, limit: LOGIN_LIMITS.account });

/** Baldes de uma tentativa de login. `ip` fica null quando a origem é desconhecida. */
export function loginBuckets(email: string, ipAddress: string | null | undefined) {
  const ip = ipAddress ? ipBucketValue(ipAddress) : null;
  return {
    pair: { key: `login:pair:${email}|${ip ?? ""}`, limit: LOGIN_LIMITS.pair },
    account: accountBucket(email),
    ip: ip ? { key: `login:ip:${ip}`, limit: LOGIN_LIMITS.ip } : null,
    /** Só conta o volume total, para limitar as linhas de auditoria; nunca bloqueia. */
    volume: { key: "login:volume", limit: ATTEMPTS_CAP },
  };
}
