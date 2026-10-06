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
      <p className="stamp mb-5">No such page</p>
      <h1 className="display-lg max-w-[20ch]">
        This one isn&rsquo;t here. The money still is.
      </h1>
      <p className="mt-6 max-w-[42ch] text-[1.0625rem] text-ink/65">
        Head back to the start, or go straight to the chat and send something.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link
          to="/"
          className="bubble-out bg-green px-6 py-3.5 text-[0.9375rem] font-semibold text-ink transition-colors hover:bg-lime"
        >
          Back to home
        </Link>
        <Link
          to="/business"
          className="bubble-out border border-ink/15 px-6 py-3.5 text-[0.9375rem] font-semibold transition-colors hover:bg-mist"
        >
          For business
        </Link>
      </div>
    </section>
  );
}
