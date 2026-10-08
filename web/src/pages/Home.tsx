import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { Hero } from "@/components/sections/Hero";
import { BankBand } from "@/components/sections/BankBand";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Language } from "@/components/sections/Language";
import { Capabilities } from "@/components/sections/Capabilities";
import { Security } from "@/components/sections/Security";
import { Testimonials } from "@/components/sections/Testimonials";
import { Faq } from "@/components/sections/Faq";
import { CtaBand } from "@/components/sections/CtaBand";
import { FAQS } from "@/data/content";

/**
 * Band rhythm, deliberately alternating so no two neighbours share a ground:
 * paper hero → night banks → paper steps → wash language → night capabilities
 * → pure security → paper quotes → paper FAQ → night close.
 */
export default function Home() {
  useDocumentMeta({
    title: "3rike Pay — send money the way you'd say it",
    description:
      "Type one line in WhatsApp and it reaches any Nigerian bank account. Nothing to download, nothing to fill in.",
  });

  return (
    <>
      <Hero />
      <BankBand />
      <HowItWorks />
      <Language />
      <Capabilities />
      <Security />
      <Testimonials />
      <Faq items={FAQS} />
      <CtaBand />
    </>
  );
}
