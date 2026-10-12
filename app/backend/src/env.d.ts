export {};
declare global {
  interface Env {
    MICROSOFT_CLIENT_SECRET: string;
    TOKEN_ENCRYPTION_KEY: string;
    GOOGLE_SERVICE_ACCOUNT_JSON: string;
    AUTOMATION_CLIENT_ID?: string;
    GMAIL_CLIENT_ID?: string;
    GMAIL_CLIENT_SECRET?: string;
    GMAIL_REDIRECT_URI?: string;
    GMAIL_MAILBOX?: string;
    GMAIL_SYNC_ENABLED?: string;
    GMAIL_SYNC_SOURCE?: string;
    GMAIL_SYNTHETIC_MAILBOX?: string;
    GMAIL_ENABLED?: string;
    MAIL_SOURCE?: string;
    ENVIRONMENT_NAME?: string;
    EXECUTION_BUDGET?: { reserveExternal(): void; reserveHandoff(): void };
  }
}
