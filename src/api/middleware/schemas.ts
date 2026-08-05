import { z } from 'zod';

export const initiateKycSchema = z.object({
  phone: z
    .string()
    .min(11, 'Phone must be 11 digits')
    .max(11, 'Phone must be 11 digits')
    .regex(/^0[789][01]\d{7,8}$/, 'Invalid Nigerian phone number'),
  email: z.string().email('Invalid email address'),
  bvn: z
    .string()
    .length(11, 'BVN must be exactly 11 digits')
    .regex(/^\d{11}$/, 'BVN must contain only numbers'),
});

export const validateKycSchema = z.object({
  identityId: z.string().min(1, 'identityId is required'),
  bvn: z
    .string()
    .length(11, 'BVN must be exactly 11 digits')
    .regex(/^\d{11}$/, 'BVN must contain only numbers'),
  otp: z
    .string()
    .min(4, 'OTP must be 4-6 digits')
    .max(6, 'OTP must be 4-6 digits')
    .regex(/^\d+$/, 'OTP must contain only numbers'),
});

export const completeKycSchema = z.object({
  phone: z.string().min(11).max(11),
  email: z.string().email(),
  bvn: z.string().length(11),
  identityId: z.string().optional(),
});

export const resendKycSchema = z.object({
  bvn: z
    .string()
    .length(11, 'BVN must be exactly 11 digits')
    .regex(/^\d{11}$/),
});
