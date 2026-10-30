import type { Metadata } from "next";
import { Geist_Mono, Source_Sans_3, Roboto_Slab } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const robotoSlabHeading = Roboto_Slab({ subsets: ["latin"], variable: "--font-roboto-slab" });

const sourceSans3 = Source_Sans_3({ subsets: ["latin"], variable: "--font-source-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fakturan",
  description: "Jednoduchá fakturace pro české OSVČ",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="cs"
      className={cn(
        "h-full",
        "antialiased",
        geistMono.variable,
        "font-sans",
        sourceSans3.variable,
        robotoSlabHeading.variable,
      )}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
