import { useState } from 'react';
import type { KycState } from '../App';
import { api } from '../lib/api';
import { kycFormSchema } from '../lib/validators';

interface Props {
  state: KycState;
  updateState: (updates: Partial<KycState>) => void;
  onNext: () => void;
  onError: (msg: string) => void;
}

export function KycForm({ state, updateState, onNext, onError }: Props) {
  const [phone, setPhone] = useState(state.phone);
  const [email, setEmail] = useState(state.email);
  const [bvn, setBvn] = useState(state.bvn);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const validate = () => {
    const result = kycFormSchema.safeParse({ phone, email, bvn });
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      result.error.issues.forEach((issue) => {
        const field = issue.path[0] as string;
        fieldErrors[field] = issue.message;
      });
      setErrors(fieldErrors);
      return false;
    }
    setErrors({});
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setLoading(true);
    try {
      const res = await api.initiate({ phone, email, bvn });
      updateState({ phone, email, bvn, identityId: res.identityId });
      onNext();
    } catch (err: any) {
      onError(err.message || 'Failed to initiate verification');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <p className="text-zinc-400 text-sm">
        Enter your details to create your sub-account. Takes less than 2 minutes.
      </p>

      {/* Phone */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
          Phone Number
        </label>
        <div className="flex gap-2">
          <span className="flex items-center justify-center w-16 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-400 text-sm">
            +234
          </span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            placeholder="8012345678"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-white text-base outline-none focus:border-green-500 transition-colors"
          />
        </div>
        {errors.phone && <p className="text-red-500 text-xs mt-1.5">{errors.phone}</p>}
      </div>

      {/* Email */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
          Email Address
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-white text-base outline-none focus:border-green-500 transition-colors"
        />
        {errors.email && <p className="text-red-500 text-xs mt-1.5">{errors.email}</p>}
      </div>

      {/* BVN */}
      <div>
        <label className="block text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
          BVN (11 digits)
        </label>
        <input
          type="tel"
          value={bvn}
          onChange={(e) => setBvn(e.target.value.replace(/\D/g, '').slice(0, 11))}
          placeholder="22222222222"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3.5 text-white text-base outline-none focus:border-green-500 transition-colors"
        />
        {errors.bvn && <p className="text-red-500 text-xs mt-1.5">{errors.bvn}</p>}
      </div>

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-green-500 hover:bg-green-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-black font-semibold py-4 rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Sending OTP...
          </>
        ) : (
          'Continue'
        )}
      </button>
    </form>
  );
}
