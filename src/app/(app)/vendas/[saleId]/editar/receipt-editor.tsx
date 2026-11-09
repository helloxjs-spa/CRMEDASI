"use client";

import { Download, Paperclip, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormAlert, SubmitButton } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { fieldErrorsOf, IDLE, type ActionState } from "@/lib/action-state";
import { formatFileSize, RECEIPT_CHANGE_UNCERTAIN, RECEIPT_CHANGED_CONCURRENTLY } from "@/lib/receipts";
import { settleAction } from "@/lib/settle-action";
import { removeSaleReceiptAction, replaceSaleReceiptAction } from "../../actions";
import { ReceiptField } from "../../sale-form-parts";

type Receipt = { id: string; fileName: string; sizeBytes: number };

/**
 * Comprovante de pagamento na edição da venda: anexar (sem comprovante),
 * trocar ou remover (com confirmação). Formulários próprios, fora do
 * formulário da venda: o comprovante não depende da versão da venda. A tela
 * envia o id do comprovante que mostra; se outro já tiver mudado, nada é
 * gravado e a tela pede para atualizar. Remover ou trocar APAGA o arquivo
 * anterior (o registro fica no histórico).
 */
export function ReceiptEditor({ saleId, receipt }: { saleId: string; receipt: Receipt | null }) {
  const [choosing, setChoosing] = useState(!receipt);
  const [file, setFile] = useState<File | null>(null);
  const router = useRouter();
  const toast = useToast();

  const [saveState, saveAction, saving] = useActionState<ActionState, FormData>(async (prev, formData) => {
    if (file) formData.set("receipt", file);
    return settleAction(replaceSaleReceiptAction, prev, formData, RECEIPT_CHANGE_UNCERTAIN);
  }, IDLE);
  const [removeState, removeAction, removing] = useActionState<ActionState, FormData>(
    (prev, formData) => settleAction(removeSaleReceiptAction, prev, formData, RECEIPT_CHANGE_UNCERTAIN),
    IDLE,
  );

  // Sucesso: avisa e recarrega os dados da página (a tela é remontada com o comprovante novo).
  useEffect(() => {
    for (const state of [saveState, removeState]) {
      if (state.status === "success") {
        toast(state.message);
        router.refresh();
      }
    }
  }, [saveState, removeState, toast, router]);

  const busy = saving || removing;
  const error = [saveState, removeState].find((s) => s.status === "error");
  const stale = error?.status === "error" && (error.message === RECEIPT_CHANGED_CONCURRENTLY || error.message === RECEIPT_CHANGE_UNCERTAIN);
  const errors = fieldErrorsOf(saveState);
  const fileErrors = Object.entries(errors).flatMap(([key, list]) => (key.startsWith("receipt") ? list : []));
  const href = `/vendas/${saleId}/comprovante`;

  return (
    <div className="space-y-3">
      <FormAlert message={error?.status === "error" && !fileErrors.length ? error.message : undefined} />
      {stale && (
        <Button variant="secondary" size="sm" onClick={() => router.refresh()}>
          <RefreshCw className="size-4" aria-hidden />
          Atualizar comprovante
        </Button>
      )}

      {receipt && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 text-sm ring-1 ring-slate-200">
          <Paperclip className="size-4 shrink-0 text-slate-500" aria-hidden />
          <a href={href} target="_blank" rel="noopener" className="min-w-0 flex-1 truncate text-brand-700 hover:underline" title={receipt.fileName}>
            {receipt.fileName}
          </a>
          <span className="shrink-0 text-xs text-slate-500">{formatFileSize(receipt.sizeBytes)}</span>
          <a href={`${href}?download=1`} className="shrink-0 text-slate-500 hover:text-slate-800" aria-label="Baixar comprovante" title="Baixar">
            <Download className="size-4" aria-hidden />
          </a>
          {!choosing && (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setChoosing(true)}>
                Trocar
              </Button>
              <form
                action={removeAction}
                onSubmit={(event) => {
                  if (!window.confirm(`Remover o comprovante "${receipt.fileName}"? O arquivo será apagado e não poderá ser recuperado.`)) event.preventDefault();
                }}
              >
                <input type="hidden" name="saleId" value={saleId} />
                <input type="hidden" name="expectedReceiptId" value={receipt.id} />
                <SubmitButton variant="danger" size="sm" pending={removing} disabled={busy}>
                  <Trash2 className="size-4" aria-hidden />
                  Remover
                </SubmitButton>
              </form>
            </div>
          )}
        </div>
      )}
      {!receipt && <p className="text-sm text-slate-500">Esta venda não tem comprovante de pagamento.</p>}

      {choosing && (
        <form
          action={saveAction}
          className="space-y-3"
          onSubmit={(event) => {
            if (receipt && !window.confirm(`Trocar o comprovante? O arquivo atual ("${receipt.fileName}") será apagado e não poderá ser recuperado.`)) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="saleId" value={saleId} />
          <input type="hidden" name="expectedReceiptId" value={receipt?.id ?? ""} />
          <ReceiptField file={file} onChange={setFile} errors={fileErrors} idPrefix="edit-sale" disabled={busy} label={receipt ? "Novo comprovante" : "Comprovante de pagamento"} />
          <div className="flex justify-end gap-2">
            {receipt && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setChoosing(false);
                  setFile(null);
                }}
              >
                Cancelar
              </Button>
            )}
            <SubmitButton size="sm" pending={saving} disabled={busy || !file}>
              {receipt ? "Trocar comprovante" : "Anexar comprovante"}
            </SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
