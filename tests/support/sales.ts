import { randomUUID } from "node:crypto";
import type { DatabaseHandle } from "@/server/db/connect";
import { courseCosts } from "@/server/db/schema";
import { insertCourse, TEST_COMMISSION_CENTS } from "./leads";

/** Curso com custo de bolsa cadastrado (necessário para vender). */
export async function insertCourseWithCost(
  handle: DatabaseHandle,
  name: string,
  costCents: number,
  active = true,
  commissionCents = TEST_COMMISSION_CENTS,
): Promise<string> {
  const id = await insertCourse(handle, name, active, commissionCents);
  await handle.db.insert(courseCosts).values({ courseId: id, costCents });
  return id;
}

/** Entrada mínima válida de createSale (Pix, um curso por R$ 1.500,00 — o total é derivado). */
export function saleInput(leadId: string, courseId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    leadId,
    paymentMethod: "PIX",
    items: [{ courseId, priceCents: 150_000 }],
    ...overrides,
  };
}
