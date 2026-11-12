import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toCsv } from "@/lib/csv";
import { login } from "@/server/auth/auth.service";
import { isCommonPassword } from "@/server/auth/password-policy";
import { safeNextPath } from "@/server/auth/safe-next-path";
import type { DatabaseHandle } from "@/server/db/connect";
import { safeErrorSummary } from "@/server/db/safe-errors";
import { auditEvents, users } from "@/server/db/schema";
import { createLead } from "@/server/modules/leads/leads.service";
import { getSaleInstallments, listInstallments, markInstallmentPaid } from "@/server/modules/installments/installments.service";
import { buildReport } from "@/server/modules/reports/reports.service";
import { COMMISSION_EXCEEDS_TOTAL, createSale, getSale, updateSale } from "@/server/modules/sales/sales.service";
import {
  ADMIN_ACCOUNT_FORBIDDEN,
  changeUserRole,
  createUser,
  resetUserPassword,
  SELF_RESET_FORBIDDEN,
  setUserActive,
  updateUser,
} from "@/server/modules/users/users.service";
import { toErrorState } from "@/server/next/action";
import { passwordSchema } from "@/server/validation";
import { createTestDatabase, seedOrganization, TEST_PASSWORD, insertUser } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let course: string;
let nextPhone = 79_991_000_000;
const phone = () => String(nextPhone++);

const auditCount = async (action: string) =>
  (await handle.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(eq(auditEvents.action, action)))[0].n;

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  course = await insertCourseWithCost(handle, "Enfermagem", 30_000);
}, 120_000);
afterAll(() => handle.close());

describe("SEC-01: política de senha", () => {
  it("política de senha: 12 caracteres e sem senhas comuns", () => {
    for (const weak of ["curta123", "12345678901", "123456789012", "qwertyuiopas", "Senha@2026123", "Admin1234567", "aaaaaaaaaaaaaa", "abcdabcdabcd", "administrador", "edasi1234567", "Senha Senha!"]) {
      expect(passwordSchema.safeParse(weak).success, weak).toBe(false);
    }
    for (const strong of ["cavalo-bateria-grampo", "Tr3s tigres tristes", "nova-senha-longa-987"]) {
      expect(passwordSchema.safeParse(strong).success, strong).toBe(true);
      expect(isCommonPassword(strong)).toBe(false);
    }
  });
});

