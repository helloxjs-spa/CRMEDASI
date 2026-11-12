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
   * Prazo de cada etapa de follow-up, em horas corridas a partir da entrada na
   * etapa (decisão C59, substitui as 8 h de C54): FUP 1 = 24 h, FUP 2 = 48 h,
   * FUP 3 = 72 h.
   */
  followUpDeadlineHours: { FOLLOW_UP_1: 24, FOLLOW_UP_2: 48, FOLLOW_UP_3: 72 },
  /**
   * Cor do card do Kanban por horas na etapa de follow-up (C59, substitui C55).
   * Vale a última faixa alcançada; o vermelho coincide com o fim do prazo.
   */
  followUpAlertSteps: {
    FOLLOW_UP_1: [{ afterHours: 24, alert: "red" }],
    FOLLOW_UP_2: [
      { afterHours: 24, alert: "orange" },
      { afterHours: 48, alert: "red" },
    ],
    FOLLOW_UP_3: [
      { afterHours: 24, alert: "yellow" },
      { afterHours: 48, alert: "orange" },
      { afterHours: 72, alert: "red" },
    ],
  },
  /** Prazo da negociação: 24 horas corridas desde a última atualização válida (§8). */
  negotiationDeadlineHours: 24,
} as const;
