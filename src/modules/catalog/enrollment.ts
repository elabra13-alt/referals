import { isUniqueViolation, type Database } from '../../db/client.js';
import type { Creator, Link } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { CreatorsRepository } from '../creators/creators.repository.js';
import { MAX_LINK_SLUG_ATTEMPTS, linkSlugBase, randomSuffix } from '../creators/creators.service.js';
import type { ScriptGenerator } from '../creators/script-generator.service.js';
import { CatalogRepository } from './catalog.repository.js';

/** What a creator is being enrolled into. */
export interface EnrollTarget {
  campaignId: string;
  productId: string;
  productName: string;
  category: string;
  price: string;
  currency: string;
}

export interface EnrollResult {
  status: 'joined' | 'already_joined';
  link: Link;
  storefrontItemId: string;
}

/** Extra writes that must commit (or roll back) together with the enrollment. */
export type EnrollTxHook = (tx: Database) => Promise<void>;

/**
 * Enrolls a creator in a campaign: their referral link + their storefront card,
 * committed in one transaction (plus any caller writes via `inTx`, e.g. marking
 * an invitation accepted). Idempotent: an existing link is reused and the card
 * re-pointed/re-activated. Shared by the Open Catalog join and invitation
 * acceptance so both paths behave identically.
 */
export class CampaignEnrollment {
  constructor(
    private readonly deps: {
      db: Database;
      creatorsRepo: CreatorsRepository;
      scripts: ScriptGenerator;
      publicLinkBaseUrl: string;
    },
  ) {}

  private attach(tx: Database, creator: Creator, target: EnrollTarget, link: Link) {
    return new CatalogRepository(tx).attachJoinedLink({
      creatorId: creator.id,
      productId: target.productId,
      campaignId: target.campaignId,
      linkId: link.id,
    });
  }

  /** Existing link: (re)attach the storefront card and run the caller's writes atomically. */
  private async reuse(creator: Creator, target: EnrollTarget, link: Link, inTx?: EnrollTxHook): Promise<EnrollResult> {
    const item = await this.deps.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      const attached = await this.attach(tx, creator, target, link);
      if (inTx) await inTx(tx);
      return attached;
    });
    return { status: 'already_joined', link, storefrontItemId: item.id };
  }

  async enroll(creator: Creator, target: EnrollTarget, opts: { inTx?: EnrollTxHook } = {}): Promise<EnrollResult> {
    const { creatorsRepo } = this.deps;
    const existing = await creatorsRepo.findLinkForCreator(target.campaignId, creator.id);
    if (existing) return this.reuse(creator, target, existing, opts.inTx);

    const base = linkSlugBase(creator.slug, target.productName);
    for (let attempt = 0; attempt < MAX_LINK_SLUG_ATTEMPTS; attempt++) {
      const linkSlug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
      if (attempt === 0 && (await creatorsRepo.linkSlugExists(linkSlug))) continue;

      // Script generation may call an LLM: never hold a transaction open across it.
      const script = await this.deps.scripts.generate({
        creator: { name: creator.name, handle: creator.handle, slug: creator.slug, niche: creator.niche },
        product: { name: target.productName, category: target.category, price: target.price, currency: target.currency },
        linkUrl: `${this.deps.publicLinkBaseUrl.replace(/\/+$/, '')}/${linkSlug}`,
      });

      try {
        return await this.deps.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const link = await new CreatorsRepository(tx).insertLink({
            campaignId: target.campaignId,
            creatorId: creator.id,
            influencerSlug: creator.slug,
            linkSlug,
            customScript: script.full_text,
            status: 'active',
            expiresAt: null,
          });
          const item = await this.attach(tx, creator, target, link);
          if (opts.inTx) await opts.inTx(tx);
          return { status: 'joined' as const, link, storefrontItemId: item.id };
        });
      } catch (err) {
        // A concurrent enrollment of the same creator + campaign won: converge on its link.
        if (isUniqueViolation(err, 'links_campaign_creator_unique')) {
          const winner = await creatorsRepo.findLinkForCreator(target.campaignId, creator.id);
          if (winner) return this.reuse(creator, target, winner, opts.inTx);
        }
        if (isUniqueViolation(err, 'links_link_slug_unique')) continue;
        throw err;
      }
    }
    throw new AppError(503, 'LINK_SLUG_EXHAUSTED', 'Could not allocate a unique link slug. Please retry.', undefined, {
      'Retry-After': '1',
    });
  }
}
