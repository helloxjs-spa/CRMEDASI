"use client";

import { Target } from "lucide-react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input } from "@/components/ui/form";
import { centsToInput } from "@/lib/money";
import { setSellerGoalAction } from "./goal-actions";

export function SellerGoalDialog({
  sellerId,
  sellerName,
  month,
  monthTitle,
  goalCents,
}: {
  sellerId: string;
  sellerName: string;
  month: string;
  monthTitle: string;
  goalCents: number | null;
}) {
  return (
    <ActionDialog
      trigger={{ label: "Definir meta", icon: Target, variant: "ghost", size: "sm" }}
      title={`Meta de ${sellerName}`}
      description={`${monthTitle} · faturamento de vendas válidas. A alteração fica registrada na auditoria.`}
      action={setSellerGoalAction}
    >
      {(errors) => (
        <>
          <input type="hidden" name="sellerId" value={sellerId} />
          <input type="hidden" name="month" value={month} />
          <Field label="Meta do mês (R$)" htmlFor={`goal-${sellerId}`} errors={errors.targetCents}>
            <Input
              id={`goal-${sellerId}`}
              name="target"
              inputMode="decimal"
              placeholder="0,00"
              defaultValue={goalCents !== null ? centsToInput(goalCents) : undefined}
              required
              autoFocus
            />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}
