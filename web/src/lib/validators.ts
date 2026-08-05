import { z } from 'zod';

export const phoneSchema = z
  .string()
  .min(11, 'Phone number must be 11 digits')
  .max(11, 'Phone number must be 11 digits')
  .regex(/^0[789][01]\d{7,8}$/, 'Enter a valid Nigerian phone number');

export const emailSchema = z
  .string()
  .min(1, 'Email is required')
  .email('Enter a valid email address');

export const bvnSchema = z
  .string()
  .length(11, 'BVN must be exactly 11 digits')
  .regex(/^\d{11}$/, 'BVN must contain only numbers');

export const otpSchema = z
  .string()
  .min(4, 'OTP must be 4-6 digits')
  .max(6, 'OTP must be 4-6 digits')
  .regex(/^\d+$/, 'OTP must contain only numbers');

export const kycFormSchema = z.object({
  phone: phoneSchema,
  email: emailSchema,
  bvn: bvnSchema,
});

export type KycFormData = z.infer<typeof kycFormSchema>;
