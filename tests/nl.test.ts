import { describe, it, expect } from "vitest";
import {
  toRwandaPhone,
  isRwandaPhone,
  toWhatsAppPhone,
  formatCurrency,
  formatWalletLines,
  parseProductCreateRequest,
  parseInvoiceRequest,
  stripProductIntent,
} from "@/utils/helpers";
import { TRIGGERS } from "@/config/constants";

describe("toRwandaPhone", () => {
  it("accepts every Rwanda number shape", () => {
    expect(toRwandaPhone("+250781234567")).toBe("0781234567");
    expect(toRwandaPhone("250781234567")).toBe("0781234567");
    expect(toRwandaPhone("0781234567")).toBe("0781234567");
    expect(toRwandaPhone("781234567")).toBe("0781234567");
    expect(toRwandaPhone("078 123 4567")).toBe("0781234567");
    expect(toRwandaPhone("+250 78 123 4567")).toBe("0781234567");
  });

  it("accepts all Rwanda mobile prefixes (Airtel, KTRN, MTN)", () => {
    expect(toRwandaPhone("0721234567")).toBe("0721234567");
    expect(toRwandaPhone("0731234567")).toBe("0731234567");
    expect(toRwandaPhone("0771234567")).toBe("0771234567");
    expect(toRwandaPhone("0781234567")).toBe("0781234567");
    expect(toRwandaPhone("0791234567")).toBe("0791234567");
  });

  it("rejects numbers that are not Rwanda mobiles", () => {
    expect(toRwandaPhone("0751234567")).toBeNull(); // unknown prefix
    expect(toRwandaPhone("054709929220")).toBeNull(); // Ghana (docs bug)
    expect(toRwandaPhone("+15551234567")).toBeNull(); // US
    expect(toRwandaPhone("12345")).toBeNull();
    expect(toRwandaPhone("")).toBeNull();
    expect(toRwandaPhone("not a number")).toBeNull();
  });

  it("isRwandaPhone mirrors toRwandaPhone", () => {
    expect(isRwandaPhone("0781234567")).toBe(true);
    expect(isRwandaPhone("0751234567")).toBe(false);
  });
});

describe("toWhatsAppPhone", () => {
  it("renders Rwanda buyers as +250, not as a Nigerian number", () => {
    expect(toWhatsAppPhone("0781234567")).toBe("250781234567");
    expect(toWhatsAppPhone("0721234567")).toBe("250721234567");
    expect(toWhatsAppPhone("+250781234567")).toBe("250781234567");
    expect(toWhatsAppPhone("250781234567")).toBe("250781234567");
    expect(toWhatsAppPhone("781234567")).toBe("250781234567");
  });

  it("still renders Nigerian numbers the old way", () => {
    expect(toWhatsAppPhone("09167582901")).toBe("2349167582901");
    expect(toWhatsAppPhone("08031234567")).toBe("2348031234567");
    expect(toWhatsAppPhone("+2348031234567")).toBe("2348031234567");
    expect(toWhatsAppPhone("2348031234567")).toBe("2348031234567");
  });
});

describe("formatCurrency", () => {
  it("renders RWF with code and no fraction digits", () => {
    expect(formatCurrency(5000, "RWF")).toBe("RWF 5,000");
    expect(formatCurrency(1500)).toBe("RWF 1,500");
    expect(formatCurrency(0, "RWF")).toBe("RWF 0");
  });

  it("keeps other currencies working", () => {
    expect(formatCurrency(1000, "NGN")).toBe("NGN 1,000");
  });
});

describe("formatWalletLines", () => {
  it("prints one line per wallet currency", () => {
    expect(
      formatWalletLines([
        { currency: "NGN", balance: 0 },
        { currency: "RWF", balance: 12000 },
      ])
    ).toBe("NGN 0\nRWF 12,000");
  });

  it("falls back to a zero RWF line so the reply always has the same shape", () => {
    expect(formatWalletLines([])).toBe("RWF 0");
    expect(formatWalletLines()).toBe("RWF 0");
  });
});

describe("parseProductCreateRequest", () => {
  it("parses the common shapes", () => {
    expect(parseProductCreateRequest("product Batteries 1000")).toEqual({
      name: "Batteries",
      price: 1000,
    });
    expect(parseProductCreateRequest("add product: Umbrella at 5000")).toEqual({
      name: "Umbrella",
      price: 5000,
    });
    expect(parseProductCreateRequest("new product 1kg rice RWF 2500")).toEqual({
      name: "1kg rice",
      price: 2500,
    });
    expect(parseProductCreateRequest("product Water bottle 1,500")).toEqual({
      name: "Water bottle",
      price: 1500,
    });
    expect(parseProductCreateRequest("add item Coke @ 700")).toEqual({
      name: "Coke",
      price: 700,
    });
  });

  it("returns null without intent, price or name", () => {
    expect(parseProductCreateRequest("hello there")).toBeNull();
    expect(parseProductCreateRequest("product Batteries")).toBeNull();
    expect(parseProductCreateRequest("product 1500")).toBeNull();
    expect(parseProductCreateRequest("")).toBeNull();
  });

  it("can skip the intent check when the caller already established it", () => {
    expect(parseProductCreateRequest("Batteries 1000", false)).toEqual({
      name: "Batteries",
      price: 1000,
    });
  });
});

