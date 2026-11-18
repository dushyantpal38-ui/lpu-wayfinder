"use client";

import * as React from "react";
import { Navigation, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CampusMap } from "@/components/campus-map";
import { useCampus } from "@/components/campus-provider";
import { searchBlocks } from "@/lib/campus";
import { cn } from "@/lib/utils";

// The globe explorer layout, with the LPU campus map in place of the globe:
// block list (and a search bar the same width) on the left, the campus map on the right.
// Scrolling the list, or tapping a block, highlights that building on the map and flies to it.

export type InteractiveCampusExplorerProps = {
  initialNum?: string;
  /** Called when the visitor presses "Navigate" on a block. */
  onNavigate?: (num: string) => void;
  className?: string;
};

export function InteractiveCampusExplorer({ initialNum = "34", onNavigate, className }: InteractiveCampusExplorerProps) {
  const { blocks, loading } = useCampus();
  const [query, setQuery] = React.useState("");
  const [activeNum, setActiveNum] = React.useState<string | null>(initialNum);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const programmatic = React.useRef(false);
  const settle = React.useRef<number | undefined>(undefined);

  const list = React.useMemo(() => searchBlocks(blocks, query), [blocks, query]);
  const active = blocks.find((b) => b.num === activeNum) || null;

  // Jump to a block in the list (centres it), without the scroll handler fighting back.
  const centre = React.useCallback((num: string, smooth = true) => {
    const el = itemRefs.current[num];
    if (!el) return;
    programmatic.current = true;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
    window.setTimeout(() => { programmatic.current = false; }, 900);
  }, []);

  // Start on the first block of the project: block 34.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current || !list.length) return;
    started.current = true;
    if (initialNum) window.setTimeout(() => centre(initialNum, false), 50);
  }, [list, initialNum, centre]);

  // When the search changes, show the best match.
  React.useEffect(() => {
    if (!started.current || !query) return;
    if (list[0]) { setActiveNum(list[0].num); scrollRef.current?.scrollTo({ top: 0 }); }
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = React.useCallback(() => {
    const container = scrollRef.current;
    if (programmatic.current || !container) return;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const box = container.getBoundingClientRect();
      const mid = container.clientHeight / 2;
      let best: string | null = null, min = Infinity;
      for (const b of list) {
        const el = itemRefs.current[b.num];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top - box.top + r.height / 2 - mid);
        if (d < min) { min = d; best = b.num; }
      }
      if (best) setActiveNum(best);
    }, 120);
  }, [list]);

  return (
    <div
      className={cn(
        "relative flex h-[820px] w-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-950 text-white shadow-[0_30px_120px_-80px_rgba(14,165,233,0.7)] md:h-[700px] md:flex-row",
        className,
      )}
    >
      {/* Left: search bar on top of the block list, both the same width */}
      <div className="relative z-10 flex h-[46%] w-full flex-col md:h-auto md:w-[42%] md:min-w-[300px] md:max-w-[500px]">
        <div className="px-5 pb-3 pt-5 sm:px-8 md:px-12 lg:px-16">
          <label className="flex h-12 items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900 px-4 focus-within:border-sky-500/70">
            <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search block number or name"
              aria-label="Search a block number or name"
              inputMode="search"
              className="h-full w-full bg-transparent text-base text-white outline-none placeholder:text-zinc-500"
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="text-zinc-400 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            )}
          </label>
        </div>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex flex-1 flex-col items-start overflow-y-auto px-5 py-[120px] [scrollbar-width:none] sm:px-8 md:px-12 md:py-[240px] lg:px-16 [&::-webkit-scrollbar]:hidden"
        >
          {loading && !list.length && <p className="text-zinc-500">Loading blocks…</p>}
          {!loading && !list.length && <p className="text-zinc-500">No block matches “{query}”.</p>}
          {list.map((b) => {
            const on = b.num === activeNum;
            return (
              <button
                key={b.num}
                ref={(el) => { itemRefs.current[b.num] = el; }}
                type="button"
                onClick={() => { setActiveNum(b.num); centre(b.num); }}
                className={cn(
                  "flex items-baseline gap-3 py-2 text-left font-medium tracking-tight transition-all duration-500 ease-out md:py-3",
                  on ? "translate-x-1 text-sky-500" : "text-white/20 hover:text-white/40",
                )}
              >
                <span className="w-10 shrink-0 text-lg tabular-nums md:w-12 md:text-xl">{b.num}</span>
                <span className="text-2xl md:text-3xl lg:text-4xl">{b.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right: the campus map where the globe was */}
      <div className="relative h-[54%] w-full md:h-auto md:flex-1">
        <CampusMap mode="preview" activeNum={activeNum} onPickBlock={(n) => { setActiveNum(n); setQuery(""); window.setTimeout(() => centre(n), 80); }} />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-zinc-950 via-zinc-950/40 to-transparent md:bg-gradient-to-r md:from-zinc-950 md:via-zinc-950/60" style={{ maxHeight: "45%" }} />
        {active && (
          <div className="absolute inset-x-4 bottom-4 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-zinc-900/90 p-4 backdrop-blur md:inset-x-auto md:right-4 md:w-80">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-wider text-zinc-400">Block {active.num}</p>
              <p className="truncate text-lg font-semibold">{active.name}</p>
              <p className="text-xs text-zinc-400">
                {!active.placed ? "Not placed on the map yet" : active.draft ? "Position is a guess until checked on campus" : "Position confirmed"}
              </p>
            </div>
            {onNavigate && active.placed && (
              <Button size="icon" className="shrink-0 rounded-full bg-sky-500 text-white hover:bg-sky-400" onClick={() => onNavigate(active.num)} aria-label={`Navigate to block ${active.num}`}>
                <Navigation className="h-5 w-5" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default InteractiveCampusExplorer;
