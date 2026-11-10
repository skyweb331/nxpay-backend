/**
 * Bridge API shapes (v0), limited to the fields NxPay reads. Responses are kept as
 * loose objects so new Bridge fields never break parsing; the raw payload is stored
 * alongside (TransactionEvent.payload, WebhookEvent.payload) for audit.
 */

export type BridgeChain = 'base' | 'solana';
export type BridgeFiat = 'usd' | 'eur';
export type BridgeStablecoin = 'usdc' | 'eurc';

export type BridgeKycStatus =
  | 'not_started'
  | 'incomplete'
  | 'awaiting_questionnaire'
  | 'awaiting_ubo'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'paused'
  | 'offboarded'
  | 'deposits_restricted'
  // Customer object uses `active` for approved
  | 'active';

export type BridgeTosStatus = 'pending' | 'approved';

export interface BridgeRejectionReason {
  reason?: string;
  developer_reason?: string;
  created_at?: string;
}

export interface BridgeKycLink {
  id: string;
  full_name?: string;
  email: string;
  type: 'individual' | 'business';
  kyc_link: string;
  tos_link: string;
  kyc_status: BridgeKycStatus;
  tos_status: BridgeTosStatus;
  rejection_reasons?: BridgeRejectionReason[];
  customer_id?: string | null;
  created_at?: string;
}

export interface BridgeEndorsement {
  name: string;
  status: 'incomplete' | 'approved' | 'revoked' | string;
  requirements?: Record<string, unknown>;
}

export interface BridgeAddress {
  country?: string;
  subdivision?: string;
  state?: string;
}

export interface BridgeCustomer {
  id: string;
  first_name?: string;
  last_name?: string;
  business_name?: string;
  email?: string;
  type?: 'individual' | 'business';
  status?: BridgeKycStatus;
  kyc_status?: BridgeKycStatus;
  tos_status?: BridgeTosStatus;
  has_accepted_terms_of_service?: boolean;
  endorsements?: BridgeEndorsement[];
  rejection_reasons?: BridgeRejectionReason[];
  requirements_due?: string[];
  future_requirements_due?: string[];
  address?: BridgeAddress;
  residential_address?: BridgeAddress;
  created_at?: string;
  updated_at?: string;
}

export interface BridgeWalletBalance {
  balance: string;
  currency: string;
  chain: string;
  contract_address?: string;
}

export interface BridgeWallet {
  id: string;
  chain: BridgeChain | string;
  address: string;
  balances?: BridgeWalletBalance[];
  created_at?: string;
  updated_at?: string;
}

export interface BridgeDepositInstructions {
  currency: string;
  payment_rails?: string[];
  payment_rail?: string;
  // USD
  bank_name?: string;
  bank_address?: string;
  bank_routing_number?: string;
  bank_account_number?: string;
  bank_beneficiary_name?: string;
  bank_beneficiary_address?: string;
  // EUR
  iban?: string;
  bic?: string;
  account_holder_name?: string;
  [key: string]: unknown;
}

export interface BridgeVirtualAccount {
  id: string;
  status: 'activated' | 'deactivated' | string;
  customer_id?: string;
  developer_fee_percent?: string;
  source_deposit_instructions: BridgeDepositInstructions;
  destination: {
    currency: string;
    payment_rail: string;
    address?: string;
    bridge_wallet_id?: string;
  };
  created_at?: string;
}

export type VirtualAccountEventType =
  | 'funds_received'
  | 'payment_submitted'
  | 'payment_processed'
  | 'funds_scheduled'
  | 'in_review'
  | 'refunded'
  | 'refund_in_flight'
  | 'refund_failed'
  | 'account_update'
  | 'deactivation'
  | 'activation'
  | 'microdeposit';

export interface BridgeVirtualAccountEvent {
  id: string;
  type: VirtualAccountEventType | string;
  customer_id: string;
  virtual_account_id: string;
  deposit_id?: string;
  amount?: string;
  currency?: string;
  developer_fee_amount?: string;
  exchange_fee_amount?: string;
  subtotal_amount?: string;
  gas_fee?: string;
  destination_tx_hash?: string;
  source?: { payment_rail?: string; [key: string]: unknown };
  receipt?: {
    initial_amount?: string;
    developer_fee?: string;
    exchange_fee?: string;
    subtotal_amount?: string;
    final_amount?: string;
    gas_fee?: string;
    destination_tx_hash?: string;
    url?: string;
  };
  refund?: { code?: string; reason?: string; refunded_at?: string };
  created_at: string;
}

export type TransferState =
  | 'awaiting_funds'
  | 'in_review'
  | 'funds_received'
  | 'payment_submitted'
  | 'payment_processed'
  | 'undeliverable'
  | 'returned'
  | 'missing_return_policy'
  | 'refunded'
  | 'refund_in_flight'
  | 'refund_failed'
  | 'canceled'
  | 'error';

export interface BridgeTransfer {
  id: string;
  state: TransferState | string;
  amount?: string;
  currency?: string;
  developer_fee?: string;
  on_behalf_of?: string;
  client_reference_id?: string | null;
  source?: { payment_rail?: string; currency?: string; bridge_wallet_id?: string };
  destination?: { payment_rail?: string; currency?: string; to_address?: string };
  receipt?: {
    initial_amount?: string;
    developer_fee?: string;
    exchange_fee?: string;
    subtotal_amount?: string;
    gas_fee?: string;
    final_amount?: string;
    destination_tx_hash?: string;
    url?: string;
  };
  return_details?: { reason?: string } | null;
  created_at?: string;
  updated_at?: string;
}

export interface CreateTransferRequest {
  amount: string;
  on_behalf_of: string;
  developer_fee: string;
  client_reference_id?: string;
  source: { payment_rail: 'bridge_wallet'; currency: BridgeStablecoin; bridge_wallet_id: string };
  destination: { payment_rail: BridgeChain; currency: BridgeStablecoin; to_address: string };
}

export interface BridgeExchangeRate {
  midmarket_rate: string;
  buy_rate: string;
  sell_rate: string;
  updated_at?: string;
}

export interface BridgeList<T> {
  count: number;
  data: T[];
}

export interface BridgeWebhookEvent<T = Record<string, unknown>> {
  api_version: string;
  event_id: string;
  event_sequence?: number;
  event_category: string;
  event_type: string;
  event_object_id: string;
  event_object_status?: string | null;
  event_object: T;
  event_object_changes?: Record<string, unknown>;
  event_created_at: string;
}
