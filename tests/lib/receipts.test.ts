import { describe, expect, it } from "vitest";
import {
  cleanReceiptFileName,
  detectReceiptType,
  formatFileSize,
  MAX_RECEIPT_BYTES,
  RECEIPT_EMPTY,
  RECEIPT_INVALID_TYPE,
  RECEIPT_TOO_LARGE,
  receiptFileError,
} from "@/lib/receipts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("comprovante de pagamento (regras puras)", () => {
  it("tipo real pela assinatura do arquivo, não pela extensão", () => {
    expect(detectReceiptType(new TextEncoder().encode("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(detectReceiptType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe("image/jpeg");
    expect(detectReceiptType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(detectReceiptType(new TextEncoder().encode("<html><script>"))).toBeNull();
    expect(detectReceiptType(bytes(0x25, 0x50, 0x44))).toBeNull(); // PDF truncado
    expect(detectReceiptType(bytes())).toBeNull();
  });

  it("conferência no navegador: vazio, acima de 5 MB e tipo fora da lista", () => {
    expect(receiptFileError({ name: "a.pdf", size: 10, type: "application/pdf" })).toBeNull();
    expect(receiptFileError({ name: "FOTO.JPEG", size: 10, type: "" })).toBeNull();
    expect(receiptFileError({ name: "a.pdf", size: 0, type: "application/pdf" })).toBe(RECEIPT_EMPTY);
    expect(receiptFileError({ name: "a.pdf", size: MAX_RECEIPT_BYTES, type: "application/pdf" })).toBeNull();
    expect(receiptFileError({ name: "a.pdf", size: MAX_RECEIPT_BYTES + 1, type: "application/pdf" })).toBe(RECEIPT_TOO_LARGE);
    expect(receiptFileError({ name: "a.docx", size: 10, type: "application/msword" })).toBe(RECEIPT_INVALID_TYPE);
  });

  it("nome do arquivo: sem caminho nem controle, até 255 caracteres preservando a extensão", () => {
    expect(cleanReceiptFileName("C:\\fakepath\\Comprovante  Pix.pdf")).toBe("Comprovante Pix.pdf");
    expect(cleanReceiptFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanReceiptFileName("a\u0000b\nc.png")).toBe("abc.png");
    expect(cleanReceiptFileName("   ")).toBe("comprovante");
    const long = cleanReceiptFileName(`${"x".repeat(400)}.jpeg`);
    expect(long).toHaveLength(255);
    expect(long.endsWith(".jpeg")).toBe(true);
  });

  it("tamanho legível", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(830 * 1024)).toBe("830 KB");
    expect(formatFileSize(1.25 * 1024 * 1024)).toBe("1,3 MB");
  });
});
