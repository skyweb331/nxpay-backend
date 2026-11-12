import crypto from 'node:crypto';

import { isBridgeSandbox } from '#src/config.js';

import type { BridgeClient } from './client.js';
import type { BridgeCustomer } from './types.js';

/**
 * Fixed Bridge sandbox test identity. Sandbox KYC links don't work, so the sandbox
 * adapter creates the Bridge customer from this fixture and simulates approval.
 * Real users are never asked for these details, and this path refuses to run
 * outside `BRIDGE_ENV=sandbox`.
 */
const SANDBOX_INDIVIDUAL = {
  address: {
    street_line_1: '123 Washington St',
    street_line_2: 'Apt 2F',
    city: 'San Francisco',
    subdivision: 'CA',
    postal_code: '94105',
    country: 'USA',
  },
  birth_date: '1989-09-09',
  tax_identification_number: '111-11-1111',
  phone: '+15555555555',
};

export function assertSandbox(action: string) {
  if (!isBridgeSandbox) {
    throw new Error(`${action} is only available with BRIDGE_ENV=sandbox`);
  }
}

export class BridgeCustomersApi {
  constructor(private readonly client: BridgeClient) {}

  get(customerId: string) {
    return this.client.get<BridgeCustomer>(`/customers/${encodeURIComponent(customerId)}`);
  }

  /** Partial update; Bridge requires `type` to pick the payload shape. */
  updateEmail(customerId: string, type: 'individual' | 'business', email: string) {
    return this.client.put<BridgeCustomer>(
      `/customers/${encodeURIComponent(customerId)}`,
      { type, email },
      { idempotencyKey: crypto.randomUUID() }
    );
  }

  /** Hosted KYC link for an existing customer (RFIs, new endorsements). */
  kycLink(customerId: string, options: { endorsement?: string; redirectUri?: string } = {}) {
    return this.client.get<{ url: string }>(
      `/customers/${encodeURIComponent(customerId)}/kyc_link`,
      {
        query: { endorsement: options.endorsement, redirect_uri: options.redirectUri },
      }
    );
  }

  /** Hosted ToS acceptance URL for an existing customer. */
  tosLink(customerId: string) {
    return this.client.get<{ url: string }>(
      `/customers/${encodeURIComponent(customerId)}/tos_acceptance_link`
    );
  }

  /**
   * Sandbox only: create an approved-able individual customer from the fixture identity.
   * Business onboarding is simulated with the same individual fixture (sandbox KYB
   * needs associated persons that NxPay never collects).
   */
  async createSandboxCustomer(input: { fullName: string; email: string; idempotencyKey: string }) {
    assertSandbox('createSandboxCustomer');
    const [firstName, ...rest] = input.fullName.trim().split(/\s+/);
    return this.client.post<BridgeCustomer>(
      '/customers',
      {
        type: 'individual',
        first_name: firstName || 'Sandbox',
        last_name: rest.join(' ') || 'Customer',
        email: input.email,
        ...SANDBOX_INDIVIDUAL,
        signed_agreement_id: crypto.randomUUID(),
        endorsements: ['base', 'sepa'],
      },
      { idempotencyKey: input.idempotencyKey }
    );
  }

  /** Sandbox only. */
  simulateKycApproval(customerId: string) {
    assertSandbox('simulateKycApproval');
    return this.client.post<{ success: boolean; kyc_status: string; message: string }>(
      `/customers/${encodeURIComponent(customerId)}/simulate_kyc_approval`,
      {},
      { idempotencyKey: `simulate-kyc-${customerId}` }
    );
  }
}
