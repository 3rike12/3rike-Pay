import { useState, useRef, useEffect } from 'react';
import type { KycState } from '../App';
import { api } from '../lib/api';

interface Props {
  state: KycState;
  updateState: (updates: Partial<KycState>) => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

export function OtpVerify({ state, updateState, onSuccess, onError }: Props) {
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleChange = (index: number, value: string) => {
    if (value.length > 1) return;
    const digit = value.replace(/\D/g, '');
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);
    setError('');

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    const newOtp = pasted.split('').concat(Array(6 - pasted.length).fill(''));
    setOtp(newOtp);
    if (pasted.length > 0) {
      inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    }
  };

  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length < 4) {
      setError('Enter the complete OTP');
      return;
    }

    setLoading(true);
    try {
      await api.validate({
        identityId: state.identityId,
        bvn: state.bvn,
        otp: code,
      });

      // Create sub-account
      await api.complete({
        phone: state.phone,
        email: state.email,
        bvn: state.bvn,
        identityId: state.identityId,
      });

      onSuccess();
    } catch (err: any) {
      setError(err.message || 'Verification failed');
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const res = await api.resend(state.bvn);
      updateState({ identityId: res.identityId });
      setError('');
      setOtp(['', '', '', '', '', '']);
      inputRefs.current[0]?.focus();
    } catch (err: any) {
      setError(err.message || 'Failed to resend OTP');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="text-4xl mb-4">📱</div>
        <h2 className="text-xl font-semibold text-white">Verify Your BVN</h2>
        <p className="text-zinc-400 text-sm mt-2">
          Enter the OTP sent to the phone number linked to your BVN.
        </p>
      </div>

      {/* OTP Input */}
      <div className="flex justify-center gap-2">
        {otp.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el; }}
            type="tel"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={handlePaste}
            className="w-12 h-14 text-center text-2xl font-bold bg-zinc-950 border border-zinc-800 rounded-xl text-white outline-none focus:border-green-500 transition-colors"
          />
        ))}
      </div>

      {error && (
        <p className="text-red-500 text-sm text-center">{error}</p>
      )}

      <button
        onClick={handleVerify}
        disabled={loading || otp.join('').length < 4}
        className="w-full bg-green-500 hover:bg-green-600 disabled:bg-zinc-800 disabled:text-zinc-500 text-black font-semibold py-4 rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Verifying...
          </>
        ) : (
          'Verify'
        )}
      </button>

      <button
        onClick={handleResend}
        disabled={resending}
        className="w-full bg-transparent border border-zinc-700 hover:border-zinc-500 text-zinc-400 hover:text-white font-medium py-3.5 rounded-xl transition-colors"
      >
        {resending ? 'Resending...' : 'Resend OTP'}
      </button>
    </div>
  );
}
