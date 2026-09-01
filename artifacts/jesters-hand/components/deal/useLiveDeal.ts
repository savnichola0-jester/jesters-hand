import { useState, useEffect, useMemo } from 'react';
import { Deal } from '@/lib/dealService';

export function useLiveDeal(deals: Deal[]): Deal | null {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 15000); // 15 seconds
    return () => clearInterval(timer);
  }, []);

  return useMemo(() => {
    const isLive = (d: Deal) => d.status === 'published' && !!d.publishedAt && (!d.expiresAt || d.expiresAt.toMillis() > now);
    const live = deals.filter(isLive).sort((a, b) => (b.publishedAt?.toMillis() ?? 0) - (a.publishedAt?.toMillis() ?? 0));
    return live[0] || null;
  }, [deals, now]);
}