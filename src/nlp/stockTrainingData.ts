import type { Example } from "@/nlp/classifier";

// ============================================
// What people say, by intent
//
// The classifier learns from these. To teach it a new phrasing, add it here under the right
// label and run the tests: the held-out checks in tests/stockClassifier.test.ts say whether it
// still gets everything else right.
//
//  - "other" is every message the stock bot must NOT claim: invoices, balance, top-up,
//    cash-out, greetings. It is as important as any real intent, because the stock handler
//    sees messages before the rest of the bot does.
//  - Typos and short-hand are included on purpose.
//  - The Swahili and Pidgin lines are a starting point written without a native check; replace
//    or extend them with how your users really write.
// ============================================

const L: Record<string, string[]> = {
  list: [
    "what stocks do you have", "list stocks", "list the stocks", "available stocks", "which stocks can i buy", "show me the stocks",
    "what can i invest in", "what companies can i buy", "stock list", "what shares are there", "show all stocks", "what stocks are available",
    "wat stocks do u have", "which shares do you offer", "see the stocks", "what stocks can i trade", "stocks available",
    "nionyeshe hisa zilizopo", "show available shares", "what stocks can people buy here", "which companies do you have", "whats on the stock list",
  ],
  holdings: [
    "my stocks", "my portfolio", "what do i own", "show my holdings", "how much stock do i have", "what is my portfolio worth", "wats my stuff worth",
    "my shares", "stocks i hold", "check my investments", "how are my investments doing", "portfolio", "show my portfolio", "what stocks do i have",
    "my stock balance", "how much are my stocks worth", "what do i hold", "my investments", "show me what i own", "how is my portfolio doing",
    "whats my portfolio", "my stoks", "my porfolio", "my stcks please", "what shares do i currently have", "value of my holdings", "hisa zangu", "how far my stocks", "wetin i get for stocks", "check my shares",
  ],
  quote: [
    "price of tesla", "tesla price", "how much is nvidia", "what is nvidia trading at", "wats nvidia trading at", "nvdia price", "what is apple at",
    "current price apple", "how is meta doing", "check microsoft", "apple stock", "tesla today", "how is tesla doing today", "price for amd",
    "what is the price of nvidia", "nvidia how much", "tesla stock price", "how much is a share of apple", "whats microsoft at right now", "teslaa price",
    "nvida price now", "bei ya tesla", "apple price please", "show me the price of meta", "what does nvidia cost", "quote for tesla",
  ],
  research: [
    "why is tesla down", "why did nvidia jump", "is nvidia a good buy", "should i hold tesla", "explain apple stock", "compare tesla and nvidia",
    "what do you think about meta", "is apple safe", "whats going on with nvidia", "any news on tesla", "tell me about nvidia", "what happened to tesla stock",
    "why is nvidia up", "why did apple fall today", "is tesla risky", "should i sell my nvidia", "is microsoft worth buying", "analyse amd for me",
    "what is driving nvidia", "news about apple", "why is the market down", "whats the story with tesla", "should i keep my apple", "wy is tesla up",
    "is it a good time to buy nvidia", "what are analysts saying about meta", "how risky is tesla", "tell me why nvidia moved", "wetin dey happen with tesla",
  ],
  plan: [
    "what should i buy with 5000", "i have money to invest what do i do", "suggest a portfolio for me", "help me pick stocks", "where should i put my money",
    "recommend some stocks", "build me a portfolio", "best stocks to buy now", "which stock should i invest in", "i have 10000 a month what should i buy",
    "give me a plan to invest", "how should i split my money across stocks", "what should i invest in", "pick stocks for me", "plan my investments", "give me stock picks", "i need stock ideas", "what should i invest in", "which stocks should i pick",
    "i want to start investing where do i begin", "what stocks should i start with", "make me an investment plan", "wat should i buy", "diversify my money",
  ],
  show_target: [
    "show my target mix", "what is my target", "my target allocation", "what did i set as my target", "my target mix", "show my allocation target",
    "what is my target split", "view my target", "my target portfolio", "whats my target mix",
  ],
  rebalance: [
    "rebalance", "rebalance my portfolio", "am i balanced", "is my mix off", "fix my portfolio mix", "check my allocation", "has my portfolio drifted",
    "is my portfolio on target", "rebalence", "rebalnce", "rebalance my stocks now", "is my portfolio lopsided", "has my mix moved from my target", "is my mix off target", "get me back to my target", "balance my stocks", "are my stocks in balance", "adjust my portfolio to my target",
    "check my mix", "is my allocation still right",
  ],
  stocks_help: [
    "how do stocks work here", "how do i buy stocks", "what can i do with stocks", "how does investing work", "teach me stocks", "explain tokenized stocks",
    "what are tokenized stocks", "stock commands", "help with stocks", "how do i start investing", "what is a tokenized stock", "how do i invest here",
    "how do i use the stock feature", "what can you do with stocks", "i am new to stocks", "how does this stock thing work", "stocks help", "investing help",
    "how can i buy shares", "what is the stock feature", "how can i buy a stock here", "how does investing here work", "what are tokenised shares",
  ],
  buy_hint: [
    "i want to buy stocks", "buy some stock", "i wanna invest", "can i buy shares", "id like to buy a stock", "i want to buy nvidia", "buy tesla",
    "get me some apple", "purchase nvidia shares", "i want to invest in tesla", "let me buy some shares", "i would like to buy microsoft", "buy me some meta",
    "i want to purchase stock", "nataka kununua hisa", "abeg make i buy stock", "buy apple shares", "can i invest in nvidia", "i need to buy stocks", "get some tesla",
  ],
  sell_hint: [
    "i want to sell stocks", "sell my shares", "sell tesla", "cash out my stocks", "i wanna sell nvidia", "i want to sell my apple", "let me sell some shares",
    "sell some of my stock", "i need to sell my shares", "can i sell my stocks", "get rid of my tesla", "i want out of nvidia", "sell my portfolio",
    "nataka kuuza hisa", "i want to sell some stock", "sell apple shares", "can i sell my shares", "sell some of my nvidia", "sell a few shares", "i would like to sell some stock", "how do i sell my stocks", "exit my tesla position",
  ],
  other: [
    "hello", "hi", "hey there", "good morning", "thanks", "thank you", "ok", "okay cool", "yes", "no", "cancel", "menu", "help", "what can you do",
    "create an invoice", "request payment from a customer", "send an invoice to my customer", "show my invoices", "my invoices", "new invoice", "invoice for 5000",
    "check my balance", "balance", "what is my balance", "how much money do i have", "my wallet balance", "show my balance",
    "add money", "top up my balance", "top up", "deposit funds", "fund my wallet", "how do i add money",
    "cash out", "cash out to my bank", "withdraw money", "withdraw to my bank account", "send my balance to a bank",
    "add a product", "my products", "create a product", "product catalogue", "add an item to my shop",
    "business profile", "set up my shop", "change my currency", "set currency to kes", "payments i received", "show my payments", "recent payments", "my transactions",
    "verify my identity", "kyc", "i need to verify", "send money to a friend", "transfer money", "buy airtime", "buy data", "pay my bill",
    "what is 3rike", "who are you", "i have a problem", "something went wrong with my payment", "my payment is pending", "where is my money",
    "change my pin", "reset my password", "contact support", "talk to a human", "how do i get paid", "can customers pay in crypto", "share my pay link",
    "good night", "bye", "lol", "wow nice", "asante", "habari", "how far", "i dey fine",
  ],
};

export const STOCK_TRAINING: Example[] = Object.entries(L).flatMap(([label, texts]) => texts.map((text) => ({ label, text })));
