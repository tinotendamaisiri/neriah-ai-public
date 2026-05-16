// src/components/PhoneInput.tsx
// Combined country-code selector + local number input.
// Produces a fully-formed E.164 phone number via onChangePhone.
//
// Layout: [ 🇿🇼 +263 ▾ | 771 234 567                    ]
//
// Behaviour:
//   - Default country detected from device locale (expo-localization), fallback ZW.
//   - Leading zero stripped from local number ("0771234567" → "+263771234567").
//   - Tapping the dial-code button opens a searchable modal.
//   - onChangePhone is called on every keystroke with the current E.164 string.
//     Returns '' when localNumber is empty so the parent can detect an incomplete value.

import React, { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Localization from 'expo-localization';
import { COLORS } from '../constants/colors';
import { COUNTRIES, Country, DEFAULT_COUNTRY_CODE, DEFAULT_DIGITS } from '../constants/countries';

// ── Placeholder examples by dial code ────────────────────────────────────────

const _PHONE_EXAMPLES: Record<string, string> = {
  '+263': '77 123 4567',
  '+1':   '(555) 123-4567',
  '+260': '97 123 4567',
  '+27':  '82 123 4567',
  '+254': '712 345 678',
  '+255': '712 345 678',
  '+265': '991 23 4567',
  '+267': '71 234 567',
  '+264': '81 123 4567',
  '+258': '82 123 4567',
  '+256': '712 345 678',
  '+233': '24 123 4567',
  '+234': '801 234 5678',
  '+44':  '7700 900123',
  '+91':  '98765 43210',
};

function getPhoneExample(dialCode: string): string {
  return _PHONE_EXAMPLES[dialCode] ?? 'e.g. 712 345 678';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// TODO(country-detection): current behavior is device-locale via
// expo-localization, falling back to DEFAULT_COUNTRY_CODE ('ZW'). That means
// a US-locale device shows +1, not +263, even when the user is sitting in
// Zimbabwe. Runtime IP-based detection is pending a decision between:
//   (a) a new backend /api/country endpoint that proxies ipapi.co + caches
//       server-side (one hop per user, deterministic rate limits);
//   (b) continuing with expo-localization only (offline, no API call, but
//       tied to device region which doesn't always match physical location);
//   (c) a direct ipapi.co call from the app with a 24h AsyncStorage cache
//       (no backend work, but rate-limited to 1000/IP/day on free tier).
// Default must NEVER fall back to +1 — Zimbabwe is Neriah's primary market.
function detectDefaultCountry(): Country {
  try {
    const regionCode = Localization.getLocales()[0]?.regionCode ?? '';
    return (
      COUNTRIES.find(c => c.code === regionCode) ??
      COUNTRIES.find(c => c.code === DEFAULT_COUNTRY_CODE)!
    );
  } catch {
    return COUNTRIES.find(c => c.code === DEFAULT_COUNTRY_CODE)!;
  }
}

/** Combines dial code + local digits into E.164. Returns '' if local is empty. */
function buildE164(dial: string, local: string): string {
  const digits = local.replace(/\D/g, '');
  const stripped = digits.startsWith('0') ? digits.slice(1) : digits;
  return stripped.length > 0 ? dial + stripped : '';
}

// ── Component ─────────────────────────────────────────────────────────────────

// E.164: + then 7–15 digits total. Practical minimum for mobile numbers: 10 total digits.
const E164_RE = /^\+[1-9]\d{6,14}$/;

/** True when the E.164 string is structurally valid. */
export function isValidE164(phone: string): boolean {
  return E164_RE.test(phone);
}

interface PhoneInputProps {
  /** Called with the full E.164 string (or '' when incomplete). */
  onChangePhone: (e164: string) => void;
  /** Shows a red border when true. */
  error?: boolean;
  /** Disables both the dial button and the text input. */
  disabled?: boolean;
}

export default function PhoneInput({ onChangePhone, error, disabled }: PhoneInputProps) {
  const [country, setCountry] = useState<Country>(detectDefaultCountry);
  const [localNumber, setLocalNumber] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const currentE164 = buildE164(country.dial, localNumber);
  const expectedDigits = country.digits ?? DEFAULT_DIGITS;
  const localDigits = localNumber.replace(/\D/g, '').replace(/^0/, '').length;
  const showInlineError = touched && localDigits > 0 && localDigits < expectedDigits;
  const counterColor = localDigits === 0 ? COLORS.gray500
    : localDigits < expectedDigits ? '#F59E0B'
    : localDigits === expectedDigits ? '#22C55E'
    : COLORS.error;

  // ── Handlers ──────────────────────────────────────────────────────────────

  // Strip non-digits and enforce max digit count strictly
  const handleLocalChange = (text: string) => {
    const digitsOnly = text.replace(/\D/g, '');
    // Hard limit: never accept more than expectedDigits (+ 1 for leading zero tolerance)
    if (digitsOnly.replace(/^0/, '').length > expectedDigits) return;
    setLocalNumber(digitsOnly);
    onChangePhone(buildE164(country.dial, digitsOnly));
  };

  const handleBlur = () => setTouched(true);

  const handleSelectCountry = (selected: Country) => {
    setCountry(selected);
    setModalVisible(false);
    setQuery('');
    onChangePhone(buildE164(selected.dial, localNumber));
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const handleOpenModal = () => {
    if (!disabled) setModalVisible(true);
  };

  const handleCloseModal = () => {
    setModalVisible(false);
    setQuery('');
  };

  // ── Filtered countries for search ──────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.dial.includes(q) ||
      c.code.toLowerCase().includes(q),
    );
  }, [query]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Input row */}
      <View style={[
        styles.row,
        error && styles.rowError,
        disabled && styles.rowDisabled,
      ]}>
        {/* Country selector button */}
        <TouchableOpacity
          style={styles.dialButton}
          onPress={handleOpenModal}
          activeOpacity={disabled ? 1 : 0.7}
          accessibilityLabel={`Country code: ${country.name} ${country.dial}`}
          accessibilityRole="button"
        >
          <Text style={styles.dialFlag}>{country.flag}</Text>
          <Text style={styles.dialCode}>{country.dial}</Text>
          <Text style={styles.chevron}>▾</Text>
        </TouchableOpacity>

        {/* Divider */}
        <View style={styles.divider} />

        {/* Local number input */}
        <TextInput
          ref={inputRef}
          style={styles.numberInput}
          value={localNumber}
          onChangeText={handleLocalChange}
          onBlur={handleBlur}
          keyboardType="phone-pad"
          placeholder={getPhoneExample(country.dial)}
          placeholderTextColor={COLORS.gray200}
          autoCorrect={false}
          autoCapitalize="none"
          editable={!disabled}
          maxLength={expectedDigits + 1}
          returnKeyType="done"
        />
      </View>

      {/* Inline validation hint — only after touch, when invalid */}
      {showInlineError && (
        <Text style={styles.inlineError}>
          Enter a valid phone number for {country.name}
        </Text>
      )}

      {/* Country picker modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        onRequestClose={handleCloseModal}
      >
        <SafeAreaView style={styles.modal}>
          {/* Modal header */}
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select country</Text>
            <TouchableOpacity onPress={handleCloseModal} hitSlop={{ top: 8, bottom: 8, left: 16, right: 8 }}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={styles.searchRow}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search countries or dial code…"
              placeholderTextColor={COLORS.gray500}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              clearButtonMode="while-editing"
              autoFocus={Platform.OS === 'ios'}
            />
          </View>

          {/* Country list */}
          <FlatList
            data={filtered}
            keyExtractor={item => item.code}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const isSelected = item.code === country.code;
              return (
                <TouchableOpacity
                  style={[styles.countryRow, isSelected && styles.countryRowSelected]}
                  onPress={() => handleSelectCountry(item)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.countryFlag}>{item.flag}</Text>
                  <Text style={[styles.countryName, isSelected && styles.countryNameSelected]}>
                    {item.name}
                  </Text>
                  <Text style={[styles.countryDial, isSelected && styles.countryDialSelected]}>
                    {item.dial}
                  </Text>
                </TouchableOpacity>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <Text style={styles.emptyText}>No countries match "{query}"</Text>
            }
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── Input row ──────────────────────────────────────────────────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: COLORS.white,
  },
  rowError: { borderColor: COLORS.error },
  rowDisabled: { backgroundColor: COLORS.gray50, opacity: 0.7 },

  dialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 4,
    backgroundColor: COLORS.gray50,
  },
  dialFlag: { fontSize: 18, lineHeight: 22 },
  dialCode: { fontSize: 15, color: COLORS.text, fontWeight: '600', minWidth: 38 },
  chevron: { fontSize: 10, color: COLORS.gray500, marginTop: 1 },

  divider: { width: 1, alignSelf: 'stretch', backgroundColor: COLORS.gray200 },

  numberInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    color: COLORS.text,
  },

  // ── Modal ──────────────────────────────────────────────────────────────────
  modal: { flex: 1, backgroundColor: COLORS.white },

  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text },
  modalCancel: { fontSize: 16, color: COLORS.teal500, fontWeight: '600' },

  searchRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: COLORS.gray50,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  searchInput: {
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 15,
    color: COLORS.text,
  },

  // ── Country rows ──────────────────────────────────────────────────────────
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 12,
  },
  countryRowSelected: { backgroundColor: COLORS.teal50 },

  countryFlag: { fontSize: 22, width: 30, textAlign: 'center' },

  countryName: { flex: 1, fontSize: 15, color: COLORS.text },
  countryNameSelected: { color: COLORS.teal500, fontWeight: '600' },

  countryDial: { fontSize: 15, color: COLORS.gray500, minWidth: 48, textAlign: 'right' },
  countryDialSelected: { color: COLORS.teal500, fontWeight: '600' },

  separator: { height: 1, backgroundColor: COLORS.border, marginLeft: 62 },

  emptyText: {
    textAlign: 'center',
    marginTop: 32,
    fontSize: 14,
    color: COLORS.gray500,
  },

  counter: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '500',
  },

  inlineError: {
    marginTop: 2,
    fontSize: 12,
    color: COLORS.error,
  },
});
