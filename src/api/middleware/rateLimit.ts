import rateLimit from 'express-rate-limit';

export const kycLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { error: 'Too many requests. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const notifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many notification requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const transferPinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // generous: allows retries within the per-user lockout window
  message: { error: 'Too many PIN attempts from this device. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
