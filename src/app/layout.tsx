import type { Metadata, Viewport } from "next";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: "#f2efe9",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://mojikeun-morphkite-projects.vercel.app"),
  title: "Moji Studio. Pixel emoji, painted in your browser.",
  description:
    "Describe an emoji and Tessera-small paints four 16 by 16 pixel versions, right in your browser. Edit a pixel, export a PNG, keep it yours.",
  icons: { icon: { url: "/favicon.svg", type: "image/svg+xml" } },
  openGraph: {
    title: "Moji Studio. Pixel emoji, painted in your browser.",
    description:
      "Describe an emoji and Tessera-small paints four 16 by 16 pixel versions, right in your browser.",
    images: [{ url: "https://huggingface.co/Morphkite/Mojikeun/resolve/main/og-crab.png", width: 128, height: 128, alt: "A red crab waving, painted by Moji Studio" }],
  },
  twitter: {
    card: "summary",
    title: "Moji Studio. Pixel emoji, painted in your browser.",
    description:
      "Describe an emoji and Tessera-small paints four 16 by 16 pixel versions, right in your browser.",
    images: ["https://huggingface.co/Morphkite/Mojikeun/resolve/main/og-crab.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
