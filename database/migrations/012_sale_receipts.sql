-- =============================================================================
-- 012_sale_receipts.sql
-- CRM EDASI — comprovante de pagamento da venda (opcional)
--
-- Pré-requisitos: 001 a 003 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
-- Não altera tabelas, funções ou dados existentes; acrescenta uma tabela, uma
-- função e triggers novos.
--
-- Regras:
--   - no máximo UM comprovante por venda, enviado no registro da venda;
--   - PDF, JPG ou PNG, de 1 byte a 5 MB (5.242.880 bytes);
--   - o arquivo fica no próprio banco (bytea), numa tabela separada de sales
--     para que as listagens de vendas não leiam o conteúdo;
--   - registro imutável e sem exclusão física (como os demais registros de
--     negócio); created_at é do banco.
--
-- SERVIÇO: RBAC e escopo (quem vê a venda vê o comprovante), conferência do
-- tipo real do arquivo pela assinatura (não só pela extensão) e auditoria
-- (sale.receipt_attached) na mesma transação do registro da venda.
--
-- Ordem de implantação: pode ser executada ANTES do código novo — a versão
-- publicada continua funcionando (só não oferece o campo). O código novo
-- precisa desta migration: sem ela, o registro de venda falha.
-- =============================================================================

BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. Tabela
-- -----------------------------------------------------------------------------
CREATE TABLE public.sale_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sale_id       uuid NOT NULL,
  file_name     text NOT NULL,                                     -- nome original (exibição/download)
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  content       bytea NOT NULL,
  uploaded_by   uuid NOT NULL,
  created_at    timestamp with time zone DEFAULT now() NOT NULL,   -- carimbado pelo banco
  CONSTRAINT sale_receipts_sale_unique UNIQUE (sale_id),
  CONSTRAINT sale_receipts_file_name_present CHECK (btrim(file_name) <> '' AND char_length(file_name) <= 255),
  CONSTRAINT sale_receipts_content_type_allowed CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  CONSTRAINT sale_receipts_size_limit CHECK (size_bytes BETWEEN 1 AND 5242880 AND octet_length(content) = size_bytes)
);

ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_sale_id_sales_id_fk
  FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE public.sale_receipts ADD CONSTRAINT sale_receipts_uploaded_by_users_id_fk
  FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

-- -----------------------------------------------------------------------------
-- 2. Imutável, sem exclusão; created_at do banco
-- -----------------------------------------------------------------------------
CREATE TRIGGER sale_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.sale_receipts
  FOR EACH ROW EXECUTE FUNCTION public.forbid_operation();
CREATE TRIGGER sale_receipts_no_truncate
  BEFORE TRUNCATE ON public.sale_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_operation();

CREATE OR REPLACE FUNCTION public.sale_receipt_before_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER sale_receipts_before_insert
  BEFORE INSERT ON public.sale_receipts
  FOR EACH ROW EXECUTE FUNCTION public.sale_receipt_before_insert();

-- -----------------------------------------------------------------------------
-- 3. Bloqueio da Data API do Supabase (PostgREST), como no 001–009:
-- RLS ligado SEM políticas + REVOKE para anon/authenticated.
-- -----------------------------------------------------------------------------
ALTER TABLE public.sale_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_receipts FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sale_receipt_before_insert() FROM anon, authenticated, PUBLIC;

COMMIT;
