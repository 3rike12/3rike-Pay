interface Props {
  message: string;
  onRetry: () => void;
}

export function ErrorState({ message, onRetry }: Props) {
  return (
    <div className="text-center space-y-6">
      <div className="w-16 h-16 bg-red-500/10 border border-red-500/20 rounded-full flex items-center justify-center mx-auto">
        <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>

      <div>
        <h2 className="text-xl font-semibold text-white">Verification Failed</h2>
        <p className="text-zinc-400 text-sm mt-2">{message}</p>
      </div>

      <button
        onClick={onRetry}
        className="w-full bg-green-500 hover:bg-green-600 text-black font-semibold py-4 rounded-xl transition-colors"
      >
        Try Again
      </button>
    </div>
  );
}
