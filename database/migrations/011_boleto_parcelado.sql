
BEGIN;

-- Não esperar indefinidamente por travas em produção: falha e nada muda.
SET LOCAL lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. Novo valor do enum
-- -----------------------------------------------------------------------------
ALTER TYPE public.payment_method ADD VALUE 'BOLETO';

-- -----------------------------------------------------------------------------
-- 2. Parcelas obrigatórias para toda forma que não é Pix
-- -----------------------------------------------------------------------------
ALTER TABLE public.sales DROP CONSTRAINT sales_installments_consistent;
ALTER TABLE public.sales ADD CONSTRAINT sales_installments_consistent CHECK (
  (payment_method = 'PIX' AND installment_count IS NULL)
  OR (payment_method <> 'PIX' AND installment_count IS NOT NULL AND installment_count >= 1)
);

-- -----------------------------------------------------------------------------
-- 3. Cronograma (006): cartão e boleto têm parcelas; Pix não
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_installment_schedule(target_sale uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  s       public.sales;
  n       integer;
  total   bigint;
  share   integer;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = target_sale;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*), coalesce(sum(amount_cents), 0) INTO n, total
    FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL;

  IF s.payment_method = 'PIX' THEN
    IF n <> 0 THEN
      RAISE EXCEPTION 'venda % no Pix não tem parcelas', target_sale;
    END IF;
    RETURN;
  END IF;

  IF n <> s.installment_count OR total <> s.total_cents THEN
    RAISE EXCEPTION 'venda %: o cronograma de parcelas deve ter % parcelas somando o total da venda', target_sale, s.installment_count;
  END IF;
  share := s.total_cents / s.installment_count;
  IF EXISTS (
    SELECT 1 FROM public.installments i
     WHERE i.sale_id = target_sale AND i.replaced_at IS NULL
       AND (i.number > s.installment_count
            OR i.due_date <> (s.sale_date + make_interval(months => i.number))::date
            OR i.amount_cents <> CASE WHEN i.number = 1 THEN s.total_cents - (s.installment_count - 1) * share ELSE share END)
  ) THEN
    RAISE EXCEPTION 'venda %: número, valor ou vencimento de parcela fora da regra (C52)', target_sale;
  END IF;
  IF s.status = 'ACTIVE' AND EXISTS (
    SELECT 1 FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL AND status = 'CANCELED'
  ) THEN
    RAISE EXCEPTION 'venda % válida não pode ter parcela cancelada no cronograma atual', target_sale;
  END IF;
  IF s.status = 'REVERSED' AND EXISTS (
    SELECT 1 FROM public.installments WHERE sale_id = target_sale AND replaced_at IS NULL AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'venda % estornada não pode ter parcela em aberto', target_sale;
  END IF;
END;
$$;

-- CREATE OR REPLACE preserva os privilégios; reforço igual ao 006.
REVOKE EXECUTE ON FUNCTION public.assert_installment_schedule(uuid) FROM anon, authenticated, PUBLIC;

COMMIT;
