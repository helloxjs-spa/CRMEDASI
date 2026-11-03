/**
 * Parâmetros de negócio centralizados. Nenhum destes valores deve ser repetido
 * em outros pontos do código: importe daqui.
 *
 * Nas fases de Vendas/Kanban, os valores que o cliente quiser alterar pela
 * interface migrarão para uma tabela de configurações, com o valor vigente
 * copiado (snapshot) em cada registro gerado. A comissão não fica aqui: é de
 * cada curso (`courses.commission_cents`) e é copiada em sale_items na venda.
 */
export const BUSINESS_RULES = {
  /** Fuso único para "dia", vencimentos e filtros de período (Documento Mestre §25). */
  timezone: "America/Sao_Paulo",
  /**
   * Prazo de cada etapa de follow-up: 8 horas corridas a partir da entrada na
   * etapa (decisão C54, substitui o "1 dia" do Documento Mestre §7).
   */
  followUpDeadlineHours: 8,
  /** Horas na etapa de follow-up a partir das quais o card do Kanban fica amarelo (C55). */
  followUpWarningHours: 6,
  /** Prazo da negociação: 24 horas corridas desde a última atualização válida (§8). */
  negotiationDeadlineHours: 24,
} as const;
