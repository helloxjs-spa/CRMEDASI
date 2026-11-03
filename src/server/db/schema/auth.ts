import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./organization";

/**
 * Sessões de login. O cookie carrega um token aleatório; o banco guarda apenas
 * o SHA-256 dele (id), de modo que um vazamento da tabela não permite sequestrar
 * sessões.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type Session = typeof sessions.$inferSelect;

/**
 * Contadores de tentativas compartilhados entre instâncias (migration 009). A
 * chave é um SHA-256; não é histórico: linhas vencidas são apagadas.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").primaryKey(),
    attempts: integer("attempts").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limit_buckets_window_idx").on(t.windowStartedAt)],
);
