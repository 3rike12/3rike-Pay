// ============================================
// Minimal type declarations for flutterwave-node-v3
// The SDK is CommonJS and ships without types.
// ============================================

declare module "flutterwave-node-v3" {
  export interface FlutterwaveResponse<T = unknown> {
    status: string;
    message: string;
    data?: T;
    meta?: Record<string, unknown>;
  }

  export interface SubaccountPayload {
    account_bank: string;
    account_number: string;
    business_name: string;
    business_email: string;
    business_contact?: string;
    business_contact_mobile?: string;
    business_mobile?: string;
    country: string;
    meta?: Array<{ meta_name: string; meta_value: string }>;
    split_type?: "percentage" | "flat";
    split_value?: number;
  }

  export interface RwandaMobileMoneyPayload {
    tx_ref: string;
    order_id?: string;
    amount: string;
    currency: string;
    email: string;
    phone_number: string;
    fullname?: string;
    redirect_url?: string;
    client_ip?: string;
    device_fingerprint?: string;
    meta?: Record<string, unknown>;
  }

  export interface TransferPayload {
    account_bank: string;
    account_number: string;
    amount: number;
    narration: string;
    currency: string;
    reference: string;
    callback_url?: string;
    debit_currency?: string;
    beneficiary_name?: string;
    meta?: Record<string, unknown>;
  }

  export interface TransactionVerifyPayload {
    id?: string | number;
    tx_ref?: string;
  }

  export interface SubaccountFetchPayload {
    id?: string | number;
  }

  export interface SubaccountUpdatePayload {
    id: string | number;
    account_bank?: string;
    account_number?: string;
    business_name?: string;
    business_email?: string;
    business_contact?: string;
    business_contact_mobile?: string;
    business_mobile?: string;
    country?: string;
    meta?: Array<{ meta_name: string; meta_value: string }>;
    split_type?: "percentage" | "flat";
    split_value?: string | number;
  }

  export interface FlutterwaveInstance {
    Subaccount: {
      create: (payload: SubaccountPayload) => Promise<FlutterwaveResponse>;
      fetch: (payload: SubaccountFetchPayload) => Promise<FlutterwaveResponse>;
      fetch_all: (payload?: Record<string, unknown>) => Promise<FlutterwaveResponse>;
      update: (payload: SubaccountUpdatePayload) => Promise<FlutterwaveResponse>;
      delete: (payload: SubaccountFetchPayload) => Promise<FlutterwaveResponse>;
    };

    MobileMoney: {
      rwanda: (payload: RwandaMobileMoneyPayload) => Promise<FlutterwaveResponse>;
    };

    Transaction: {
      verify: (payload: TransactionVerifyPayload) => Promise<FlutterwaveResponse>;
      verify_by_tx: (payload: { tx_ref: string }) => Promise<FlutterwaveResponse>;
      fetch: (payload?: Record<string, unknown>) => Promise<FlutterwaveResponse>;
      fee: (payload: { amount: string | number; currency: string }) => Promise<FlutterwaveResponse>;
      refund: (payload: { id: string | number; amount?: string | number }) => Promise<FlutterwaveResponse>;
    };

    Transfer: {
      initiate: (payload: TransferPayload) => Promise<FlutterwaveResponse>;
      fetch: (payload?: Record<string, unknown>) => Promise<FlutterwaveResponse>;
      get_a_transfer: (payload: { id: string | number }) => Promise<FlutterwaveResponse>;
    };

    Settlement: {
      fetch: (payload: { id: string | number; from?: string; to?: string }) => Promise<FlutterwaveResponse>;
      fetch_all: (payload?: Record<string, unknown>) => Promise<FlutterwaveResponse>;
    };

    Misc: {
      bal: (payload?: Record<string, unknown>) => Promise<FlutterwaveResponse>;
      bal_currency: (payload: { currency: string }) => Promise<FlutterwaveResponse>;
    };

    Bank: {
      country: (payload: { country: string }) => Promise<FlutterwaveResponse>;
    };
  }

  const Flutterwave: {
    new (
      publicKey: string,
      secretKey: string,
      productionFlag?: boolean
    ): FlutterwaveInstance;
  };

  export default Flutterwave;
}
