import { ForbiddenError } from "@/server/errors";
import type { UserRole } from "@/server/db/schema";
import type { Actor } from "./actor";

/**
 * Matriz RBAC central (Documento Mestre §4.4). Responde apenas "este PAPEL pode
 * executar esta AÇÃO?". Se o registro específico está no escopo do ator
 * (ownership / equipe) é decidido em ./scope.ts.
 *
 * Itens marcados "Não confirmado" no Documento Mestre ficam NEGADOS até
 * decisão do cliente (ver docs/ARQUITETURA.md, Dúvidas).
 *
 * Decisões do cliente que corrigem o Documento Mestre (docs/ARQUITETURA.md §8):
 * - Somente SELLER possui carteira comercial: o responsável de lead e de venda
 *   é sempre um SELLER (C5).
 * - Vendas (C36, substitui C1): SELLER, SUPERVISOR e ADMIN registram (o
 *   responsável escolhido é sempre um vendedor); SUPERVISOR e ADMIN estornam
 *   e reativam e escolhem a data da venda.
 * - SUPERVISOR com as permissões do ADMIN (decisão do cliente, 2026-11-06),
 *   exceto: a Auditoria e tudo que dá ou mexe em acesso de ADMIN (criar ADMIN,
 *   alterar perfil e editar, redefinir senha ou ativar/desativar um ADMIN).
 *   O escopo de dados também é o da empresa toda (./scope.ts).
 */
const MATRIX = {
  // Organização (fase 1)
  "users:manage": ["ADMIN", "SUPERVISOR"],
  /** Criar ADMIN e editar, redefinir senha ou ativar/desativar um ADMIN. */
  "users:manageAdmins": ["ADMIN"],
  /** Alterar o perfil (papel) de um usuário. */
  "users:changeRole": ["ADMIN"],
  "users:view": ["ADMIN", "SUPERVISOR"],
  "teams:manage": ["ADMIN", "SUPERVISOR"],
  "teams:view": ["ADMIN", "SUPERVISOR"],
  "audit:view": ["ADMIN"],

  // Comercial (fases seguintes; declarado aqui para manter a matriz única)
  /** Ver leads: sempre combinado com o escopo (próprios / equipe / todos). */
  "leads:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Cadastrar lead: SELLER na própria carteira; SUPERVISOR/ADMIN escolhem o vendedor responsável (C41). */
  "leads:create": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Editar nome, telefone e curso de interesse: sempre combinado com o escopo. */
  "leads:edit": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Observações: quem opera o lead (o vendedor responsável). */
  "leads:addNote": ["SELLER"],
  /** Movimentar etapas no Kanban: só quem tem carteira (decisão C5). */
  "leads:move": ["SELLER"],
  "leads:transfer": ["ADMIN", "SUPERVISOR"],
  "leads:redistribute": ["ADMIN", "SUPERVISOR"],
  "leads:trash": ["ADMIN", "SUPERVISOR"],
  "leads:restore": ["ADMIN", "SUPERVISOR"],
  /** Ver vendas: sempre combinado com o escopo (próprias / equipe ATUAL do responsável / todas). */
  "sales:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /**
   * Registrar venda (C36). Quem pode ser o responsável é decidido no serviço:
   * SELLER escolhe a si ou um colega ativo da própria equipe; SUPERVISOR e
   * ADMIN, qualquer vendedor ativo; nunca vendedor de equipe inativa.
   */
  "sales:create": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Informar/alterar a data da venda (os demais registram com a data de hoje no fuso do negócio). */
  "sales:setDate": ["ADMIN", "SUPERVISOR"],
  /** Editar venda no escopo: incluir cursos (itens) com preço. */
  "sales:edit": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Remover cursos, corrigir preços, forma de pagamento e parcelas (o total é sempre a soma dos itens). */
  "sales:editFinancial": ["ADMIN", "SUPERVISOR"],
  /** Trocar o vendedor responsável (o lead acompanha se a venda for válida). */
  "sales:changeSeller": ["ADMIN", "SUPERVISOR"],
  /** Corrigir venda estornada (para o vendedor ela é somente leitura). */
  "sales:editReversed": ["ADMIN", "SUPERVISOR"],
  /** Estornar e reativar (Etapa 3b; motivo obrigatório). */
  "sales:reverse": ["ADMIN", "SUPERVISOR"],
  "sales:reactivate": ["ADMIN", "SUPERVISOR"],
  /** Ver parcelas: sempre combinado com o escopo (vendedor vê as das próprias vendas). */
  "installments:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Confirmar recebimento: quem vendeu não confirma sozinho (segregação de funções). */
  "installments:markPaid": ["ADMIN", "SUPERVISOR"],
  /** Lista operacional de cursos ATIVOS, sem custo (usada em leads e vendas). */
  "courses:list": ["ADMIN", "SUPERVISOR", "SELLER"],
  "courses:manage": ["ADMIN", "SUPERVISOR"],
  "courses:viewCost": ["ADMIN", "SUPERVISOR"],
  "finance:viewCostAndProfit": ["ADMIN", "SUPERVISOR"],
  "certificates:operate": ["ADMIN", "SUPERVISOR", "SELLER"],
  "ranking:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  "reports:export": ["ADMIN", "SUPERVISOR"],
  /** Card "Resultado do mês": todos veem o resultado e a meta de todos os vendedores (decisão do cliente). */
  "goals:view": ["ADMIN", "SUPERVISOR", "SELLER"],
  /** Definir meta mensal de qualquer vendedor ativo. */
  "goals:manage": ["ADMIN", "SUPERVISOR"],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof MATRIX;

export function hasPermission(actor: Pick<Actor, "role">, permission: Permission): boolean {
  return (MATRIX[permission] as readonly UserRole[]).includes(actor.role);
}

export function assertPermission(actor: Pick<Actor, "role">, permission: Permission): void {
  if (!hasPermission(actor, permission)) throw new ForbiddenError();
}
