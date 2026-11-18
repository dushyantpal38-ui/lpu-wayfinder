import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/app-icon";

// Home-screen icons for the web app manifest: /icons/192, /icons/512 and /icons/maskable (512, full bleed).
export const dynamic = "force-static";

export function generateStaticParams() {
  return [{ kind: "192" }, { kind: "512" }, { kind: "maskable" }];
}

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params; // Next.js 15: route params arrive as a promise
  const full = kind === "maskable";
  const px = kind === "192" ? 192 : 512;
  if (!full && kind !== "192" && kind !== "512") return new Response("Not found", { status: 404 });
  return new ImageResponse(<AppIcon size={px} full={full} />, { width: px, height: px });
}
