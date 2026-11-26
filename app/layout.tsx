import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Proxdesk · VM self-service",
  description: "Your virtual machines, console, and access controls.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
