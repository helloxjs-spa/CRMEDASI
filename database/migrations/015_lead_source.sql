-- =============================================================================
-- 015_lead_source.sql
-- CRM EDASI — origem do lead
--
-- Pré-requisitos: 001 a 014 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
-- Não altera nem remove nada existente; acrescenta um tipo, duas colunas
-- (aceitam NULL) em public.leads, uma CHECK, uma função e um trigger.
--
-- Regras:
--   - origens: Tráfego pago, Google, Indicação, Rechamada, Transferência
--     interna, Aluno e Outras campanhas;
--   - todo lead NOVO é cadastrado com a origem (obrigatória no INSERT);
--   - "Outras campanhas" exige o nome da campanha (source_detail, 1 a 120
--     caracteres); nas demais origens source_detail fica NULL;
--   - leads cadastrados antes desta migration ficam com source NULL ("Não
--     informada") até alguém editar o lead; depois de informada, a origem pode
--     ser trocada, mas não volta a ficar vazia.
--
-- SERVIÇO: origem obrigatória no cadastro e na edição (formulário), validação
-- da campanha e histórico (de/para no DETAILS_UPDATED) na mesma transação.
--
-- Ordem de implantação: implantar JUNTO do código da origem do lead. Depois
-- desta migration, a versão publicada não consegue CADASTRAR leads (o banco
-- recusa lead novo sem origem e ela não envia o campo); edição, Kanban,
-- listas e vendas continuam funcionando.
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

CREATE TYPE public.lead_source AS ENUM (
  'PAID_TRAFFIC',       -- Tráfego pago
  'GOOGLE',             -- Google
  'REFERRAL',           -- Indicação
  'CALLBACK',           -- Rechamada
  'INTERNAL_TRANSFER',  -- Transferência interna
  'STUDENT',            -- Aluno
  'OTHER_CAMPAIGN'      -- Outras campanhas (nome em source_detail)
);

ALTER TABLE public.leads
  ADD COLUMN source        public.lead_source,
  ADD COLUMN source_detail text;

-- Nome da campanha: presente se, e somente se, a origem é "Outras campanhas".
ALTER TABLE public.leads ADD CONSTRAINT leads_source_detail_consistent CHECK (
  (source IS NOT DISTINCT FROM 'OTHER_CAMPAIGN') = (source_detail IS NOT NULL)
  AND (source_detail IS NULL OR (btrim(source_detail) <> '' AND char_length(source_detail) <= 120))
);

-- Origem obrigatória no cadastro e, uma vez informada, nunca removida.
CREATE OR REPLACE FUNCTION public.check_lead_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.source IS NULL AND (TG_OP = 'INSERT' OR OLD.source IS NOT NULL) THEN
    RAISE EXCEPTION 'leads.source: informe a origem do lead';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_source_required
  BEFORE INSERT OR UPDATE OF source ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.check_lead_source();

REVOKE EXECUTE ON FUNCTION public.check_lead_source() FROM anon, authenticated, PUBLIC;

COMMIT;
