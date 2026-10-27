import type { CreatorNiche } from '../../db/schema.js';

/**
 * Deterministic creator–product match scoring (0–100). Three signals:
 *  - niche affinity  (50%): product category vs creator niche
 *  - engagement      (30%): engagement rate, saturating at 8%
 *  - reach fit       (20%): microinfluencer sweet spot (10k–100k followers)
 * Same inputs always give the same score, so rankings are explainable and testable.
 */
export const MATCH_WEIGHTS = { niche: 0.5, engagement: 0.3, reach: 0.2 } as const;

/** Engagement at or above this rate scores 1.0. Microcreators typically sit at 3–6%. */
const ENGAGEMENT_SATURATION = 0.08;

/** Maps escrow categories onto creator niches. */
const CATEGORY_TO_NICHE: Readonly<Record<string, CreatorNiche>> = {
  beauty: 'beauty',
  skincare: 'beauty',
  consumables: 'beauty',
  fashion: 'fashion',
  footwear: 'fashion',
  apparel: 'fashion',
  electronics: 'electronics',
  audio: 'electronics',
  home: 'home',
  general: 'general',
};

/** Affinity between adjacent audiences (symmetric). Exact match = 1, generalist = 0.5. */
const RELATED_NICHES: ReadonlyArray<[CreatorNiche, CreatorNiche, number]> = [
  ['beauty', 'fashion', 0.6],
  ['home', 'electronics', 0.4],
  ['home', 'beauty', 0.3],
];
const GENERALIST_AFFINITY = 0.5;
const UNRELATED_AFFINITY = 0.15;

export function productNiche(category: string): CreatorNiche {
  return CATEGORY_TO_NICHE[category.trim().toLowerCase()] ?? 'general';
}

export function nicheAffinity(category: string, creatorNiche: CreatorNiche): number {
  const target = productNiche(category);
  if (target === creatorNiche) return 1;
  if (creatorNiche === 'general' || target === 'general') return GENERALIST_AFFINITY;
  for (const [a, b, score] of RELATED_NICHES) {
    if ((a === target && b === creatorNiche) || (b === target && a === creatorNiche)) return score;
  }
  return UNRELATED_AFFINITY;
}

export function engagementScore(engagementRate: number): number {
  return Math.max(0, Math.min(engagementRate / ENGAGEMENT_SATURATION, 1));
}

/**
 * Piecewise on log10(followers):
 *   <1k: ramps 0.1 -> 0.5 · 1k–10k: 0.5 -> 1.0 · 10k–100k: 1.0 (sweet spot)
 *   100k–1M: 1.0 -> 0.6 (macro: costlier, less trusted) · >1M: 0.6
 */
export function reachScore(followers: number): number {
  if (followers <= 0) return 0;
  const lg = Math.log10(followers);
  if (lg < 3) return 0.1 + (0.4 * lg) / 3;
  if (lg < 4) return 0.5 + 0.5 * (lg - 3);
  if (lg <= 5) return 1;
  if (lg <= 6) return 1 - 0.4 * (lg - 5);
  return 0.6;
}

export interface MatchCandidate {
  slug: string;
  niche: CreatorNiche;
  followersCount: number;
  /** numeric(5,4) string, e.g. "0.0450". */
  engagementRate: string;
}

export interface MatchResult {
  score: number;
  breakdown: { niche: number; engagement: number; reach: number };
  reasons: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export class MatchingService {
  score(productCategory: string, creator: MatchCandidate): MatchResult {
    const niche = nicheAffinity(productCategory, creator.niche);
    const engagement = engagementScore(Number(creator.engagementRate));
    const reach = reachScore(creator.followersCount);
    const score = Math.round(
      100 * (MATCH_WEIGHTS.niche * niche + MATCH_WEIGHTS.engagement * engagement + MATCH_WEIGHTS.reach * reach),
    );

    const reasons: string[] = [];
    const target = productNiche(productCategory);
    if (niche === 1) reasons.push(`Niche match: ${creator.niche}`);
    else if (creator.niche === 'general') reasons.push('Generalist creator');
    else reasons.push(`Adjacent audience: ${creator.niche} → ${target}`);
    const pct = (Number(creator.engagementRate) * 100).toFixed(1);
    reasons.push(engagement >= 0.75 ? `High engagement (${pct}%)` : `Engagement ${pct}%`);
    if (reach === 1) reasons.push('Microinfluencer sweet spot (10k–100k)');
    else if (creator.followersCount > 100_000) reasons.push('Macro reach: broader but less targeted audience');
    else reasons.push('Nano audience: small but close-knit');

    return { score, breakdown: { niche: round2(niche), engagement: round2(engagement), reach: round2(reach) }, reasons };
  }

  /** Scores and ranks: score desc, then engagement desc, then slug for a stable order. */
  rank<C extends MatchCandidate>(productCategory: string, candidates: C[]): (C & { match: MatchResult })[] {
    return candidates
      .map((c) => ({ ...c, match: this.score(productCategory, c) }))
      .sort(
        (a, b) =>
          b.match.score - a.match.score ||
          Number(b.engagementRate) - Number(a.engagementRate) ||
          a.slug.localeCompare(b.slug),
      );
  }
}
