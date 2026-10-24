export class ArchaeologistError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ArchaeologistError";
    this.exitCode = exitCode;
  }
}

export function toArchaeologistError(err: unknown, context: string): ArchaeologistError {
  if (err instanceof ArchaeologistError) return err;
  if (err instanceof Error) return new ArchaeologistError(`${context}: ${err.message}`);
  return new ArchaeologistError(context);
}
