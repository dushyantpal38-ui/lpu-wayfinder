import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/app-icon";

// The browser tab icon.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<AppIcon size={64} />, size);
}