describe("parseInvoiceRequest", () => {
  it("parses items and the buyer phone", () => {
    const result = parseInvoiceRequest(
      "invoice 3 batteries and 2 water for 0781234567"
    );
    expect(result?.buyerPhone).toBe("0781234567");
    expect(result?.items).toEqual([
      { name: "batteries", qty: 3, unitPrice: null },
      { name: "water", qty: 2, unitPrice: null },
    ]);
  });

  it("parses inline prices", () => {
    const result = parseInvoiceRequest("charge 0781234567 2 waters at 1500");
    expect(result?.buyerPhone).toBe("0781234567");
    expect(result?.items).toEqual([
      { name: "waters", qty: 2, unitPrice: 1500 },
    ]);
  });

  it("accepts international phone shapes", () => {
    const result = parseInvoiceRequest(
      "bill 1 water bottle at 1000 to +250781234567"
    );
    expect(result?.buyerPhone).toBe("0781234567");
    expect(result?.items).toEqual([
      { name: "water bottle", qty: 1, unitPrice: 1000 },
    ]);
  });

  it("treats a big leading number as a price, not a count", () => {
    const result = parseInvoiceRequest("invoice 1000 water bottle");
    expect(result?.items).toEqual([
      { name: "water bottle", qty: 1, unitPrice: 1000 },
    ]);
  });

  it("treats small leading numbers as quantities", () => {
    const result = parseInvoiceRequest("invoice 3 batteries");
    expect(result?.items).toEqual([
      { name: "batteries", qty: 3, unitPrice: null },
    ]);
  });

  it("parses comma separated lines", () => {
    const result = parseInvoiceRequest(
      "invoice 2 rice, 3 soda for 0781234567"
    );
    expect(result?.items).toEqual([
      { name: "rice", qty: 2, unitPrice: null },
      { name: "soda", qty: 3, unitPrice: null },
    ]);
  });

  it("does not eat the first letter of an item after stripping the keyword", () => {
    const result = parseInvoiceRequest(
      "payment request: airtime 500, data bundle 2000 to 250781234567"
    );
    expect(result?.buyerPhone).toBe("0781234567");
    expect(result?.items).toEqual([
      { name: "airtime", qty: 1, unitPrice: 500 },
      { name: "data bundle", qty: 1, unitPrice: 2000 },
    ]);
  });

  it("reaches the bot trigger list for every shape the parser accepts", () => {
    const messages = [
      "charge 0781234567 2 waters at 1500",
      "invoice 3 batteries",
      "bill 1000 water bottle",
      "request payment for 1 soda at 300",
      "payment request: airtime 500",
      "payment 500 water",
      "request 3 water",
    ];
    for (const message of messages) {
      const lower = message.toLowerCase();
      expect(
        TRIGGERS.INVOICE.some((kw) => lower.includes(kw)),
        `no TRIGGERS.INVOICE keyword matched: ${message}`
      ).toBe(true);
    }
  });

  it("returns null without intent or items", () => {
    expect(parseInvoiceRequest("hello there")).toBeNull();
    expect(parseInvoiceRequest("invoice")).toBeNull();
    expect(parseInvoiceRequest("invoice for 0781234567")).toBeNull();
  });

  it("leaves buyerPhone null when the message has no number", () => {
    const result = parseInvoiceRequest("invoice 3 batteries");
    expect(result?.buyerPhone).toBeNull();
  });

  it("parses bare item lines once the caller established intent", () => {
    expect(parseInvoiceRequest("3 batteries and 2 water", false)).toEqual({
      buyerPhone: null,
      items: [
        { name: "batteries", qty: 3, unitPrice: null },
        { name: "water", qty: 2, unitPrice: null },
      ],
    });
    expect(parseInvoiceRequest("3 batteries", true)).toBeNull();
  });
});

describe("stripProductIntent", () => {
  it("removes the intent phrase only", () => {
    expect(stripProductIntent("add product Batteries")).toBe("Batteries");
    expect(stripProductIntent("product:")).toBe("");
    expect(stripProductIntent("new item")).toBe("");
    expect(stripProductIntent("Batteries")).toBe("Batteries");
  });
});
