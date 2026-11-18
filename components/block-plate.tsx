import { MapPin, Trees, UtensilsCrossed } from "lucide-react";
import { isNamed } from "@/lib/campus";
import { cn } from "@/lib/utils";

/**
 * A block number set like a campus signboard. "solid" (sky) marks the block you picked;
 * "quiet" is for lists. Named places without a number get an icon for their kind: a tree for parks,
 * a fork and knife for food, a pin for anything else (Unipolis, say).
 */
export function BlockPlate({ num, size = "md", tone = "quiet", category, className }: {
  num: string;
  size?: "sm" | "md" | "lg";
  tone?: "solid" | "quiet";
  category?: string;
  className?: string;
}) {
  const box = { sm: "h-7 w-7 rounded-lg", md: "h-11 w-11 rounded-xl", lg: "h-14 w-14 rounded-2xl" }[size];
  const text = { sm: "text-[15px]", md: "text-[22px]", lg: "text-[30px]" }[size];
  const icon = { sm: "h-3.5 w-3.5", md: "h-5 w-5", lg: "h-6 w-6" }[size];
  const Icon = category === "park" ? Trees : category === "food" ? UtensilsCrossed : MapPin;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        box,
        tone === "solid"
          ? "bg-sky-500 text-white shadow-[inset_0_-2px_0_rgba(0,0,0,0.2)]"
          : "bg-white/[0.06] text-sky-200 ring-1 ring-inset ring-white/10",
        className,
      )}
    >
      {isNamed(num) ? (
        <Icon className={icon} />
      ) : (
        <span className={cn("font-sign font-bold leading-none", text, num.length > 2 && "tracking-tight")}>{num}</span>
      )}
    </span>
  );
}
