export function Success() {
  return (
    <div className="text-center space-y-6">
      <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto">
        <svg className="w-8 h-8 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div>
        <h2 className="text-xl font-semibold text-white">Verification Complete!</h2>
        <p className="text-zinc-400 text-sm mt-2 leading-relaxed">
          Your identity has been verified and your sub-account has been created.
          You can now use 3rike Pay to send money, buy airtime, and more.
        </p>
      </div>

      <button
        onClick={() => window.location.reload()}
        className="w-full bg-green-500 hover:bg-green-600 text-black font-semibold py-4 rounded-xl transition-colors"
      >
        Done
      </button>
    </div>
  );
}
