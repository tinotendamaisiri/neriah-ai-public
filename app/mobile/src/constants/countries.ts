// src/constants/countries.ts
// Countries available in the phone country-code picker.
// Ordered: SADC first, rest of Africa, then US.

export interface Country {
  code: string;  // ISO 3166-1 alpha-2
  dial: string;  // E.164 prefix, e.g. "+263"
  flag: string;  // flag emoji
  name: string;  // display name
  digits: number; // expected local digits (after dial code, without leading 0)
}

export const COUNTRIES: Country[] = [
  { code: 'ZW', dial: '+263', flag: '🇿🇼', name: 'Zimbabwe',       digits: 9 },
  { code: 'ZA', dial: '+27',  flag: '🇿🇦', name: 'South Africa',   digits: 9 },
  { code: 'ZM', dial: '+260', flag: '🇿🇲', name: 'Zambia',         digits: 9 },
  { code: 'MW', dial: '+265', flag: '🇲🇼', name: 'Malawi',         digits: 9 },
  { code: 'TZ', dial: '+255', flag: '🇹🇿', name: 'Tanzania',       digits: 9 },
  { code: 'BW', dial: '+267', flag: '🇧🇼', name: 'Botswana',       digits: 8 },
  { code: 'NA', dial: '+264', flag: '🇳🇦', name: 'Namibia',        digits: 9 },
  { code: 'MZ', dial: '+258', flag: '🇲🇿', name: 'Mozambique',     digits: 9 },
  { code: 'CD', dial: '+243', flag: '🇨🇩', name: 'DR Congo',       digits: 9 },
  { code: 'AO', dial: '+244', flag: '🇦🇴', name: 'Angola',         digits: 9 },
  { code: 'KE', dial: '+254', flag: '🇰🇪', name: 'Kenya',          digits: 9 },
  { code: 'UG', dial: '+256', flag: '🇺🇬', name: 'Uganda',         digits: 9 },
  { code: 'RW', dial: '+250', flag: '🇷🇼', name: 'Rwanda',         digits: 9 },
  { code: 'NG', dial: '+234', flag: '🇳🇬', name: 'Nigeria',        digits: 10 },
  { code: 'GH', dial: '+233', flag: '🇬🇭', name: 'Ghana',          digits: 9 },
  { code: 'ET', dial: '+251', flag: '🇪🇹', name: 'Ethiopia',       digits: 9 },
  { code: 'SN', dial: '+221', flag: '🇸🇳', name: 'Senegal',        digits: 9 },
  { code: 'CM', dial: '+237', flag: '🇨🇲', name: 'Cameroon',       digits: 9 },
  { code: 'CI', dial: '+225', flag: '🇨🇮', name: "Côte d'Ivoire",  digits: 10 },
  { code: 'MG', dial: '+261', flag: '🇲🇬', name: 'Madagascar',     digits: 9 },
  { code: 'EG', dial: '+20',  flag: '🇪🇬', name: 'Egypt',          digits: 10 },
  { code: 'MA', dial: '+212', flag: '🇲🇦', name: 'Morocco',        digits: 9 },
  { code: 'DZ', dial: '+213', flag: '🇩🇿', name: 'Algeria',        digits: 9 },
  { code: 'TN', dial: '+216', flag: '🇹🇳', name: 'Tunisia',        digits: 8 },
  { code: 'US', dial: '+1',   flag: '🇺🇸', name: 'United States',  digits: 10 },
];

/** Default country code when device region is unknown or not in the list. */
export const DEFAULT_COUNTRY_CODE = 'ZW';

/** Default digit count when country not in list. */
export const DEFAULT_DIGITS = 9;
