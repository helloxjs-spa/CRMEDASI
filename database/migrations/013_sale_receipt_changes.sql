-- =============================================================================
-- 013_sale_receipt_changes.sql
-- CRM EDASI — anexar, trocar e remover o comprovante de pagamento depois do
-- registro da venda (edição da venda)
--
-- Pré-requisitos: 012 executado. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
--
-- Regras novas:
--   - a venda tem no máximo UM comprovante ATUAL (removed_at IS NULL);
--   - remover = marcar removed_at/removed_by (sem exclusão física: o arquivo
--     removido fica como histórico, como os demais registros de negócio);
--   - trocar = remover o atual e incluir o novo, na mesma transação;
--   - a única alteração permitida numa linha é essa marcação, uma vez;
--     nome, tipo, tamanho, conteúdo, venda, autor e criação continuam
--     imutáveis; removed_at é carimbado pelo banco.
--
-- ATENÇÃO: ALTERAÇÃO DESTRUTIVA (remoção de constraint e de trigger).
--   - Remove a UNIQUE sale_receipts_sale_unique (um comprovante por venda,
--     012) e a substitui pelo índice único PARCIAL
--     sale_receipts_current_unique (um comprovante ATUAL por venda). Os dados
--     existentes atendem às duas (nenhum tem removed_at).
--   - Remove o trigger sale_receipts_immutable (012), que proibia UPDATE e
--     DELETE, e o substitui por sale_receipts_no_delete (DELETE continua
--     proibido) e sale_receipts_before_update (só a marcação de remoção).
--   Nenhum dado é alterado ou apagado. Risco: depois desta migration, quem
--   tiver acesso direto ao banco consegue marcar um comprovante como removido;
--   o arquivo continua guardado.
--
-- SERVIÇO: RBAC e escopo (os mesmos da edição da venda), conferência do
-- arquivo e auditoria (sale.receipt_attached / sale.receipt_removed) na
-- mesma transação.
--
-- Ordem de implantação: pode ser executada ANTES do código novo — a versão
-- publicada continua funcionando (registro com comprovante, abrir e baixar).
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. Colunas da remoção
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_receipts ADD COLUMN removed_at timestamp with time zone;  -- carimbado pelo banco
ALTER TABLE public.sale_receipts ADD COLUMN removed_by uuid;
ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_removed_by_users_id_fk
  FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_removed_consistent
  CHECK ((removed_at IS NULL) = (removed_by IS NULL));

-- -----------------------------------------------------------------------------
-- 2. Um comprovante ATUAL por venda (o histórico pode ter vários)
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_receipts DROP CONSTRAINT sale_receipts_sale_unique;
CREATE UNIQUE INDEX sale_receipts_current_unique ON public.sale_receipts USING btree (sale_id)
  WHERE removed_at IS NULL;
CREATE INDEX sale_receipts_sale_idx ON public.sale_receipts USING btree (sale_id);

-- -----------------------------------------------------------------------------
-- 3. Imutabilidade: só a marcação de remoção, uma vez; sem DELETE/TRUNCATE
-- -----------------------------------------------------------------------------
DROP TRIGGER sale_receipts_immutable ON public.sale_receipts;

CREATE TRIGGER sale_receipts_no_delete
  BEFORE DELETE ON public.sale_receipts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
-- sale_receipts_no_truncate (012) continua valendo.

-- INSERT: nasce atual (sem remoção); created_at do banco.
CREATE OR REPLACE FUNCTION public.sale_receipt_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.removed_at IS NOT NULL OR NEW.removed_by IS NOT NULL THEN
    RAISE EXCEPTION 'sale_receipts: comprovante nasce atual, sem remoção';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

-- UPDATE: só atual → removido (removed_by obrigatório; removed_at do banco).
CREATE OR REPLACE FUNCTION public.sale_receipt_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sale_receipts: arquivo, venda, autor e criação são imutáveis';
  END IF;
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'sale_receipts: comprovante removido é imutável';
  END IF;
  IF NEW.removed_by IS NULL THEN
    RAISE EXCEPTION 'sale_receipts: a única alteração permitida é a remoção, com quem removeu';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_receipts_before_update
  BEFORE UPDATE ON public.sale_receipts
  FOR EACH ROW EXECUTE FUNCTION public.sale_receipt_before_update();

-- -----------------------------------------------------------------------------
-- 4. Data API do Supabase: a tabela já tem RLS + REVOKE (012); funções novas
-- sem EXECUTE para anon/authenticated.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.sale_receipt_before_insert(), public.sale_receipt_before_update()
  FROM anon, authenticated, PUBLIC;

COMMIT;
