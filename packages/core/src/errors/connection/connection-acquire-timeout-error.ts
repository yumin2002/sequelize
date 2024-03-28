import { ConnectionError } from '../connection-error';

/**
 * Thrown when connection is not acquired due to timeout
 */
export class ConnectionAcquireTimeoutError extends ConnectionError {
  constructor(_message: string, cause: Error) {
    super(cause);
    this.name = 'SequelizeConnectionAcquireTimeoutError';
  }
}
