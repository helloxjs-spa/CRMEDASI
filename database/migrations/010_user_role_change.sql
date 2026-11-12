-- =============================================================================
-- 010_user_role_change.sql
-- CRM EDASI — alteração do perfil (papel) de um usuário pelo ADMIN
--
-- Pré-requisitos: 001 a 009 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
--
-- ATENÇÃO: ALTERAÇÃO DESTRUTIVA (remoção de trigger de integridade).
--   Remove o trigger `users_role_immutable` e a função `forbid_role_change()`
--   do 001, que proibiam QUALQUER mudança de users.role. Eles são substituídos
--   por `users_role_change_guard`, que permite a mudança e recusa só os casos
--   que deixariam dados incoerentes (lista abaixo). Nenhuma tabela, coluna ou
--   dado é alterado. Risco: depois desta migration, quem tiver acesso direto
--   ao banco consegue trocar o papel de usuários sem histórico comercial; a
--   aplicação continua restringindo a operação ao ADMIN, com a senha dele.
--
-- Regras do banco (users_role_change_guard, BEFORE UPDATE OF role):
--   - SUPERVISOR que lidera uma equipe (teams.supervisor_id) não muda de papel:
--     o 001 exige que teams.supervisor_id aponte para um SUPERVISOR;
--   - SELLER com leads (owner_id), vendas (seller_id) ou metas (seller_id),
--     inclusive encerrados, estornados ou na Lixeira, não muda de papel: os
--     triggers do 002, 003 e 007 exigem que esses registros sejam de um SELLER;
--   - quem deixa de ser SELLER perde a equipe na mesma instrução
--     (CHECK users_only_sellers_have_team, do 001, inalterado).
--
-- O trigger roda depois que a linha do usuário está travada pelo UPDATE. As
-- operações que ligam um lead, uma venda ou uma equipe ao usuário leem essa
-- linha com FOR SHARE (002, 003 e serviço de equipes) e, portanto, esperam a
-- mudança de papel terminar (e então veem o papel novo) ou terminam antes (e
-- então são vistas aqui).
--
-- SERVIÇO: RBAC (users:manage, só ADMIN), senha de quem executa, proibição de
-- alterar o próprio papel e auditoria (user.role_changed) na mesma transação.
-- =============================================================================

BEGIN;

DROP TRIGGER users_role_immutable ON public.users;
DROP FUNCTION public.forbid_role_change();

CREATE OR REPLACE FUNCTION public.check_user_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  IF OLD.role = 'SUPERVISOR' AND EXISTS (SELECT 1 FROM public.teams WHERE supervisor_id = OLD.id) THEN
    RAISE EXCEPTION 'users.role: supervisor que lidera uma equipe não muda de papel; defina outro supervisor para a equipe antes';
  END IF;

  IF OLD.role = 'SELLER' AND (
       EXISTS (SELECT 1 FROM public.leads WHERE owner_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.sales WHERE seller_id = OLD.id)
    OR EXISTS (SELECT 1 FROM public.seller_goals WHERE seller_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'users.role: vendedor com leads, vendas ou metas não muda de papel';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER users_role_change_guard
  BEFORE UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.check_user_role_change();

REVOKE EXECUTE ON FUNCTION public.check_user_role_change() FROM anon, authenticated, PUBLIC;

COMMIT;
