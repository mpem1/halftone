import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Halftone Studio",
  description:
    "Browser-based halftone screen room: dots, lines, diamonds and CMYK separations with Photoshop-style Frequency (LPI) and Angle controls. Continuous tone in, print-ready 1-bit dots out.",
  keywords: ["halftone", "screen printing", "CMYK separation", "LPI", "halftone dots", "Next.js", "Canvas"],
  authors: [{ name: "mpem1" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Halftone Studio",
    description: "Print-ready halftones, screened entirely in your browser",
    siteName: "Halftone Studio",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Halftone Studio",
    description: "Print-ready halftones, screened entirely in your browser",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
