export function normEmail(email?: string | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!e || !e.includes("@")) return null;
  return e.split(/[,\s;]/).map(s => s.trim()).find(s => s.includes("@")) ?? null;
}

export function normPhoneE164Digits(phone?: string | null): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D+/g, "");
  return d.length >= 7 ? d : null;
}

export function toUnixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}
