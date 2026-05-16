// src/utils/country.ts
// Phone → country resolver. Mirrors shared/user_context._COUNTRY_CODES so the
// on-device assistant can produce the same country-flavoured cultural context
// the cloud endpoint emits via detect_country_from_phone(). Longest prefix
// wins so +263 (Zimbabwe) beats +2 (no entry).

const COUNTRY_CODES: Record<string, string> = {
  '+263': 'Zimbabwe',
  '+260': 'Zambia',
  '+265': 'Malawi',
  '+255': 'Tanzania',
  '+27':  'South Africa',
  '+267': 'Botswana',
  '+264': 'Namibia',
  '+258': 'Mozambique',
  '+243': 'DRC',
  '+254': 'Kenya',
  '+234': 'Nigeria',
  '+233': 'Ghana',
  '+256': 'Uganda',
  '+250': 'Rwanda',
  '+251': 'Ethiopia',
  '+212': 'Morocco',
  '+216': 'Tunisia',
  '+20':  'Egypt',
  '+1':   'US/Canada',
  '+44':  'UK',
};

const SORTED_PREFIXES = Object.keys(COUNTRY_CODES).sort((a, b) => b.length - a.length);

export function detectCountryFromPhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  for (const prefix of SORTED_PREFIXES) {
    if (phone.startsWith(prefix)) return COUNTRY_CODES[prefix];
  }
  return undefined;
}
