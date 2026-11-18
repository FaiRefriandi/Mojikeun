import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moji Studio. Pixel emoji, painted in your browser.",
  description:
    "Describe an emoji and Tessera-small paints four 16 by 16 pixel versions, right in your browser. Edit a pixel, export a PNG, keep it yours.",
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
