/**
 * Stable load ids. Clustering runs again every few minutes and a load's median power drifts, so
 * an id computed from the median would change and take the user's name, flows, device and tests
 * with it. The registry remembers each load's signature (phase share and log power) and gives a
 * new cluster the id of the nearest remembered load within the clustering limits; only a cluster
 * no remembered load fits gets a new id. Matching is one-to-one, nearest pairs first.
 */
import { CLUSTERING } from './config';
import { LoadCluster, Vec3 } from './types';

export interface RegisteredLoad {
  id: string;
  share: Vec3;
  logW: number;
  /** Last time a cluster matched it (ms); loads unseen for long are forgotten. */
  seen: number;
}

export const REGISTRY = {
  MAX_LOADS: 200,
  FORGET_AFTER_MS: 90 * 86_400_000,
  /** How far a signature follows each new match (0..1). */
  FOLLOW: 0.2,
};

const shareDistance = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

export class LoadRegistry {
  private loads: RegisteredLoad[] = [];

  constructor(loads: RegisteredLoad[] = []) {
    this.loads = loads.filter(
      l => l && typeof l.id === 'string' && Array.isArray(l.share) && l.share.length === 3 && Number.isFinite(l.logW)
    );
  }

  /** Gives each cluster a stable id (returns new cluster objects; the registry learns). */
  assign(clusters: LoadCluster[], now: number): LoadCluster[] {
    const pairs: Array<{ c: number; r: number; d: number }> = [];
    clusters.forEach((c, ci) => {
      const logW = Math.log(c.medianW);
      this.loads.forEach((r, ri) => {
        const dW = Math.abs(logW - r.logW);
        const dS = shareDistance(c.share, r.share);
        if (dW <= CLUSTERING.MAX_LOG_POWER_DIFF && dS <= CLUSTERING.MAX_SHARE_DISTANCE) {
          pairs.push({ c: ci, r: ri, d: dW / CLUSTERING.MAX_LOG_POWER_DIFF + dS / CLUSTERING.MAX_SHARE_DISTANCE });
        }
      });
    });
    pairs.sort((a, b) => a.d - b.d);
    const idOf = new Map<number, string>();
    const usedR = new Set<number>();
    for (const p of pairs) {
      if (idOf.has(p.c) || usedR.has(p.r)) continue;
      idOf.set(p.c, this.loads[p.r].id);
      usedR.add(p.r);
      const r = this.loads[p.r];
      const c = clusters[p.c];
      r.logW += (Math.log(c.medianW) - r.logW) * REGISTRY.FOLLOW;
      r.share = r.share.map((v, k) => v + (c.share[k] - v) * REGISTRY.FOLLOW) as Vec3;
      r.seen = now;
    }
    const taken = new Set(this.loads.map(l => l.id));
    const out = clusters.map((c, ci) => {
      let id = idOf.get(ci);
      if (!id) {
        id = c.id;
        for (let i = 2; taken.has(id); i++) id = `${c.id}-${i}`;
        taken.add(id);
        this.loads.push({ id, share: [...c.share] as Vec3, logW: Math.log(c.medianW), seen: now });
      }
      return { ...c, id };
    });
    this.loads = this.loads
      .filter(l => now - l.seen <= REGISTRY.FORGET_AFTER_MS)
      .sort((a, b) => b.seen - a.seen)
      .slice(0, REGISTRY.MAX_LOADS);
    return out;
  }

  snapshot(): RegisteredLoad[] {
    return this.loads.map(l => ({ ...l, share: [...l.share] as Vec3 }));
  }
}
