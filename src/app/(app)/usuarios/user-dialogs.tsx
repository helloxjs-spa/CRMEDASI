"use client";

import { KeyRound, Pencil, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { ROLE_LABELS } from "@/lib/format";
import type { UserRole } from "@/server/db/schema";
import { changeUserRoleAction, createUserAction, resetPasswordAction, updateUserAction } from "./actions";

type TeamOption = { id: string; name: string };

export function CreateUserDialog({ teams, canCreateAdmin }: { teams: TeamOption[]; canCreateAdmin: boolean }) {
  return (
    <ActionDialog trigger={{ label: "Novo usuário", icon: Plus }} title="Novo usuário" action={createUserAction} submitLabel="Criar usuário">
      {(errors) => <CreateUserFields teams={teams} canCreateAdmin={canCreateAdmin} errors={errors} />}
    </ActionDialog>
  );
}

function CreateUserFields({ teams, canCreateAdmin, errors }: { teams: TeamOption[]; canCreateAdmin: boolean; errors: Record<string, string[]> }) {
  const [role, setRole] = useState("SELLER");
  return (
    <>
      <Field label="Nome completo" htmlFor="new-name" errors={errors.name}>
        <Input id="new-name" name="name" required maxLength={120} />
      </Field>
      <Field label="E-mail" htmlFor="new-email" errors={errors.email}>
        <Input id="new-email" name="email" type="email" required autoComplete="off" />
      </Field>
      <Field label="Senha inicial" htmlFor="new-password" errors={errors.password} hint="Mínimo de 12 caracteres, sem palavras óbvias. Informe ao usuário por um canal seguro.">
        <Input id="new-password" name="password" type="password" required minLength={12} autoComplete="new-password" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Perfil" htmlFor="new-role" errors={errors.role}>
          <Select id="new-role" name="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLE_LABELS)
              .filter(([value]) => canCreateAdmin || value !== "ADMIN")
              .map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
          </Select>
        </Field>
        {role === "SELLER" && (
          <Field label="Equipe" htmlFor="new-team" errors={errors.teamId}>
            <Select id="new-team" name="teamId" defaultValue="">
              <option value="">Sem equipe</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {role === "SUPERVISOR" && (
        <p className="text-xs text-slate-500">Depois de criar, vincule o supervisor a uma equipe na tela Equipes.</p>
      )}
    </>
  );
}

export function EditUserDialog({ user }: { user: { id: string; name: string; email: string } }) {
  return (
    <ActionDialog trigger={{ label: "Editar", icon: Pencil, variant: "ghost", size: "sm" }} title="Editar usuário" action={updateUserAction}>
      {(errors) => (
        <>
          <input type="hidden" name="userId" value={user.id} />
          <Field label="Nome completo" htmlFor={`name-${user.id}`} errors={errors.name}>
            <Input id={`name-${user.id}`} name="name" defaultValue={user.name} required maxLength={120} />
          </Field>
          <Field label="E-mail" htmlFor={`email-${user.id}`} errors={errors.email}>
            <Input id={`email-${user.id}`} name="email" type="email" defaultValue={user.email} required />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}

/** Alterar perfil (apenas ADMIN). */
export function ChangeRoleDialog({ user, teams }: { user: { id: string; name: string; role: UserRole }; teams: TeamOption[] }) {
  return (
    <ActionDialog
      trigger={{ label: "Perfil", icon: ShieldCheck, variant: "ghost", size: "sm" }}
      title={`Alterar perfil de ${user.name}`}
      description="O novo perfil vale a partir da próxima ação do usuário."
      action={changeUserRoleAction}
      submitLabel="Alterar perfil"
    >
      {(errors) => <ChangeRoleFields user={user} teams={teams} errors={errors} />}
    </ActionDialog>
  );
}

function ChangeRoleFields({
  user,
  teams,
  errors,
}: {
  user: { id: string; role: UserRole };
  teams: TeamOption[];
  errors: Record<string, string[]>;
}) {
  const [role, setRole] = useState<string>(user.role);
  return (
    <>
      <input type="hidden" name="userId" value={user.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Perfil" htmlFor={`role-${user.id}`} errors={errors.role}>
          <Select id={`role-${user.id}`} name="role" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        {role === "SELLER" && user.role !== "SELLER" && (
          <Field label="Equipe" htmlFor={`role-team-${user.id}`} errors={errors.teamId}>
            <Select id={`role-team-${user.id}`} name="teamId" defaultValue="">
              <option value="">Sem equipe</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {user.role === "SUPERVISOR" && role !== "SUPERVISOR" && (
        <p className="text-xs text-slate-500">Se este supervisor lidera uma equipe, defina antes outro supervisor para ela na tela Equipes.</p>
      )}
      {user.role === "SELLER" && role !== "SELLER" && (
        <p className="text-xs text-slate-500">Só é possível para vendedores sem leads, vendas ou metas registrados. O usuário sai da equipe.</p>
      )}
      {role === "SUPERVISOR" && user.role !== "SUPERVISOR" && (
        <p className="text-xs text-slate-500">Depois, vincule o supervisor a uma equipe na tela Equipes.</p>
      )}
    </>
  );
}

export function ResetPasswordDialog({ user }: { user: { id: string; name: string } }) {
  return (
    <ActionDialog
      trigger={{ label: "Senha", icon: KeyRound, variant: "ghost", size: "sm" }}
      title={`Redefinir senha de ${user.name}`}
      description="O usuário será desconectado de todas as sessões."
      action={resetPasswordAction}
      submitLabel="Redefinir senha"
    >
      {(errors) => (
        <>
          <input type="hidden" name="userId" value={user.id} />
          <Field label="Nova senha" htmlFor={`pwd-${user.id}`} errors={errors.password} hint="Mínimo de 12 caracteres, sem palavras óbvias.">
            <Input id={`pwd-${user.id}`} name="password" type="password" required minLength={12} autoComplete="new-password" />
          </Field>
        </>
      )}
    </ActionDialog>
  );
}
