-- =============================================================================
-- 007_seller_goals.sql
-- CRM EDASI — metas mensais de faturamento por vendedor (card "Resultado do mês")
--
-- Pré-requisitos: 001 a 006 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é criado.
-- Não altera nenhuma tabela, função ou dado existente.
--
-- Cria: seller_goals (+ 1 função de trigger).
--
-- Modelo: uma meta (em centavos, faturamento de vendas válidas) por vendedor
-- por mês. A meta do "time inteiro" não é gravada: é a soma das metas dos
-- vendedores do mês. `month` é sempre o primeiro dia do mês.
--
-- Divisão de responsabilidades:
--   BANCO   — uma meta por vendedor e mês, valor positivo, responsável sempre
--             SELLER, sem exclusão física, vendedor/mês/autor/criação imutáveis.
--   SERVIÇO — RBAC (goals:manage: ADMIN qualquer vendedor; SUPERVISOR só os
--             vendedores atualmente na equipe que lidera) e auditoria
--             (audit_events) na mesma transação.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------
CREATE TABLE public.seller_goals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  seller_id     uuid NOT NULL,                                     -- imutável
  month         date NOT NULL,                                     -- 1º dia do mês; imutável
  target_cents  integer NOT NULL,                                  -- meta de faturamento, em centavos
  created_by    uuid NOT NULL,                                     -- imutável
  updated_by    uuid NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,   -- imutável
  updated_at    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT seller_goals_seller_month_unique UNIQUE (seller_id, month),
  CONSTRAINT seller_goals_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT seller_goals_target_positive CHECK (target_cents > 0)
);

-- -----------------------------------------------------------------------------
-- 2. Foreign keys (RESTRICT: nada comercial/histórico é apagado em cascata)
-- -----------------------------------------------------------------------------
ALTER TABLE public.seller_goals ADD CONSTRAINT seller_goals_seller_id_users_id_fk
  FOREIGN KEY (seller_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.seller_goals ADD CONSTRAINT seller_goals_created_by_users_id_fk
  FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.seller_goals ADD CONSTRAINT seller_goals_updated_by_users_id_fk
  FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 3. Índices (o card lê todas as metas de um mês)
-- -----------------------------------------------------------------------------
CREATE INDEX seller_goals_month_idx ON public.seller_goals USING btree (month);

-- -----------------------------------------------------------------------------
-- 4. Triggers
-- -----------------------------------------------------------------------------
-- Sem exclusão física (reusa forbid_operation do 002).
CREATE TRIGGER seller_goals_no_delete
  BEFORE DELETE ON public.seller_goals
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER seller_goals_no_truncate
  BEFORE TRUNCATE ON public.seller_goals
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

-- Meta só de vendedor (SELLER); vendedor, mês, autor e criação são imutáveis.
CREATE OR REPLACE FUNCTION public.check_seller_goal() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
       OR NEW.month IS DISTINCT FROM OLD.month
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'seller_goals: id, seller_id, month, created_by e created_at são imutáveis';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM public.users WHERE id = NEW.seller_id AND role = 'SELLER') THEN
    RAISE EXCEPTION 'seller_goals: a meta deve ser de um usuário SELLER';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER seller_goals_guard
  BEFORE INSERT OR UPDATE ON public.seller_goals
  FOR EACH ROW EXECUTE FUNCTION public.check_seller_goal();

-- -----------------------------------------------------------------------------
-- 5. Bloqueio da Data API do Supabase (PostgREST), como no 001–006:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.seller_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_goals FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_seller_goal() FROM anon, authenticated, PUBLIC;

COMMIT;
