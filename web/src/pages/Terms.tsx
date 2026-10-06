import { Legal } from "@/components/layout/Legal";
import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { SUPPORT_EMAIL } from "@/lib/site";

/**
 * NOT LEGAL ADVICE. This is a plain-language starting draft that reflects what
 * the product actually does, so the site can go in front of Meta and payment
 * partners. Have a Nigerian lawyer review it before launch, and fill in the
 * registered company name and address where marked.
 */
export default function Terms() {
  useDocumentMeta({
    title: "Terms of use — 3rike Pay",
    description: "The terms that apply when you use 3rike Pay on WhatsApp.",
  });

  return (
    <Legal title="Terms of use" updated="6 October 2026">
      <section>
        <p>
          These terms apply when you use 3rike Pay, a service that lets you move
          money and issue invoices through WhatsApp. By messaging 3rike Pay and
          completing verification, you agree to them.
        </p>
      </section>

      <section>
        <h2>Who we are</h2>
        <p>
          3rike Pay is operated by 3rike. We are not a bank. Accounts, transfers
          and collections are provided by licensed financial institutions and
          payment processors we work with, and those partners hold your funds.
        </p>
      </section>

      <section>
        <h2>Opening an account</h2>
        <p>
          You must be at least 18 and resident in Nigeria. To use the service you
          verify your identity with your NIN or BVN and confirm a one-time code
          sent to the phone number registered to that ID. You must give accurate
          information, and the WhatsApp number you use must be your own.
        </p>
      </section>

      <section>
        <h2>Your PIN</h2>
        <p>
          You set a four-digit PIN that authorises transfers. Keep it to
          yourself. We store only a one-way hash of it, which means we cannot
          read it, recover it or tell it to you. Anyone who has both your phone
          and your PIN can move your money, so treat the two as you would your
          card and its PIN.
        </p>
      </section>

      <section>
        <h2>Transfers</h2>
        <ul>
          <li>
            Before a transfer leaves, we look up the destination account and show
            you the name on it. Confirming that summary is your instruction to
            send, and you are responsible for checking it.
          </li>
          <li>
            A completed transfer cannot be reversed by us. If you send to the
            wrong account, contact us and we will help you raise a recall with
            the receiving institution, but we cannot guarantee the outcome.
          </li>
          <li>
            Transfer amounts are subject to minimum and maximum limits, which we
            may change. Your available balance must cover the amount and any fee.
          </li>
        </ul>
      </section>

      <section>
        <h2>Invoices and collections</h2>
        <p>
          If you use 3rike Pay to bill customers, you are responsible for what
          you sell, for the accuracy of what you invoice, and for your own
          dealings with your customers. Unpaid payment requests expire
          automatically. We deduct our fee and the processor's charge at
          settlement and show both to you as separate lines.
        </p>
      </section>

      <section>
        <h2>Fees</h2>
        <p>
          Fees are shown to you in the chat before you confirm, and itemised when
          money settles. We may change fees, and will tell you before a change
          takes effect.
        </p>
      </section>

      <section>
        <h2>Things you must not do</h2>
        <ul>
          <li>Use the service for fraud, money laundering or terrorist financing.</li>
          <li>Use someone else's identity documents or someone else's WhatsApp line.</li>
          <li>Sell anything unlawful, or anything your payment processor prohibits.</li>
          <li>Attempt to interfere with, overload or reverse-engineer the service.</li>
        </ul>
        <p>
          We may suspend or close an account where we reasonably suspect any of
          the above, or where a partner, regulator or court requires it.
        </p>
      </section>

      <section>
        <h2>Availability</h2>
        <p>
          The service depends on WhatsApp, on our partners and on bank networks,
          none of which we control. We do not promise uninterrupted service, and
          we are not liable for delays caused by those systems. Where we are
          liable, our liability is limited to the amount of the transaction
          concerned.
        </p>
      </section>

      <section>
        <h2>Closing your account</h2>
        <p>
          You can ask us to close your account at any time. We will return any
          remaining balance to a Nigerian bank account in your name, after
          completing any checks we are required to make.
        </p>
      </section>

      <section>
        <h2>Changes and law</h2>
        <p>
          We may update these terms. The date at the top shows when they last
          changed, and continuing to use the service means you accept the
          current version. These terms are governed by the laws of the Federal
          Republic of Nigeria.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these terms go to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
      </section>
    </Legal>
  );
}
