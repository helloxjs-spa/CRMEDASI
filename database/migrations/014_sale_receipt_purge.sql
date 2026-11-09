-- =============================================================================
-- 014_sale_receipt_purge.sql
-- CRM EDASI — comprovante removido ou trocado: o arquivo é apagado, o registro
-- fica (decisão do cliente, 2026-11-09)
--
-- Pré-requisitos: 012 e 013 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
--
-- Regras novas:
--   - comprovante atual (removed_at IS NULL) tem sempre o arquivo;
--   - comprovante removido NÃO tem arquivo: na remoção, o próprio banco apaga
--     o conteúdo (content = NULL), qualquer que seja o caminho da remoção;
--   - continuam guardados: nome, tipo, tamanho, venda, quem anexou e quando,
--     quem removeu e quando (histórico), e a auditoria da aplicação.
--
-- ATENÇÃO: ALTERAÇÃO DESTRUTIVA (apaga dados; remove constraint e NOT NULL).
--   - Apaga o conteúdo dos comprovantes JÁ removidos, se houver (esperado:
--     nenhum, pois a aplicação ainda não remove comprovantes). O arquivo
--     apagado não pode ser recuperado.
--   - content deixa de ser NOT NULL; a CHECK sale_receipts_size_limit (012) é
--     recriada aceitando conteúdo vazio só em comprovante removido.
--   - A função sale_receipt_before_update (013) é substituída: a remoção
--     passa a apagar o conteúdo; o resto da regra é igual.
--   Espaço: o PostgreSQL reaproveita o espaço liberado depois do autovacuum;
--   o tamanho total exibido pelo Supabase pode não diminuir na hora.
--
-- Ordem de implantação: pode ser executada ANTES do código novo — a versão
-- publicada continua funcionando (ela não remove comprovantes).
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. Remoção apaga o conteúdo
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sale_receipt_before_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.sale_id IS DISTINCT FROM OLD.sale_id
     OR NEW.file_name IS DISTINCT FROM OLD.file_name OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR (NEW.content IS NOT NULL AND NEW.content IS DISTINCT FROM OLD.content)
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
  NEW.content := NULL;  -- o arquivo removido não fica guardado
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. Conteúdo opcional só para comprovante removido
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_receipts ALTER COLUMN content DROP NOT NULL;

-- Comprovantes já removidos (esperado: nenhum): apaga o conteúdo. O trigger
-- de UPDATE recusa alterar comprovante removido; fica desligado só aqui.
ALTER TABLE public.sale_receipts DISABLE TRIGGER sale_receipts_before_update;
UPDATE public.sale_receipts SET content = NULL WHERE removed_at IS NOT NULL;
ALTER TABLE public.sale_receipts ENABLE TRIGGER sale_receipts_before_update;

ALTER TABLE public.sale_receipts DROP CONSTRAINT sale_receipts_size_limit;
ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_size_limit
  CHECK (size_bytes BETWEEN 1 AND 5242880 AND (content IS NULL OR octet_length(content) = size_bytes));
ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_content_only_current
  CHECK ((removed_at IS NULL) = (content IS NOT NULL));

REVOKE EXECUTE ON FUNCTION public.sale_receipt_before_update() FROM anon, authenticated, PUBLIC;

COMMIT;
