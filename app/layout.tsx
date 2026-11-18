import type { Metadata, Viewport } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });
// Block numbers are set in a condensed signage face, like the numbers on campus signboards.
const sign = Barlow_Condensed({ subsets: ["latin"], weight: ["600", "700"], variable: "--font-sign" });

export const metadata: Metadata = {
  title: "LPU Wayfinder",
  description: "Find any block on the LPU campus by number, room or name, and walk there with a live map.",
  applicationName: "LPU Wayfinder",
  appleWebApp: { capable: true, title: "Wayfinder", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#09090B" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${sign.variable}`}>
      <body className={inter.className}>{children}</body>
    </html>
  );
}
