import { getCloudflareContext } from "@opennextjs/cloudflare";
import { ipBucketValue } from "./rate-limit";

/**
 * Rate Limiting da Cloudflare para o login (binding LOGIN_RATE_LIMITER, em
 * wrangler.jsonc). É o filtro de borda por IP, antes do banco e do scrypt, e
 * funciona em *.workers.dev, onde as regras de WAF não se aplicam por não haver
 * zona. O contador é por localização e aproximado: o limite por conta continua
 * sendo o de rate-limit.ts. O IP vem de CF-Connecting-IP (client-ip.ts).
 */
export type EdgeLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export async function edgeLimitExceeded(limiter: EdgeLimiter | undefined, ip: string | null): Promise<boolean> {
  if (!limiter || !ip) return false;
  try {
    return !(await limiter.limit({ key: ipBucketValue(ip) })).success;
  } catch {
    return false; // Falha do binding não pode derrubar o login: o limite no banco continua valendo.
  }
}

function loginLimiter(): EdgeLimiter | undefined {
  try {
    return (getCloudflareContext() as unknown as { env: { LOGIN_RATE_LIMITER?: EdgeLimiter } }).env.LOGIN_RATE_LIMITER;
  } catch {
    return undefined; // fora do Workers (next dev, next start, testes)
  }
}

export function loginEdgeLimitExceeded(ip: string | null): Promise<boolean> {
  return edgeLimitExceeded(loginLimiter(), ip);
}
