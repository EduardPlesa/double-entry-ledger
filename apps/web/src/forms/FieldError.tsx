import { ApiError } from '../api/problem';

export function FieldError({ message }: { message: string | undefined }) {
  if (message === undefined) return null;
  return <p className="text-sm text-red-700">{message}</p>;
}

/**
 * A failure that belongs on a field rather than in a toast.
 *
 * `EMAIL_ALREADY_REGISTERED` is the case this exists for: it is a fact about the database, so
 * no client-side schema can know it, and it belongs on the email input rather than floating in
 * the corner of the screen away from the field it is about.
 */
export function isCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}
