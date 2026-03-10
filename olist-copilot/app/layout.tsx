import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3000"),
  title: {
    default: "AI Analytics Copilot",
    template: "%s | AI Analytics Copilot",
  },
  description:
    "Natural-language analytics assistant for Olist e-commerce metrics with grounded, SQL-backed answers.",
  applicationName: "AI Analytics Copilot",
  keywords: [
    "AI analytics",
    "Olist dataset",
    "business intelligence",
    "semantic layer",
    "RAG",
    "Next.js",
  ],
  openGraph: {
    title: "AI Analytics Copilot",
    description:
      "Ask business questions in plain English and get grounded answers backed by governed SQL metrics.",
    siteName: "AI Analytics Copilot",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Analytics Copilot",
    description:
      "Natural-language analytics on governed Olist metrics with SQL transparency and hallucination guardrails.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