describe("SEC-03: destino depois do login", () => {
  it.each([
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "\t//evil.example",
    "/\t\\evil.example",
    "https://evil.example",
    "http:evil.example",
    "javascript:alert(1)",
    "/%2F/evil.example",
    "/%252F/evil.example",
    "/%5Cevil.example",
    "/%09/evil.example",
    "/%0a/evil.example",
    "/..//evil.example",
    "/././/evil.example",
    "/x/..//evil.example",
    "/leads\u0000",
    "/%E0%A4%A",
    "",
  ])("recusa %j", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it.each([
    ["/", "/"],
    ["/leads", "/leads"],
    ["/relatorios/exportar?tipo=leads", "/relatorios/exportar?tipo=leads"],
    ["/leads?q=ana%20souza&pagina=2", "/leads?q=ana%20souza&pagina=2"],
    ["/vendas/123#parcelas", "/vendas/123#parcelas"],
  ])("aceita %j", (value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });
});

describe("SEC-11: login concorrente com redefinição de senha", () => {
  it("a sessão aberta com a senha antiga durante o reset não é criada", async () => {
    const email = "corrida.reset@teste.local";
    const userId = await insertUser(handle, { name: "Corrida Reset", role: "SELLER", teamId: org.ids.teamA, email });
    const admin = await org.ctx(org.ids.admin);
    // O reset acontece entre a conferência da senha e a criação da sessão.
    const realTransaction = handle.db.transaction.bind(handle.db);
    let raced = false;
    const racing = new Proxy(handle.db, {
      get(target, property) {
        if (property === "transaction" && !raced) {
          raced = true;
          return async (...args: Parameters<typeof realTransaction>) => {
            await resetUserPassword(admin, userId, { password: "senha-nova-do-reset" });
            return realTransaction(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(login(racing, { email, password: TEST_PASSWORD })).rejects.toThrow("E-mail ou senha inválidos.");
    await expect(login(handle.db, { email, password: "senha-nova-do-reset" })).resolves.toHaveProperty("token");
  }, 60_000);

  it("usuário desativado no meio do login também não recebe sessão", async () => {
    const email = "corrida.ativo@teste.local";
    const userId = await insertUser(handle, { name: "Corrida Ativo", role: "SELLER", teamId: org.ids.teamA, email });
    const admin = await org.ctx(org.ids.admin);
    const realTransaction = handle.db.transaction.bind(handle.db);
    let raced = false;
    const racing = new Proxy(handle.db, {
      get(target, property) {
        if (property === "transaction" && !raced) {
          raced = true;
          return async (...args: Parameters<typeof realTransaction>) => {
            await setUserActive(admin, userId, false);
            return realTransaction(...args);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(login(racing, { email, password: TEST_PASSWORD })).rejects.toThrow("E-mail ou senha inválidos.");
  }, 60_000);
});

describe("SEC-02: comissão não passa do valor da venda (SELLER)", () => {
  // Comissão de teste por item: R$ 100,00.
  const items = (count: number, priceCents: number) => Array.from({ length: count }, () => ({ courseId: course, priceCents }));
  const newLead = async (userId: string) => (await createLead(await org.ctx(userId), { name: "Lead Comissao", phone: phone(), source: "GOOGLE", interestCourseId: course })).id;

  it("SELLER: recusa 100 itens a R$ 0,01 e nada é gravado; aceita comissão igual ao total", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const lead = await newLead(org.ids.sellerA1);
    const input = saleInput(lead, course, { items: items(100, 1) });
    await expect(createSale(seller, input)).rejects.toThrow(COMMISSION_EXCEEDS_TOTAL);
    await expect(getSale(await org.ctx(org.ids.admin), input.requestId)).rejects.toThrow("Registro não encontrado");

    const { saleId } = await createSale(seller, saleInput(lead, course, { items: items(2, 10_000) }));
    const sale = await getSale(seller, saleId);
    expect(sale).toMatchObject({ totalCents: 20_000, commissionTotalCents: 20_000 });
  }, 60_000);

  it("SELLER: incluir cursos também respeita a trava, somando os itens que já estão na venda", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course, { items: items(1, 10_000) }));
    const { version } = await getSale(seller, saleId);
    await expect(updateSale(seller, saleId, { expectedVersion: version, addItems: items(1, 9_999) })).rejects.toThrow(COMMISSION_EXCEEDS_TOTAL);
    expect((await getSale(seller, saleId)).totalCents).toBe(10_000);
    await updateSale(seller, saleId, { expectedVersion: version, addItems: items(1, 10_000) });
    expect(await getSale(seller, saleId)).toMatchObject({ totalCents: 20_000, commissionTotalCents: 20_000 });
  }, 60_000);

  it("o mesmo curso pode repetir, e a fórmula da comissão não muda", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const { saleId } = await createSale(seller, saleInput(await newLead(org.ids.sellerA1), course, { items: items(3, 50_000) }));
    expect(await getSale(seller, saleId)).toMatchObject({ totalCents: 150_000, commissionTotalCents: 30_000 });
  }, 60_000);

  it("SUPERVISOR e ADMIN não têm a trava", async () => {
    const lead = await newLead(org.ids.sellerA1);
    const { saleId } = await createSale(await org.ctx(org.ids.supA), saleInput(lead, course, { sellerId: org.ids.sellerA1, items: items(1, 1) }));
    expect(await getSale(await org.ctx(org.ids.admin), saleId)).toMatchObject({ totalCents: 1, commissionTotalCents: 10_000 });
  }, 60_000);
});

describe("SEC-05: baixa de parcelas", () => {
  it("vendedor consulta, mas não confirma; qualquer supervisor confirma, uma vez, com auditoria", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const lead = await createLead(seller, { name: "Lead Parcela", phone: phone(), source: "GOOGLE", interestCourseId: course });
    const { saleId } = await createSale(seller, saleInput(lead.id, course, { paymentMethod: "CARD", installmentCount: 2 }));
    const [first] = await getSaleInstallments(seller, saleId);
    expect((await listInstallments(seller, {})).total).toBeGreaterThan(0);

    await expect(markInstallmentPaid(seller, { installmentId: first.id })).rejects.toThrow("permissão");

    // Supervisor de outra equipe: escopo da empresa (decisão de 2026-11-06).
    const before = await auditCount("installment.paid");
    const supervisorB = await org.ctx(org.ids.supB);
    await markInstallmentPaid(supervisorB, { installmentId: first.id });
    await expect(markInstallmentPaid(await org.ctx(org.ids.supA), { installmentId: first.id })).rejects.toThrow("já está paga");
    expect((await auditCount("installment.paid")) - before).toBe(1);
    expect((await getSaleInstallments(seller, saleId))[0].status).toBe("PAID");
  }, 60_000);
});

describe("SEC-04: auditoria de exportações", () => {
  it("uma exportação gera um evento, com tipo, filtros e quantidade, sem dados pessoais", async () => {
    const seller = await org.ctx(org.ids.sellerA1);
    const leadPhone = phone();
    await createLead(seller, { name: "Maria Sensivel", phone: leadPhone, source: "GOOGLE", interestCourseId: course });
    const supervisor = await org.ctx(org.ids.supA);
    const before = await auditCount("report.exported");
    const report = await buildReport(supervisor, "leads", { status: "ACTIVE", dateFrom: "2020-01-01" });
    expect((await auditCount("report.exported")) - before).toBe(1);

    const [event] = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, "report.exported")).orderBy(sql`${auditEvents.id} desc`).limit(1);
    expect(event.actorId).toBe(org.ids.supA);
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.metadata).toEqual({ reportType: "leads", filters: { status: "ACTIVE", dateFrom: "2020-01-01" }, rowCount: report.rows.length });
    expect(JSON.stringify(event)).not.toMatch(new RegExp(`Maria|${leadPhone.slice(-8)}`));
  });

  it("exportação recusada ou inválida não gera evento", async () => {
    const before = await auditCount("report.exported");
    await expect(buildReport(await org.ctx(org.ids.sellerA1), "leads", {})).rejects.toThrow("permissão");
    await expect(buildReport(await org.ctx(org.ids.supA), "leads", { status: "INVALIDO" })).rejects.toThrow();
    expect(await auditCount("report.exported")).toBe(before);
  });
});

describe("SEC-06: contas ADMIN", () => {
  let victimId: string;
  let otherAdmin: string;
  beforeAll(async () => {
    victimId = await insertUser(handle, { name: "Conta Alvo", role: "SELLER", teamId: org.ids.teamA, email: "conta.alvo@teste.local" });
    otherAdmin = await insertUser(handle, { name: "Outro Admin", role: "ADMIN", email: "outro.admin@teste.local" });
  });
  const newPassword = "senha-nova-administrativa";

  it("o fluxo administrativo não redefine a própria senha", async () => {
    const admin = await org.ctx(org.ids.admin);
    await expect(resetUserPassword(admin, org.ids.admin, { password: newPassword })).rejects.toThrow(SELF_RESET_FORBIDDEN);
  });

  it("redefinir senha e trocar e-mail ficam auditados", async () => {
    const admin = await org.ctx(org.ids.admin);
    await resetUserPassword(admin, victimId, { password: newPassword });
    expect(await auditCount("user.password_reset")).toBeGreaterThan(0);
    await updateUser(admin, victimId, { email: "novo.alvo@teste.local" });
    const [event] = await handle.db.select().from(auditEvents).where(eq(auditEvents.action, "user.updated")).orderBy(sql`${auditEvents.id} desc`).limit(1);
    expect((event.metadata as { changes: { email: unknown } }).changes.email).toEqual({ from: "conta.alvo@teste.local", to: "novo.alvo@teste.local" });
  }, 60_000);

  it("SUPERVISOR não cria nem altera conta ADMIN (senão entraria como ele)", async () => {
    const supervisor = await org.ctx(org.ids.supA);
    const asAdmin = ADMIN_ACCOUNT_FORBIDDEN;
    await expect(resetUserPassword(supervisor, otherAdmin, { password: newPassword })).rejects.toThrow(asAdmin);
    await expect(updateUser(supervisor, otherAdmin, { email: "tomada@teste.local" })).rejects.toThrow(asAdmin);
    await expect(updateUser(supervisor, otherAdmin, { name: "Outro nome" })).rejects.toThrow(asAdmin);
    await expect(setUserActive(supervisor, otherAdmin, false)).rejects.toThrow(asAdmin);
    await expect(createUser(supervisor, { name: "Admin Novo", email: "admin.novo@teste.local", password: newPassword, role: "ADMIN" })).rejects.toThrow(asAdmin);
    await expect(changeUserRole(supervisor, victimId, { role: "ADMIN" })).rejects.toThrow("permissão");
    const [row] = await handle.db.select().from(users).where(eq(users.id, otherAdmin));
    expect(row).toMatchObject({ role: "ADMIN", active: true, email: "outro.admin@teste.local", name: "Outro Admin" });
    expect((await handle.db.select().from(users).where(eq(users.id, victimId)))[0].role).toBe("SELLER");
  });

  it("SUPERVISOR gerencia contas que não são ADMIN", async () => {
    const supervisor = await org.ctx(org.ids.supA);
    await resetUserPassword(supervisor, victimId, { password: newPassword });
  });
});

describe("SEC-12: logs sem dados sensíveis", () => {
  const SECRET_HASH = "scrypt$32768$8$1$c2FsdA==$aGFzaA==";
  const insertInvalid = () => handle.db.insert(users).values({ name: "Maria Sensivel", email: "MAIUSCULA@TESTE.LOCAL", passwordHash: SECRET_HASH, role: "SELLER" });

  it("o erro da consulta não leva parâmetros, nem na mensagem nem na pilha", async () => {
    const error = (await insertInvalid().catch((e) => e)) as Error & { params?: unknown[]; cause?: Record<string, unknown> };
    for (const text of [error.message, error.stack ?? "", JSON.stringify(error.params), String(error.cause?.message), String(error.cause?.detail)]) {
      expect(text).not.toContain(SECRET_HASH);
      expect(text).not.toContain("MAIUSCULA");
      expect(text).not.toContain("Maria");
    }
    expect(error.cause?.code).toBe("23514");
  });

  it("detail do driver (com valores) é apagado em violação de unicidade", async () => {
    const error = (await handle.db.insert(users).values({ name: "Duplicado", email: "vendedor.a1@teste.local", passwordHash: SECRET_HASH, role: "SELLER" }).catch((e) => e)) as Error & { cause?: Record<string, unknown> };
    expect(error.cause?.detail).toBeUndefined();
    expect(error.cause?.code).toBe("23505");
    expect(error.message + String(error.stack)).not.toContain("vendedor.a1");
  });

  it("valor no texto do banco (tipo inválido) não aparece", async () => {
    const error = (await handle.db.execute(sql`select ${"maria@segredo.local"}::uuid`).catch((e) => e)) as Error & { cause?: Error };
    expect(`${error.message} ${error.stack} ${error.cause?.message} ${error.cause?.stack}`).not.toContain("maria@segredo.local");
  });

  it("toErrorState registra só o diagnóstico útil, e o cliente recebe mensagem genérica", async () => {
    const error = await insertInvalid().catch((e) => e);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = toErrorState(error);
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(state).toMatchObject({ status: "error", message: "Erro inesperado. Tente novamente." });
    expect(logged).not.toContain(SECRET_HASH);
    expect(logged).not.toContain("MAIUSCULA");
    expect(safeErrorSummary(error)).toMatchObject({ code: "23514", operation: "insert users", constraint: "users_email_lowercase" });
  });
});

describe("SEC-13: CSV", () => {
  const cells = (value: string) => toCsv([], [[value]]).slice(1).split("\r\n").filter(Boolean).join("|");

  it("fórmula depois de separador fica neutralizada, mesmo em Excel com outro separador", () => {
    expect(cells("x,=1+1")).toBe(`"x,'=1+1"`);
    expect(cells("x;=1+1")).toBe(`"x;'=1+1"`);
    expect(cells("a|@cmd")).toBe("a|'@cmd");
    expect(cells(" =1+1")).toBe("' =1+1");
    expect(cells("＝1+1")).toBe("'＝1+1");
    expect(cells("Administração, Direito")).toBe(`"Administração, Direito"`);
  });
});

describe("SEC-08: guarda do build", () => {
  const guard = path.resolve("scripts/cf-guard.mjs");
  const run = (cwd: string, command: string) => {
    try {
      return { code: 0, output: execFileSync(process.execPath, [guard, command], { cwd, encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      return { code: failure.status, output: failure.stderr };
    }
  };
  const project = (files: Record<string, string>) => {
    const dir = mkdtempSync(path.join(tmpdir(), `cf-guard-${randomUUID().slice(0, 8)}-`));
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };
  const SECRET = "SenhaFicticiaDoTeste9876";
  const URL_WITH_SECRET = `postgresql://postgres.ref:${SECRET}@aws-0-sa.pooler.supabase.com:5432/postgres`;
  const emptyEnv = 'export const production = {};\nexport const development = {};\nexport const test = {};\n';
  const clean = { ".open-next/worker.js": "export default {};", ".open-next/cloudflare/next-env.mjs": emptyEnv };
  const dirs: string[] = [];
  const temp = (files: Record<string, string>) => {
    const dir = project(files);
    dirs.push(dir);
    return dir;
  };
  afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  it("preflight recusa .env com variável privada, sem mostrar o valor; aceita pasta limpa", () => {
    const blocked = run(temp({ ".env": `DATABASE_URL=${URL_WITH_SECRET}\nSESSION_TTL_HOURS=12\n` }), "preflight");
    expect(blocked.code).toBe(1);
    expect(blocked.output).toContain("DATABASE_URL");
    expect(blocked.output).not.toContain(SECRET);
    expect(blocked.output).not.toContain("SESSION_TTL_HOURS");
    expect(run(temp({ ".env.example": "DATABASE_URL=postgresql://x:y@z/w\n", ".env": "SESSION_TTL_HOURS=12\n" }), "preflight").code).toBe(0);
  });

  it("verify aceita o artefato limpo e exige que ele exista", () => {
    expect(run(temp(clean), "verify").code).toBe(0);
    expect(run(temp({}), "verify").code).toBe(1);
  });

  it.each([
    ["variável em next-env", { ".open-next/cloudflare/next-env.mjs": `export const production = {"DATABASE_URL":"${URL_WITH_SECRET}"};\n` }],
    ["connection string no worker", { ".open-next/worker.js": `const a = "${URL_WITH_SECRET}";` }],
    ["arquivo .env copiado", { ".open-next/server-functions/default/.env": "X=1\n" }],
    ["host do pooler em outro arquivo", { ".open-next/assets/_next/x.js": "aws-0-sa.pooler.supabase.com" }],
  ])("verify bloqueia: %s", (_label, extra) => {
    const result = run(temp({ ...clean, ...extra }), "verify");
    expect(result.code).toBe(1);
    expect(result.output).toContain("NÃO publique");
    expect(result.output).not.toContain(SECRET);
  });

  it("verify encontra o valor literal do .env local, mesmo fora de um formato conhecido", () => {
    const result = run(temp({ ...clean, ".env": `MINHA_CHAVE=${SECRET}\n`, ".open-next/server-functions/default/handler.mjs": `const a = "${SECRET}";` }), "verify");
    expect(result.code).toBe(1);
    expect(result.output).toContain("MINHA_CHAVE");
    expect(result.output).not.toContain(SECRET);
  });
});
