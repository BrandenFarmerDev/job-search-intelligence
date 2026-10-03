export {};
declare global {
  interface Env {
    MICROSOFT_CLIENT_SECRET: string;
    TOKEN_ENCRYPTION_KEY: string;
    GOOGLE_SERVICE_ACCOUNT_JSON: string;
  }
}
