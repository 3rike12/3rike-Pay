// ============================================
// WhatsApp Types
// ============================================

export interface WhatsAppMessage {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts: Array<{
    profile: { name: string };
    wa_id: string;
  }>;
  messages: Array<{
    from: string;
    id: string;
    timestamp: string;
    type: "text" | "interactive" | "image" | "location";
    text?: { body: string };
    interactive?: {
      type: "button_reply" | "list_reply";
      button_reply?: { id: string; title: string };
      list_reply?: { id: string; title: string; description: string };
    };
  }>;
}

export interface WhatsAppStatus {
  messaging_product: string;
  metadata: { phone_number_id: string };
  statuses: Array<{
    id: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: string;
    recipient_id: string;
  }>;
}

export interface WebhookBody {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: WhatsAppMessage | WhatsAppStatus;
      field: string;
    }>;
  }>;
}

// ============================================
// AutoRamp Types
// ============================================

export interface AutoRampSubAccount {
  phoneNumber: string;
  emailAddress: string;
  externalReference: string;
  identityType?: string;
  identityNumber?: string;
  otp?: string;
}

export interface AutoRampTransfer {
  beneficiaryBankCode: string;
  beneficiaryAccountNumber: string;
  amount: number;
  narration: string;
  paymentReference: string;
  debitAccountNumber?: string;
}

export interface AutoRampMerchantAccount {
  accountId: string;
  accountNumber: string;
  bankCode: string;
  accountBalance: number;
  accountName: string;
  status: string;
  fiatProvider: string;
}

// ============================================
// Transaction Types
// ============================================

export interface Transaction {
  id: string;
  reference: string;
  userId: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  description?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserSession {
  id: string;
  userId: string;
  state: string;
  flowData: Record<string, unknown>;
  lastActivity: Date;
  createdAt: Date;
  updatedAt: Date;
}
