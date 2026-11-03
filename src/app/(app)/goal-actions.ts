"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { parseBRLToCents } from "@/lib/money";
import { setSellerGoal } from "@/server/modules/goals/goals.service";
import { runAction, text } from "@/server/next/action";

export async function setSellerGoalAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async (ctx) => {
    await setSellerGoal(ctx, {
      sellerId: text(formData, "sellerId"),
      month: text(formData, "month"),
      // Valor em reais → centavos; undefined faz o serviço apontar o erro no campo.
      targetCents: parseBRLToCents(text(formData, "target")) ?? undefined,
    });
    revalidatePath("/");
    return "Meta salva.";
  });
}
