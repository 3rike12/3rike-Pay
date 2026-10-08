import { Link } from "react-router-dom";
import { useDocumentMeta } from "@/lib/useDocumentMeta";

export default function NotFound() {
  useDocumentMeta({
    title: "Page not found — 3rike Pay",
    description: "That page doesn't exist.",
  });

  return (
    <section className="shell flex min-h-[72vh] flex-col justify-center py-32">
      {/* An empty state is an invitation to act, not an apology. */}
      <p className="eyebrow mb-5 text-green-deep">No such page</p>
      <h1 className="display-section max-w-[18ch] font-display text-balance">
        This one isn&rsquo;t here. The money still is.
      </h1>
      <p className="mt-6 max-w-[42ch] text-[1.0625rem] leading-relaxed text-ink-700">
        Head back to the start, or go straight to the chat and send something.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link
          to="/"
          className="rounded-full bg-green px-6 py-3.5 text-[0.9375rem] font-semibold text-ink shadow-[0_8px_22px_-10px_rgba(1,194,89,0.9)] transition-all duration-300 ease-brand hover:bg-green-hover active:scale-[0.98]"
        >
          Back to home
        </Link>
        <Link
          to="/business"
          className="rounded-full border border-ink/15 bg-paper-pure/60 px-6 py-3.5 text-[0.9375rem] font-semibold transition-all duration-300 ease-brand hover:border-ink/35 hover:bg-paper-pure"
        >
          For business
        </Link>
      </div>
    </section>
  );
}
