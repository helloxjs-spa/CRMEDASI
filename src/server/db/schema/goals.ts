import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./columns";
import { users } from "./organization";

/**
 * Metas mensais de faturamento por vendedor. Espelha database/migrations/
 * 007_seller_goals.sql, que é a fonte do schema. Ficam SÓ no SQL os triggers
 * (sem DELETE/TRUNCATE; responsável sempre SELLER; vendedor, mês, autor e
 * criação imutáveis). A meta do time inteiro não é gravada: é a soma do mês.
 * `month` = primeiro dia do mês ("AAAA-MM-01").
 */
export const sellerGoals = pgTable(
  "seller_goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerId: uuid("seller_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    month: date("month", { mode: "string" }).notNull(),
    targetCents: integer("target_cents").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps,
  },
  (t) => [
    unique("seller_goals_seller_month_unique").on(t.sellerId, t.month),
    index("seller_goals_month_idx").on(t.month),
    check("seller_goals_month_first_day", sql`EXTRACT(DAY FROM ${t.month}) = 1`),
    check("seller_goals_target_positive", sql`${t.targetCents} > 0`),
  ],
);
