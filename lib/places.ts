// Small helpers for what students type and read: room codes and distances.

/** A room code from a timetable, like "34-204" or "34 204": the block and the room. */
export function parseRoom(q: string): { block: string; room: string } | null {
  const m = q.trim().toUpperCase().match(/^(?:BLOCK\s*)?(\d{1,3}[A-Z]?)\s*[-–/.\s]\s*(\d{2,4}[A-Z]?)$/);
  return m ? { block: m[1], room: m[2] } : null;
}

/** "350 m" or "1.2 km". */
export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}
