import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const messages = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return res.status(400).json({ error: messages[0], details: messages });
      }
      next(error);
    }
  };
}
