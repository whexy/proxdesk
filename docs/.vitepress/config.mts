import { defineConfig } from "vitepress";

const repo = "https://github.com/whexy/proxdesk";

export default defineConfig({
  title: "Proxdesk",
  description: "Self-service portal for shared Proxmox VMs",
  cleanUrls: true,
  // The docs show local addresses, such as the demo server, as links.
  ignoreDeadLinks: "localhostLinks",
  srcExclude: ["node_modules/**"],
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/icon.svg" }]],
  themeConfig: {
    logo: "/icon.svg",
    search: { provider: "local" },
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "Introduction", link: "/" },
          { text: "Install", link: "/install" },
          { text: "Connect Proxmox", link: "/proxmox" },
          { text: "Single sign-on", link: "/sso" },
          { text: "Chat bot", link: "/chat" },
        ],
      },
      {
        text: "Run it",
        items: [
          { text: "Operations", link: "/operations" },
          { text: "Back up and restore", link: "/backups" },
          { text: "Troubleshooting", link: "/troubleshooting" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/configuration" },
          { text: "Command line", link: "/cli" },
          { text: "Architecture and security", link: "/architecture" },
          { text: "Extending Proxdesk", link: "/extending" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    outline: [2, 3],
  },
});
