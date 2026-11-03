import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

/**
 * Erros de banco sem dados. O erro padrão do Drizzle traz os parâmetros da
 * consulta na mensagem (hash de senha, e-mail, telefone...) e o do driver traz
 * valores em `detail`; qualquer log do erro, inclusive os do próprio Next em
 * páginas, os levaria junto. Por isso a limpeza é feita onde o erro nasce.
 * Ficam código (SQLSTATE), constraint, tabela e o SQL com placeholders.
 */
const SENSITIVE_DRIVER_FIELDS = ["detail", "hint", "where", "internalQuery", "query", "params", "queryOptions"] as const;

/** Mensagens que não carregam valores: integridade (classe 23), transação (40) e triggers do projeto (P0001). */
const SAFE_MESSAGE_CODE = /^(23|40|P0001)/;

type DriverError = Error & { code?: string; [field: string]: unknown };

function replaceMessage(error: Error, message: string): void {
  if (error.stack) error.stack = error.stack.replace(error.message, message);
  error.message = message;
}

function scrubDriverError(cause: unknown): void {
  if (!(cause instanceof Error)) return;
  const error = cause as DriverError;
  for (const field of SENSITIVE_DRIVER_FIELDS) if (field in error) error[field] = undefined;
  if (typeof error.code === "string" && !SAFE_MESSAGE_CODE.test(error.code)) replaceMessage(error, `Erro de banco (SQLSTATE ${error.code})`);
}

export function scrubQueryError(error: unknown): void {
  if (!(error instanceof DrizzleQueryError)) return;
  replaceMessage(error, `Failed query: ${error.query}`);
  error.params = [];
  scrubDriverError(error.cause);
}

let installed = false;

/** Vale para todas as consultas do processo (PostgreSQL e PGlite herdam de PgPreparedQuery). */
export function installQueryErrorScrubber(): void {
  if (installed) return;
  installed = true;
  const prototype = PgPreparedQuery.prototype as unknown as { queryWithCache: (...args: unknown[]) => Promise<unknown> };
  const original = prototype.queryWithCache;
  prototype.queryWithCache = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      scrubQueryError(error);
      throw error;
    }
  };
}

/** Só o necessário para diagnóstico: nome, código, constraint, tabela e operação (ex.: "insert users"). */
export function safeErrorSummary(error: unknown): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const current = e as { name?: unknown; code?: unknown; constraint?: unknown; table?: unknown; query?: unknown };
    if (depth === 0 && typeof current.name === "string") summary.name = current.name;
    for (const field of ["code", "constraint", "table"] as const) {
      if (typeof current[field] === "string" && summary[field] === undefined) summary[field] = current[field];
    }
    if (typeof current.query === "string" && summary.operation === undefined) {
      const verb = current.query.trim().split(/\s+/)[0]?.toLowerCase();
      const table = /\b(?:from|into|update)\s+"?(\w+)"?/i.exec(current.query)?.[1];
      summary.operation = table ? `${verb} ${table}` : verb;
    }
  }
  return summary;
}
