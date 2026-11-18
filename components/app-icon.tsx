// The app icon: a white map pin on a sky plate. Drawn as an image by next/og, so there is no image file to keep.

const PIN = "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0";

/**
 * size: the image's width and height in pixels.
 * full: fill the whole square with sky (maskable icons and the Apple icon, which the system rounds itself).
 */
export function AppIcon({ size, full = false }: { size: number; full?: boolean }) {
  const plate = full ? size : Math.round(size * 0.84);
  const pin = Math.round(size * (full ? 0.46 : 0.5));
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", background: full ? "#0EA5E9" : "transparent" }}>
      <div
        style={{
          width: plate,
          height: plate,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0EA5E9",
          borderRadius: full ? 0 : Math.round(size * 0.22),
        }}
      >
        <svg width={pin} height={pin} viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round">
          <path d={PIN} />
          <circle cx="12" cy="10" r="3" />
        </svg>
      </div>
    </div>
  );
}
