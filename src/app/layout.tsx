import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { Toaster } from "@/components/ui/toast";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Sans geométrica pesada, próxima à do logotipo "EDASI"; só para a marca.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "CRM EDASI", template: "%s · CRM EDASI" },
  description: "Gestão comercial do Grupo EDASI",
  applicationName: "CRM EDASI",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#121d39" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} h-full`}>
      <body className="min-h-full">
        <Toaster>{children}</Toaster>
      </body>
    </html>
  );
}
