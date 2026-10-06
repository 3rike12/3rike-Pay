import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { BusinessHero } from "@/components/sections/BusinessHero";
import { BusinessFeatures } from "@/components/sections/BusinessFeatures";
import { Settlement } from "@/components/sections/Settlement";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { BUSINESS_FAQS } from "@/data/content";

export default function Business() {
  useDocumentMeta({
    title: "3rike Pay for business — bill a customer in one message",
    description:
      "Raise an itemised invoice from the chat you already use. The payment prompt lands on your customer's phone and the money lands in your wallet.",
  });

  return (
    <>
      <BusinessHero />
      <BusinessFeatures />
      <Settlement />
      <Faq items={BUSINESS_FAQS} title="Questions shop owners ask." />
      <CtaBand
        title="Start billing from your chat."
        body="Say hi, set up your business profile, and raise your first invoice in the same conversation."
      />
    </>
  );
}
