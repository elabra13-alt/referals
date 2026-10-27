import { assessLinkAvailability, linkInactiveError, linkNotFoundError } from './link-availability.js';
import type { LinksRepository } from './links.repository.js';
import type { LinkPreviewDto } from './links.schemas.js';

export class LinksService {
  constructor(
    private readonly repo: LinksRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Resolves a buyer-facing link: 404 if unknown, 410 (with reason) if it can't be used right now. */
  async preview(linkSlug: string): Promise<LinkPreviewDto> {
    const row = await this.repo.findPublicLink(linkSlug);
    if (!row) throw linkNotFoundError();

    const availability = assessLinkAvailability(row, this.now());
    if (availability !== 'active') throw linkInactiveError(availability);

    return {
      link_slug: row.linkSlug,
      creator: { name: row.creatorName ?? row.influencerSlug, handle: row.creatorHandle },
      product: { name: row.productName, price: row.price, currency: row.currency, category: row.category },
      status: 'active',
    };
  }
}
