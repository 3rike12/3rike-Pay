/**
 * A refusal that is safe and useful to show the person as it is (a limit, a
 * market condition, the service being off). Anything else that goes wrong is an
 * internal error and is shown as a generic message: a database or network error
 * should never reach someone's WhatsApp.
 */
export class OrderRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderRefused";
  }
}
