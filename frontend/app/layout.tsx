import type {Metadata} from "next";
import "./globals.css";
import {WalletProvider} from "@/lib/wallet";

export const metadata: Metadata = {
  title: "ArrowHead — MEV terminal",
  description: "Live multi-chain MEV searcher: sandwich, JIT, atomic arb, liquidation — the seed is the soak",
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("ah-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}`,
          }}
        />
      </head>
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
