"use client";

import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { courseLabel, SOURCE_DETAIL_MAX_LENGTH, SOURCE_LABELS, SOURCE_ORDER, SOURCE_WITH_DETAIL } from "@/lib/leads";
import { formatPhone, parseBrazilianPhone } from "@/lib/phone";
import type { LeadSource } from "@/server/db/schema";
import { createLeadAction, editLeadAction } from "./actions";

export type CourseChoice = { id: string; name: string; institutionName: string; active: boolean };

/** Aceita qualquer formato; ao sair do campo, mostra o telefone já formatado. */
function PhoneField({ id, defaultValue, errors }: { id: string; defaultValue?: string; errors?: string[] }) {
  const [value, setValue] = useState(defaultValue ?? "");
  return (
    <Field label="Telefone" htmlFor={id} errors={errors} hint="Com DDD. Ex.: (79) 99999-9999 ou +55 79 99999-9999.">
      <Input
        id={id}
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="off"
        required
        maxLength={40}
        placeholder="(79) 99999-9999"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          const parsed = parseBrazilianPhone(value);
          if (parsed.ok) setValue(formatPhone(parsed.phone));
        }}
        aria-invalid={errors?.length ? true : undefined}
      />
    </Field>
  );
}

/**
 * Origem do lead (obrigatória). "Outras campanhas" abre o campo do nome da
 * campanha. Controlados: os valores ficam no formulário após um erro.
 */
function SourceFields({
  idPrefix,
  errors,
  lead,
}: {
  idPrefix: string;
  errors: Record<string, string[]>;
  lead?: { source: LeadSource | null; sourceDetail: string | null };
}) {
  const [source, setSource] = useState<string>(lead?.source ?? "");
  const [detail, setDetail] = useState(lead?.sourceDetail ?? "");
  return (
    <>
      <Field
        label="Origem do lead"
        htmlFor={`${idPrefix}-source`}
        errors={errors.source}
        hint={lead && !lead.source ? "Lead cadastrado antes deste campo: informe a origem para salvar." : undefined}
      >
        <Select
          id={`${idPrefix}-source`}
          name="source"
          required
          value={source}
          onChange={(e) => setSource(e.target.value)}
          aria-invalid={errors.source?.length ? true : undefined}
        >
          <option value="" disabled>
            Selecione a origem
          </option>
          {SOURCE_ORDER.map((value) => (
            <option key={value} value={value}>
              {SOURCE_LABELS[value]}
            </option>
          ))}
        </Select>
      </Field>
      {source === SOURCE_WITH_DETAIL && (
        <Field label="Qual campanha?" htmlFor={`${idPrefix}-source-detail`} errors={errors.sourceDetail}>
          <Input
            id={`${idPrefix}-source-detail`}
            name="sourceDetail"
            required
            maxLength={SOURCE_DETAIL_MAX_LENGTH}
            autoComplete="off"
            placeholder="Nome da campanha"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            aria-invalid={errors.sourceDetail?.length ? true : undefined}
          />
        </Field>
      )}
    </>
  );
}

function LeadFields({
  idPrefix,
  errors,
  courses,
  lead,
}: {
  idPrefix: string;
  errors: Record<string, string[]>;
  courses: CourseChoice[];
  lead?: { name: string; phone: string; interestCourseId: string; source: LeadSource | null; sourceDetail: string | null };
}) {
  // Na edição, um curso inativado depois do cadastro continua disponível só
  // como o valor atual (mantê-lo não é uma mudança); outros inativos não aparecem.
  const options = courses.filter((c) => c.active || c.id === lead?.interestCourseId);
  return (
    <>
      <Field label="Nome completo" htmlFor={`${idPrefix}-name`} errors={errors.name}>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={lead?.name}
          aria-invalid={errors.name?.length ? true : undefined}
        />
      </Field>
      <PhoneField id={`${idPrefix}-phone`} defaultValue={lead ? formatPhone(lead.phone) : undefined} errors={errors.phone} />
      <Field label="Curso de interesse" htmlFor={`${idPrefix}-course`} errors={errors.interestCourseId}>
        <Select id={`${idPrefix}-course`} name="interestCourseId" required defaultValue={lead?.interestCourseId ?? ""}>
          <option value="" disabled>
            Selecione o curso
          </option>
          {options.map((course) => (
            <option key={course.id} value={course.id}>
              {courseLabel(course)}
              {course.active ? "" : " (inativo, atual)"}
            </option>
          ))}
        </Select>
      </Field>
      <SourceFields idPrefix={idPrefix} errors={errors} lead={lead} />
    </>
  );
}

export type NewLeadSellerChoice = { id: string; name: string; teamName: string | null };

/**
 * Cadastro de lead. Sem `sellers` (SELLER): entra na carteira de quem cadastra.
 * Com `sellers` (SUPERVISOR/ADMIN): escolhe o vendedor responsável (C41).
 */
export function NewLeadDialog({
  courses,
  sellers,
  groupByTeam = false,
}: {
  courses: CourseChoice[];
  sellers?: NewLeadSellerChoice[];
  groupByTeam?: boolean;
}) {
  return (
    <ActionDialog
      trigger={{ label: "Novo Lead", icon: Plus }}
      title="Novo lead"
      description={
        sellers
          ? "O lead entra na carteira do vendedor escolhido, na etapa Em contato."
          : "O lead entra na sua carteira, na etapa Em contato."
      }
      action={createLeadAction}
      submitLabel="Cadastrar lead"
    >
      {(errors) => (
        <>
          <LeadFields idPrefix="new-lead" errors={errors} courses={courses} />
          {sellers && (
            <Field label="Vendedor responsável" htmlFor="new-lead-seller" errors={errors.sellerId}>
              <Select id="new-lead-seller" name="sellerId" required defaultValue="">
                <option value="" disabled>
                  {sellers.length === 0 ? "Nenhum vendedor ativo disponível" : "Selecione o vendedor"}
                </option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {groupByTeam && s.teamName ? ` — ${s.teamName}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </ActionDialog>
  );
}

export function EditLeadDialog({
  lead,
  courses,
}: {
  lead: { id: string; name: string; phone: string; interestCourseId: string; source: LeadSource | null; sourceDetail: string | null };
  courses: CourseChoice[];
}) {
  return (
    <ActionDialog
      trigger={{ label: "Editar", icon: Pencil, variant: "secondary", size: "sm" }}
      title="Editar lead"
      description="Responsável, equipe, etapa e prazos têm operações próprias e não mudam aqui."
      action={editLeadAction}
    >
      {(errors) => (
        <>
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadFields idPrefix={`edit-${lead.id}`} errors={errors} courses={courses} lead={lead} />
        </>
      )}
    </ActionDialog>
  );
}
