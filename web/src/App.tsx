import { useState } from 'react';
import { KycForm } from './components/KycForm';
import { OtpVerify } from './components/OtpVerify';
import { Success } from './components/Success';
import { ErrorState } from './components/ErrorState';

export type Step = 'form' | 'otp' | 'success' | 'error';

export interface KycState {
  phone: string;
  email: string;
  bvn: string;
  identityId: string;
  error: string;
}

export default function App() {
  const [step, setStep] = useState<Step>('form');
  const [state, setState] = useState<KycState>({
    phone: '',
    email: '',
    bvn: '',
    identityId: '',
    error: '',
  });

  const updateState = (updates: Partial<KycState>) => {
    setState((prev) => ({ ...prev, ...updates }));
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8">
          {/* Logo */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white">
              3rike <span className="text-green-500">Pay</span>
            </h1>
            <p className="text-zinc-500 text-sm mt-2">Identity Verification</p>
          </div>

          {/* Step Indicator */}
          <div className="flex justify-center gap-2 mb-8">
            {['form', 'otp', 'success'].map((s, i) => (
              <div
                key={s}
                className={`h-2 rounded-full transition-all duration-300 ${
                  step === s
                    ? 'w-8 bg-green-500'
                    : ['form', 'otp', 'success'].indexOf(step) > i
                    ? 'w-2 bg-green-500'
                    : 'w-2 bg-zinc-700'
                }`}
              />
            ))}
          </div>

          {/* Steps */}
          {step === 'form' && (
            <KycForm
              state={state}
              updateState={updateState}
              onNext={() => setStep('otp')}
              onError={(msg) => {
                updateState({ error: msg });
                setStep('error');
              }}
            />
          )}

          {step === 'otp' && (
            <OtpVerify
              state={state}
              updateState={updateState}
              onSuccess={() => setStep('success')}
              onError={(msg) => {
                updateState({ error: msg });
                setStep('error');
              }}
            />
          )}

          {step === 'success' && <Success />}

          {step === 'error' && (
            <ErrorState
              message={state.error}
              onRetry={() => {
                updateState({ error: '' });
                setStep('form');
              }}
            />
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-zinc-600 text-xs mt-6">
          Secured by AutoRamp
        </p>
      </div>
    </div>
  );
}
