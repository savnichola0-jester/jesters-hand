export const SEAT_CATEGORIES = ["login", "conversation", "participation", "deal_suits"] as const;
export type SeatCategory = typeof SEAT_CATEGORIES[number];
export type SeatEvent = { category: SeatCategory; at: number; key?: string };
export const APP_ICON_IDS = [
  "ticket", "hand", "street_art", "jesters_deal", "suits", "ante", "table",
  "target_ticket", "recruit", "vault", "chamber", "system", "uniform",
  "jesters_hand", "pocket",
] as const;
export type AppIconId = typeof APP_ICON_IDS[number];
export type IconActivityEvent = { icon: AppIconId; at: number; key?: string; points: number };

const DAY = 86_400_000;

const temperatureForScore = (score: number) =>
  score >= 50
    ? "Hot" as const
    : score >= 20
      ? "Warm" as const
      : score > 0
        ? "Lukewarm" as const
        : "Cold" as const;

/**
 * Score canonical activity from the last 31 days.
 * Login remains visible in the detail counts but cannot heat a seat by itself.
 */
export function scoreSeatEvents(events: SeatEvent[], now = Date.now()) {
  const counts: Record<SeatCategory, number> = {
    login: 0,
    conversation: 0,
    participation: 0,
    deal_suits: 0,
  };
  const timestamps: Partial<Record<SeatCategory, string>> = {};
  const unique = new Map<string, SeatEvent>();

  events.forEach((event, index) => {
    const key = event.key ?? `${event.category}:${event.at}:${index}`;
    const existing = unique.get(key);
    if (!existing || event.at > existing.at) unique.set(key, event);
  });

  let score = 0;
  unique.forEach(event => {
    counts[event.category]++;
    if (!timestamps[event.category] || event.at > Date.parse(timestamps[event.category]!)) {
      timestamps[event.category] = new Date(event.at).toISOString();
    }
    const base = event.category === "participation"
      ? 6
      : event.category === "deal_suits"
        ? 12
        : event.category === "conversation"
          ? 5
          : 0;
    score += base * Math.exp(-(now - event.at) / (7 * DAY));
  });

  score = Math.round(Math.min(100, score));
  return {
    score,
    temperature: temperatureForScore(score),
    counts,
    timestamps,
  };
}

export function scoreIconEvents(events: IconActivityEvent[], now = Date.now()) {
  const grouped = Object.fromEntries(APP_ICON_IDS.map(icon => [icon, {
    score: 0,
    temperature: "Cold" as const,
    count: 0,
    lastActivityAt: null as string | null,
  }])) as Record<AppIconId, {
    score: number;
    temperature: ReturnType<typeof temperatureForScore>;
    count: number;
    lastActivityAt: string | null;
  }>;
  const unique = new Map<string, IconActivityEvent>();

  events.forEach((event, index) => {
    const key = `${event.icon}:${event.key ?? `${event.at}:${index}`}`;
    const existing = unique.get(key);
    if (!existing || event.at > existing.at) unique.set(key, event);
  });

  unique.forEach(event => {
    const summary = grouped[event.icon];
    summary.count++;
    if (!summary.lastActivityAt || event.at > Date.parse(summary.lastActivityAt)) {
      summary.lastActivityAt = new Date(event.at).toISOString();
    }
    summary.score += event.points * Math.exp(-(now - event.at) / (7 * DAY));
  });

  APP_ICON_IDS.forEach(icon => {
    const summary = grouped[icon];
    summary.score = Math.round(Math.min(100, summary.score));
    summary.temperature = temperatureForScore(summary.score);
  });
  return grouped;
}