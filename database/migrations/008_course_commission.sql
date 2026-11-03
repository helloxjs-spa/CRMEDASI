-- =============================================================================
-- 008_course_commission.sql
-- CRM EDASI — comissão por curso (substitui o valor fixo de R$ 100 por item)
--
-- Pré-requisitos: 001 a 007 executados. Executar UMA vez, pelo SQL Editor do
-- Supabase. Tudo roda numa única transação: se algo falhar, nada é alterado.
--
-- Altera: courses (+ coluna commission_cents). Nenhuma outra tabela muda.
--
-- Modelo: cada curso tem a própria comissão, em centavos, informada no cadastro.
-- Ao vender, o valor vigente do curso é copiado para
-- sale_items.commission_snapshot_cents, como já acontecia com o valor fixo:
-- alterar a comissão de um curso NÃO muda vendas já registradas.
--
-- Cursos que já existirem recebem R$ 100,00, o valor da regra anterior. Depois
-- o DEFAULT é removido: todo curso novo precisa informar a comissão.
--
-- Fica em courses, e não em course_costs: a comissão não é informação restrita
-- ao ADMIN (o vendedor já vê a própria comissão no dashboard e na venda).
-- =============================================================================

BEGIN;

ALTER TABLE public.courses ADD COLUMN commission_cents integer NOT NULL DEFAULT 10000;
ALTER TABLE public.courses ALTER COLUMN commission_cents DROP DEFAULT;
ALTER TABLE public.courses ADD CONSTRAINT courses_commission_non_negative CHECK (commission_cents >= 0);

COMMIT;
