import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { BusinessHero } from "@/components/sections/BusinessHero";
import { BusinessFlow } from "@/components/sections/BusinessFlow";
import { Fees } from "@/components/sections/Fees";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { BUSINESS_FAQS } from "@/data/content";

export default function Business() {
  useDocumentMeta({
    title: "3rike Pay for business — bill a customer in one message",
    description:
      "Raise an itemised invoice from the chat you already use. The payment prompt lands on your customer's phone and the money lands in your wallet, with every fee shown.",
  });

  return (
    <>
      <BusinessHero />
      <BusinessFlow />
      <Fees />
      <Faq items={BUSINESS_FAQS} title="What shop owners ask" />
      <CtaBand
        title={
          <>
            Start billing from your{" "}
            <span className="accent">chat</span>.
          </>
        }
        body="Say hi, set up your business profile, and raise your first invoice in the same conversation."
      />
    </>
  );
}
