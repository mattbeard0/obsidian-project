/** Error type for expected failures that should be shown to the user as a clear message (not a stack trace). */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** Returns a string message for any thrown value (Error or non-Error). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
