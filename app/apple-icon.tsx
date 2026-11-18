import { ImageResponse } from "next/og";
import { AppIcon } from "@/components/app-icon";

// The icon iPhones use when the site is added to the home screen.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={180} full />, size);
}
