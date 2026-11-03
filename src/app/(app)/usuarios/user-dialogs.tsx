"use client";

import { KeyRound, Pencil, Plus, Power } from "lucide-react";
import { useState } from "react";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Field, Input, Select } from "@/components/ui/form";
import { ROLE_LABELS } from "@/lib/format";
import { createUserAction, resetPasswordAction, setUserActiveAction, updateUserAction } from "./actions";

type TeamOption = { id: string; name: string };

/** Reautenticação de quem executa a operação sensível; o servidor é quem a exige. */
function ActorPasswordField({ id, errors, required = true, hint }: { id: string; errors: Record<string, string[]>; required?: boolean; hint?: string }) {
  return (
    <Field label="Sua senha" htmlFor={`actor-password-${id}`} errors={errors.actorPassword} hint={hint ?? "Confirme a sua senha para concluir esta operação."}>
      <Input id={`actor-password-${id}`} name="actorPassword" type="password" required={required} autoComplete="current-password" />
    </Field>
  );
}

export function CreateUserDialog({ teams }: { teams: TeamOption[] }) {
  return (
    <ActionDialog trigger={{ label: "Novo usuário", icon: Plus }} title="Novo usuário" action={createUserAction} submitLabel="Criar usuário">
      {(errors) => <CreateUserFields teams={teams} errors={errors} />}
    </ActionDialog>
  );
}

function CreateUserFields({ teams, errors }: { teams: TeamOption[]; errors: Record<string, string[]> }) {
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
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
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
      {role === "ADMIN" && <ActorPasswordField id="new-user" errors={errors} />}
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
          <ActorPasswordField id={user.id} errors={errors} required={false} hint="Sua senha: obrigatória somente ao alterar o e-mail." />
        </>
      )}
    </ActionDialog>
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
          <ActorPasswordField id={user.id} errors={errors} />
        </>
      )}
    </ActionDialog>
  );
}

/** Ativar ou desativar outro ADMIN pede a senha de quem executa. */
export function SetAdminActiveDialog({ user }: { user: { id: string; name: string; active: boolean } }) {
  const verb = user.active ? "Desativar" : "Reativar";
  return (
    <ActionDialog
      trigger={{ label: verb, icon: Power, variant: user.active ? "ghost" : "secondary", size: "sm" }}
      title={`${verb} ${user.name}`}
      description={user.active ? "O acesso será bloqueado imediatamente." : undefined}
      action={setUserActiveAction}
      submitLabel={verb}
    >
      {(errors) => (
        <>
          <input type="hidden" name="userId" value={user.id} />
          <input type="hidden" name="active" value={String(!user.active)} />
          <ActorPasswordField id={`active-${user.id}`} errors={errors} />
        </>
      )}
    </ActionDialog>
  );
}
