// src/context/LanguageContext.tsx
// Provides language selection and t() translation function to the app.
// Language is persisted in SecureStore. Changes apply immediately without restart.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as SecureStore from 'expo-secure-store';
import { translations, LangCode, TranslationKey } from '../i18n/translations';

export const LANGUAGE_STORAGE_KEY = 'neriah_language';
const DEFAULT_LANG: LangCode = 'en';

interface LanguageContextValue {
  language: LangCode;
  setLanguage: (lang: LangCode) => Promise<void>;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANG,
  setLanguage: async () => {},
  t: (key) => key as string,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLangState] = useState<LangCode>(DEFAULT_LANG);

  useEffect(() => {
    SecureStore.getItemAsync(LANGUAGE_STORAGE_KEY)
      .then((stored) => {
        if (stored && stored in translations) {
          setLangState(stored as LangCode);
        }
      })
      .catch(() => {});
  }, []);

  const setLanguage = useCallback(async (lang: LangCode) => {
    setLangState(lang);
    await SecureStore.setItemAsync(LANGUAGE_STORAGE_KEY, lang).catch(() => {});
  }, []);

  const t = useCallback(
    (key: TranslationKey): string => {
      return (translations[language] as Record<string, string>)[key]
        ?? (translations[DEFAULT_LANG] as Record<string, string>)[key]
        ?? key;
    },
    [language],
  );

  const value = useMemo<LanguageContextValue>(
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export const useLanguage = () => useContext(LanguageContext);
