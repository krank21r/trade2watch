import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/theme-provider";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Trade2watch — Multi-Asset Trade Setup",
  description:
    "Multi-asset (BTC/ETH) trade setup dashboard with live CoinGecko prices, zone alerts and position sizing. Technical analysis of public market data — not financial advice.",
  keywords: ["Trade2watch", "BTC", "ETH", "trade setup", "CoinGecko", "crypto"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Trade2watch — Multi-Asset Trade Setup",
    description: "Live trade setup dashboard for BTC and ETH",
    siteName: "Trade2watch",
    type: "website",
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
        className={`${inter.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
