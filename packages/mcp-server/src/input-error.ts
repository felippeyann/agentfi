import { z } from 'zod';

/**
 * An input error found by a handler (a rule across fields, or one that needs
 * the chain), reported exactly like a schema error: `code: INVALID_INPUT`
 * with the issue path, before anything reaches the backend.
 */
export function invalidInput(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: z.ZodIssueCode.custom, path: [path], message }]);
}
