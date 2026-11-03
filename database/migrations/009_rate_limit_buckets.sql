-- =============================================================================
-- 009_rate_limit_buckets.sql
-- CRM EDASI — contadores de tentativas compartilhados entre instâncias do Worker
--
-- Pré-requisitos: 001 a 008 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
--
-- Cria: rate_limit_buckets. Nenhuma tabela existente muda.
--
-- IMPLANTAR ANTES DO CÓDIGO que o utiliza: sem esta tabela, o login falha.
--
-- Janela fixa de 15 minutos por chave (conta, conta + IP, IP, reautenticação).
-- Os bloqueios vencem sozinhos: nada aqui trava uma conta de forma permanente.
-- `key` guarda o SHA-256 da chave, para não deixar e-mail nem IP nesta tabela.
-- Não é histórico: linhas vencidas são apagadas pela própria aplicação, e a
-- trilha de segurança continua em audit_events.
-- =============================================================================

BEGIN;

CREATE TABLE public.rate_limit_buckets (
  key               text PRIMARY KEY NOT NULL,
  attempts          integer NOT NULL,
  window_started_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT rate_limit_buckets_attempts_non_negative CHECK (attempts >= 0)
);

CREATE INDEX rate_limit_buckets_window_idx ON public.rate_limit_buckets USING btree (window_started_at);

-- Data API do Supabase: mesmo bloqueio das demais tabelas.
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_buckets FROM anon, authenticated;

COMMIT;
