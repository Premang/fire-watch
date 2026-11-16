import type { Metadata } from "next";
import "./globals.css";
import "./prediction.css";
import "./atlas.css";

export const metadata: Metadata = {
  title: "Fire Watch · Harmonized MODIS + VIIRS Burning Calendar",
  description: "26 years of NASA MODIS and VIIRS fire hotspots, harmonized onto one consistent scale. Pick any area on Earth to see its burning calendar, anomalies against the historical median, and download the evidence.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
