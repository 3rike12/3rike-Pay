import { Route, Routes } from "react-router-dom";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { useLenis } from "@/lib/useLenis";
import Home from "@/pages/Home";
import Business from "@/pages/Business";
import Terms from "@/pages/Terms";
import Privacy from "@/pages/Privacy";
import Doc from "@/pages/Doc";
import NotFound from "@/pages/NotFound";

export default function App() {
  useLenis();

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:bubble-out focus:bg-ink focus:px-4 focus:py-2.5 focus:text-[0.875rem] focus:font-semibold focus:text-paper"
      >
        Skip to content
      </a>

      <Nav />

      <main id="main" className="scroll-mt-24">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/business" element={<Business />} />
          <Route path="/doc" element={<Doc />} />
          <Route path="/doc/:slug" element={<Doc />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <Footer />
    </>
  );
}
