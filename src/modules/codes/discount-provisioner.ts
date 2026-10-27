/**
 * Registers an issued code with the seller's store so it is accepted at checkout.
 * Implementations no-op for sellers without a store integration.
 */
export interface DiscountProvisioner {
  provision(input: { sellerId: string; code: string; issuedAt: Date; expiresAt: Date }): Promise<void>;
}
