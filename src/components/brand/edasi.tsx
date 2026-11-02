import Image from "next/image";
import { cn } from "@/lib/cn";
import logo from "@/assets/brand/edasi-logo.png";
import mark from "@/assets/brand/edasi-mark.png";

/*
 * Marca do Grupo EDASI. As imagens são brancas sobre fundo transparente
 * (geradas a partir de src/assets/brand/source/edasi-logo-original.jpg): use
 * sempre sobre fundo azul-marinho (`bg-brand-800` ou mais escuro).
 * `unoptimized`: PNGs pequenos e estáticos, sem depender do otimizador de
 * imagens no Worker da Cloudflare.
 */

/** Letra "E" isolada (ícone da marca). O tamanho vem de `className` (ex.: `size-10`). */
export function EdasiMark({ className, decorative = true }: { className: string; decorative?: boolean }) {
  return <Image src={mark} alt={decorative ? "" : "Grupo EDASI"} unoptimized className={cn("select-none", className)} />;
}

/** Logo completo: "GRUPO EDASI" + "Educação, Segurança e Inovação em Saúde". */
export function EdasiLogo({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src={logo} alt="Grupo EDASI" unoptimized priority={priority} className={cn("h-auto w-full select-none", className)} />;
}

/** Nome em texto, no estilo do logotipo, para tamanhos em que a imagem ficaria ilegível. */
export function EdasiWordmark({ className, tone = "light" }: { className?: string; tone?: "light" | "dark" }) {
  return (
    <span className={cn("block font-display leading-none", tone === "light" ? "text-white" : "text-brand-800", className)}>
      <span className="block text-[0.42em] font-semibold tracking-[0.5em]">GRUPO</span>
      <span className="mt-1 block font-extrabold tracking-[0.02em]">EDASI</span>
    </span>
  );
}
