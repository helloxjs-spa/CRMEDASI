import type { Metadata } from "next";
import { BarChart3, Lock, ShieldCheck, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { EdasiLogo, EdasiMark, EdasiWordmark } from "@/components/brand/edasi";
import { getCurrentActor } from "@/server/next/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

const highlights = [
  { icon: Users, text: "Equipes, vendedores e leads em um só lugar" },
  { icon: BarChart3, text: "Indicadores e ranking por vendedor e equipe" },
  { icon: ShieldCheck, text: "Acesso controlado por perfil e histórico completo" },
];

/** Login em tela dividida: marca à esquerda (telas grandes) e formulário à direita. */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getCurrentActor()) redirect("/");
  // O ?next= vem das páginas protegidas (proxy e requireActor).
  const { next } = await searchParams;

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-linear-to-br from-brand-950 via-brand-900 to-brand-700 px-12 py-14 text-white lg:flex lg:flex-col lg:justify-between xl:px-24">
        {/* "E" da marca como forma decorativa à direita. */}
        <EdasiMark className="pointer-events-none absolute -right-40 top-1/2 size-[48rem] -translate-y-1/2 opacity-[0.07]" />

        <div className="relative">
          <EdasiLogo className="max-w-[20rem]" priority />
          <span className="mt-4 block h-1 w-24 rounded-full bg-accent-400" aria-hidden />
          <p className="mt-4 text-base tracking-[0.06em] text-white/90">Educação, Segurança e Inovação em Saúde</p>
        </div>

        <div className="relative max-w-xl">
          <p className="font-heading text-sm font-bold tracking-[0.2em] text-accent-400">CRM COMERCIAL</p>
          <h1 className="mt-3 max-w-[32rem] font-heading text-[2rem] font-extrabold leading-[1.2] tracking-[-0.01em]">
            Disciplina comercial do primeiro contato <span className="text-accent-400">à matrícula.</span>
          </h1>
          <ul className="mt-6 space-y-3">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-4 text-white/95">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/20">
                  <Icon className="size-5" aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative max-w-sm border-t border-white/15 pt-6">
          <p className="flex items-center gap-3 text-sm text-white/85">
            <Lock className="size-5" aria-hidden />
            Uso interno · acesso restrito a colaboradores
          </p>
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-[26rem]">
          <EdasiWordmark tone="dark" className="mb-8 text-3xl lg:hidden" />
          <h2 className="text-[1.75rem] font-semibold tracking-tight text-slate-900">Entrar no CRM</h2>
          <p className="mt-1 text-[0.95rem] text-slate-500">Use o e-mail e a senha fornecidos pelo administrador.</p>
          <LoginForm next={typeof next === "string" ? next : ""} />
        </div>
      </section>
    </main>
  );
}
