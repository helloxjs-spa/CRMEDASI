import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@/server/context";
import type { DatabaseHandle } from "@/server/db/connect";
import { createLead } from "@/server/modules/leads/leads.service";
import { createSale } from "@/server/modules/sales/sales.service";
import { createTestDatabase, seedOrganization } from "../support/db";
import { insertCourseWithCost, saleInput } from "../support/sales";

/**
 * Rota /vendas/[saleId]/comprovante chamada diretamente (como uma URL digitada
 * faria). Só a sessão é substituída: rota → serviço → banco são reais.
 */
const session = vi.hoisted(() => ({ current: null as ServiceContext | null }));
vi.mock("@/server/next/session", () => ({
  requireServiceContext: async () => {
    if (!session.current) throw new Error("sem sessão no teste");
    return session.current;
  },
}));

const { GET } = await import("@/app/(app)/vendas/[saleId]/comprovante/route");

let handle: DatabaseHandle;
let org: Awaited<ReturnType<typeof seedOrganization>>;
let withReceipt: string;
let withoutReceipt: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);
const get = (saleId: string, query = "") => GET(new Request(`http://localhost/vendas/${saleId}/comprovante${query}`), { params: Promise.resolve({ saleId }) });

beforeAll(async () => {
  handle = await createTestDatabase();
  org = await seedOrganization(handle);
  const course = await insertCourseWithCost(handle, "Pedagogia", 40_000);
  const seller = await org.ctx(org.ids.sellerA1);
  const lead = async (phone: string) => (await createLead(seller, { name: "Aluno", phone, interestCourseId: course })).id;
  withReceipt = (await createSale(seller, saleInput(await lead("(79) 99111-0001"), course, { receipt: { fileName: "Recibo São João.png", bytes: PNG } }))).saleId;
  withoutReceipt = (await createSale(seller, saleInput(await lead("(79) 99111-0002"), course))).saleId;
});
afterAll(() => handle.close());

describe("GET /vendas/[saleId]/comprovante", () => {
  it("devolve o arquivo com o tipo detectado, sem cache, para abrir ou baixar (nome com acento em filename*)", async () => {
    session.current = await org.ctx(org.ids.sellerA1);
    const response = await get(withReceipt);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `inline; filename="Recibo Sao Joao.png"; filename*=UTF-8''${encodeURIComponent("Recibo São João.png")}`,
    );
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...PNG]);

    const download = await get(withReceipt, "?download=1");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; /);
  });

  it("404 para quem não vê a venda, venda sem comprovante e id inválido", async () => {
    session.current = await org.ctx(org.ids.sellerB1);
    expect((await get(withReceipt)).status).toBe(404);
    session.current = await org.ctx(org.ids.admin);
    expect((await get(withoutReceipt)).status).toBe(404);
    expect((await get("nao-e-uuid")).status).toBe(404);
  });
});
