/**
 * Masks a phone number for display, preserving the country code and last 4 digits.
 * e.g. +263771234567 → "+263 *** 4567"
 * Do NOT use inside text input fields where the user is actively editing.
 */
export function maskPhone(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  let countryCode = '+';
  let codeLength = 1;
  if (phone.startsWith('+263')) { countryCode = '+263'; codeLength = 3; }
  else if (phone.startsWith('+1')) { countryCode = '+1'; codeLength = 1; }
  else if (phone.startsWith('+27')) { countryCode = '+27'; codeLength = 2; }
  const masked = '*'.repeat(Math.max(0, digits.length - codeLength - 4));
  return `${countryCode} ${masked} ${last4}`;
}
