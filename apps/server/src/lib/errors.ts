/**
 * Errore applicativo con status HTTP e codice stabile.
 * Il `code` è pensato per essere letto dal client; il `message` per l'umano.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, msg: string, details?: unknown) =>
  new AppError(400, code, msg, details);

export const unauthorized = (msg = 'Devi effettuare l’accesso') =>
  new AppError(401, 'unauthorized', msg);

export const forbidden = (msg = 'Non hai i permessi per questa azione') =>
  new AppError(403, 'forbidden', msg);

export const notFound = (msg = 'Risorsa non trovata') =>
  new AppError(404, 'not_found', msg);

export const conflict = (code: string, msg: string) => new AppError(409, code, msg);

export const tooMany = (msg = 'Troppe richieste, riprova tra poco') =>
  new AppError(429, 'rate_limited', msg);
