import type { Metadata } from "next";
import { ArrowLeft, Lock } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { formatBRL } from "@/lib/money";
import { listCourseFilterOptions } from "@/server/modules/courses/courses.service";
import { getSaleReceiptInfo } from "@/server/modules/sales/sale-receipts.service";
import { getSale, listSaleSellerOptions } from "@/server/modules/sales/sales.service";
import { orNotFound } from "@/server/next/page";
import { requireServiceContext } from "@/server/next/session";
import { saleActionsFor, saleEditCapabilities } from "../../policy";
import { SaleStatusBadge } from "../../sale-badges";
import { ReceiptEditor } from "./receipt-editor";
import { SaleEditForm } from "./sale-edit-form";

export const metadata: Metadata = { title: "Editar venda" };

/**
 * Edição da venda (getSale: escopo; sem custos para ninguém nesta tela). O
 * formulário é remontado a cada nova versão da venda (key), então recarregar
 * depois de um conflito traz os dados e a versão atuais.
 */
export default async function EditSalePage({ params }: PageProps<"/vendas/[saleId]/editar">) {
  const { saleId } = await params;
  const ctx = await requireServiceContext();
  const sale = await orNotFound(getSale(ctx, saleId));
  const back = (
    <Link href={`/vendas/${sale.id}`} className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
      <ArrowLeft className="size-4" aria-hidden /> Venda
    </Link>
  );

  if (!saleActionsFor(sale, ctx.actor).includes("edit")) {
    return (
      <>
        {back}
        <Card>
          <EmptyState
            icon={Lock}
            title="Venda somente leitura"
            description="Venda estornada não pode ser alterada pelo vendedor."
            action={<ButtonLink href={`/vendas/${sale.id}`} variant="secondary">Voltar para a venda</ButtonLink>}
          />
        </Card>
      </>
    );
  }

  const caps = saleEditCapabilities(ctx.actor);
  const [courses, sellers, receipt] = await Promise.all([
    listCourseFilterOptions(ctx),
    caps.changeSeller ? listSaleSellerOptions(ctx) : Promise.resolve([]),
    getSaleReceiptInfo(ctx, sale.id),
  ]);

  return (
    <>
      {back}
      <PageHeader
        title={`Editar venda — ${sale.leadName}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <SaleStatusBadge status={sale.status} />
            <span>Total atual: {formatBRL(sale.totalCents)}</span>
          </span>
        }
      />
      <Card className="p-4 sm:p-6">
        <SaleEditForm
          key={sale.version}
          sale={{
            id: sale.id,
            version: sale.version,
            saleDate: sale.saleDate,
            paymentMethod: sale.paymentMethod,
            installmentCount: sale.installmentCount,
            sellerId: sale.sellerId,
            items: sale.items.map(({ id, courseName, institutionName, priceCents }) => ({ id, courseName, institutionName, priceCents })),
          }}
          caps={caps}
          courses={courses.filter((c) => c.active).map(({ id, name, institutionName }) => ({ id, name, institutionName }))}
          sellers={sellers.map(({ id, name, teamName }) => ({ id, name, teamName }))}
        />
      </Card>
      {/* Comprovante: formulários próprios (não dependem da versão da venda); remonta quando o comprovante muda. */}
      <Card className="mt-4">
        <CardHeader title="Comprovante de pagamento" description="Trocar ou remover apaga o arquivo anterior; fica só o registro no histórico." />
        <div className="p-5">
          <ReceiptEditor
            key={receipt?.id ?? "none"}
            saleId={sale.id}
            receipt={receipt && { id: receipt.id, fileName: receipt.fileName, sizeBytes: receipt.sizeBytes }}
          />
        </div>
      </Card>
    </>
  );
}
