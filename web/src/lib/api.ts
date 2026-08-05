const API_BASE = '';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }

  return data;
}

export interface InitiateResponse {
  success: boolean;
  identityId: string;
  status: string;
}

export interface ValidateResponse {
  success: boolean;
  status: string;
  identityId: string;
}

export interface CompleteResponse {
  success: boolean;
  userId: string;
  accountId: string;
}

export interface StatusResponse {
  exists: boolean;
  kycStatus: string;
  hasAccount: boolean;
}

export const api = {
  initiate: (data: { phone: string; email: string; bvn: string }) =>
    request<InitiateResponse>('/api/kyc/initiate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  validate: (data: { identityId: string; bvn: string; otp: string }) =>
    request<ValidateResponse>('/api/kyc/validate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  complete: (data: { phone: string; email: string; bvn: string; identityId: string }) =>
    request<CompleteResponse>('/api/kyc/complete', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  resend: (bvn: string) =>
    request<{ success: boolean; identityId: string }>('/api/kyc/resend', {
      method: 'POST',
      body: JSON.stringify({ bvn }),
    }),

  status: (phone: string) =>
    request<StatusResponse>(`/api/kyc/status/${phone}`),
};
