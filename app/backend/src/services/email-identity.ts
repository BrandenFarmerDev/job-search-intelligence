import { digest } from "./security";

export function normalizeInternetMessageId(value: string): string { return value.trim().toLowerCase(); }
export interface EmailIdentityEvidence { subject: string; sender: string; occurredAt: string; conversationId: string }
function normalizeIdentityPart(value: string): string { return value.trim().replace(/\s+/g, " ").toLowerCase(); }
export async function emailReferenceId(account: string, immutableId: string, internetMessageId: string, evidence?: EmailIdentityEvidence): Promise<string> {
  const internet = normalizeInternetMessageId(internetMessageId);
  if (internet) return digest(`internet-message:${internet}`);
  if (evidence) {
    const conversation = normalizeIdentityPart(evidence.conversationId);
    const fallback = [normalizeIdentityPart(evidence.subject), new Date(evidence.occurredAt).toISOString(), conversation || normalizeIdentityPart(evidence.sender)].join("|");
    return digest(`message-fingerprint:${fallback}`);
  }
  return digest(`${account}:${immutableId}`);
}
