import type { MetadataRoute } from "next";

// Lets students add LPU Wayfinder to their home screen and open it like an app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LPU Wayfinder",
    short_name: "Wayfinder",
    description: "Find any block on the LPU campus by number, room or name, and walk there with a live map.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090B",
    theme_color: "#09090B",
    categories: ["navigation", "education"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
