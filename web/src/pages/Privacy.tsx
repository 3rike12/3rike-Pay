import { Legal } from "@/components/layout/Legal";
import { useDocumentMeta } from "@/lib/useDocumentMeta";
import { SUPPORT_EMAIL } from "@/lib/site";

/**
 * NOT LEGAL ADVICE. A plain-language starting draft that describes the data this
 * codebase actually handles. Have a Nigerian lawyer review it against the NDPA
 * 2023 before launch, and add the registered entity details and your DPO
 * contact where marked.
 *
 * INCOMPLETE: written against the NDPA alone. Rwandan merchants' data is
 * processed too — phone numbers, invoices, settlement records — and Rwanda's
 * Law No. 058/2021 on personal data protection is not addressed anywhere
 * below. That gap needs Rwandan counsel before launch, not after.
 */
export default function Privacy() {
  useDocumentMeta({
    title: "Privacy policy — 3rike Pay",
    description: "What 3rike Pay collects, why, and how long we keep it.",
  });

  return (
    <Legal title="Privacy policy" updated="6 October 2026">
      <section>
        <p>
          This explains what 3rike Pay collects, why we need it, and what we do
          with it. We have tried to write it in plain language rather than in the
          language of a policy nobody reads.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>Your WhatsApp number.</strong> It is how we recognise you.
            There is no username and no password.
          </li>
          <li>
            <strong>Identity details.</strong> Your NIN or BVN, and the name and
            date of birth returned against it, which we are required to verify
            before you can hold an account.
          </li>
          <li>
            <strong>Your PIN, as a one-way hash.</strong> We never store the
            digits themselves, so we cannot read your PIN or tell it to you.
          </li>
          <li>
            <strong>Transactions.</strong> Amounts, destination account numbers,
            bank names, references and timestamps.
          </li>
          <li>
            <strong>The messages you send us.</strong> The instructions you type
            in the chat, so we can carry them out.
          </li>
        </ul>
      </section>

      <section>
        <h2>What we do not collect</h2>
        <p>
          We do not read your other WhatsApp conversations — we only receive the
          messages you send to 3rike Pay. We do not have access to your contacts,
          your photos or your other accounts.
        </p>
      </section>

      <section>
        <h2>Why we need it</h2>
        <p>
          To carry out the instructions you give us, to meet the identity and
          record-keeping obligations that apply to financial services in Nigeria,
          to detect and prevent fraud, and to support you when something goes
          wrong.
        </p>
      </section>

      <section>
        <h2>Who we share it with</h2>
        <ul>
          <li>
            The licensed institutions and payment processors who hold funds and
            execute transfers and collections for you.
          </li>
          <li>
            Identity verification providers, to confirm your NIN or BVN.
          </li>
          <li>
            WhatsApp, which carries the messages. Your identity details are
            typed into an encrypted WhatsApp form rather than sent as a chat
            message.
          </li>
          <li>
            Regulators, law enforcement and courts, where we are legally required
            to.
          </li>
        </ul>
        <p>We do not sell your data, and we do not use it for advertising.</p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <p>
          Transaction and identity records are kept for the period Nigerian
          financial regulations require, which outlasts the closing of your
          account. Short-lived session data — the half-finished transfer you are
          in the middle of — expires on its own within minutes or hours.
        </p>
      </section>

      <section>
        <h2>How it is protected</h2>
        <p>
          Identity forms are encrypted on your handset and decrypted only by our
          server. Your PIN is hashed before storage. PIN attempts are rate
          limited and then locked out. Access to production data is restricted to
          the people who need it to run the service.
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Under the Nigeria Data Protection Act you can ask us for a copy of your
          data, ask us to correct it, ask us to delete what we are not required
          to keep, and object to how we use it. Write to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will
          respond within 30 days. If you are not satisfied, you can complain to
          the Nigeria Data Protection Commission.
        </p>
      </section>

      <section>
        <h2>If your phone is lost</h2>
        <p>
          Message us from any device, or email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, and we will
          freeze your account. Your PIN is still required for any transfer, so a
          thief with your handset alone cannot move money.
        </p>
      </section>

      <section>
        <h2>Changes</h2>
        <p>
          If we change this policy we will update the date at the top and, where
          the change is significant, tell you in the chat.
        </p>
      </section>
    </Legal>
  );
}
