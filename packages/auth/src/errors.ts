/**
 * Indicates that an incoming identity could not be authenticated.  The API
 * boundary deliberately maps this to a generic response so token-verifier
 * details never reach a browser client.
 */
export class AuthenticationError extends Error {
  constructor() {
    super("authentication failed");
    this.name = "AuthenticationError";
  }
}
