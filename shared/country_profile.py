"""
shared/country_profile.py — Country-specific facts the LLM needs to behave
naturally for a given user: level system labels, currency, mobile money,
food, transport, agriculture context.

Country is resolved upstream from the phone number / school document via
``shared.user_context.detect_country_from_phone``. This module then maps
that country name (e.g. "Zimbabwe") to the concrete cultural facts the
prompt should bake in.

Adding a new country is just a new entry in ``_PROFILES`` — no other code
changes required. ``country_profile`` falls back to a Pan-African default
when the country is missing or unrecognised, never raises.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CountryProfile:
    """
    Cultural and educational facts for one country.

    Fields are intentionally short — they are concatenated into the LLM
    system prompt where every token costs latency.

    The ``curriculum_options`` and ``levels`` fields are exposed to the
    mobile teacher UI via /api/curriculum/options so the curriculum +
    level pickers reflect the country the teacher actually teaches in,
    rather than a hard-coded global list.
    """
    country: str
    curriculum: str                       # Default authority: ZIMSEC, WAEC, CAPS, KNEC ...
    level_system: str                     # Human-readable: "Grade 1-7 then Form 1-6"
    currency: str                         # "USD/ZWL", "NGN", "ZAR", "KES" ...
    mobile_money: str                     # "EcoCash, OneMoney"
    transport: str                        # "kombi, mushikashika"
    food: str                             # "sadza, mealie meal, beans"
    agriculture: str                      # "maize, tobacco, cattle"
    # Curriculum-picker options offered to teachers from this country.
    # First entry is the default. Cambridge / IB are added where private
    # / international schools commonly use them alongside the national board.
    curriculum_options: tuple[str, ...] = ()
    # Level-picker options keyed by curriculum.
    # Falls back to the country's level_system shape when a curriculum
    # isn't specifically listed here.
    levels: tuple[str, ...] = ()


# ── Per-country profiles ──────────────────────────────────────────────────────
# Keep entries terse and concrete. The LLM uses these as example fodder, not
# as ground truth for facts the student is being taught.

# ── Cross-cutting alternative curricula ──────────────────────────────────────
# Cambridge and IB are common in private and international schools across
# every country we serve. We list them as picker options alongside the
# national board so private-school teachers see their curriculum.

ALL_LEVELS_LABEL = "All Levels"

_CAMBRIDGE_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Year 1", "Year 2", "Year 3", "Year 4", "Year 5", "Year 6",
    "Year 7", "Year 8", "Year 9 (Lower Secondary)",
    "IGCSE (Year 10)", "IGCSE (Year 11)",
    "A-Level (Year 12)", "A-Level (Year 13)",
)

_IB_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Primary Years (PYP)",
    "Middle Years (MYP)",
    "Diploma Programme (DP)",
)

# Native level lists per country curriculum. Each starts with "All Levels"
# so the picker has an unfiltered option.
_ZW_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7",
    "Form 1", "Form 2", "Form 3", "Form 4",
    "Form 5 (A-Level)", "Form 6 (A-Level)", "College/University",
)
_ZA_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade R", "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5",
    "Grade 6", "Grade 7", "Grade 8", "Grade 9",
    "Grade 10", "Grade 11", "Grade 12 (Matric)", "Tertiary",
)
_KE_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
    "Grade 7", "Grade 8", "Grade 9",
    "Grade 10", "Grade 11", "Grade 12", "Tertiary",
)
_NG_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6",
    "JSS 1", "JSS 2", "JSS 3",
    "SSS 1", "SSS 2", "SSS 3", "Tertiary",
)
_GH_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "KG 1", "KG 2",
    "Primary 1", "Primary 2", "Primary 3", "Primary 4", "Primary 5", "Primary 6",
    "JHS 1", "JHS 2", "JHS 3",
    "SHS 1", "SHS 2", "SHS 3", "Tertiary",
)
_UG_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "P1", "P2", "P3", "P4", "P5", "P6", "P7",
    "S1", "S2", "S3", "S4", "S5", "S6", "Tertiary",
)
_TZ_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Standard 1", "Standard 2", "Standard 3", "Standard 4",
    "Standard 5", "Standard 6", "Standard 7",
    "Form 1", "Form 2", "Form 3", "Form 4",
    "Form 5", "Form 6", "Tertiary",
)
_ZM_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7",
    "Grade 8", "Grade 9",
    "Grade 10", "Grade 11", "Grade 12", "Tertiary",
)
_MW_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Standard 1", "Standard 2", "Standard 3", "Standard 4",
    "Standard 5", "Standard 6", "Standard 7", "Standard 8",
    "Form 1", "Form 2", "Form 3", "Form 4", "Tertiary",
)
_BW_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Standard 1", "Standard 2", "Standard 3", "Standard 4",
    "Standard 5", "Standard 6", "Standard 7",
    "Form 1", "Form 2", "Form 3",
    "Form 4", "Form 5", "Tertiary",
)
_NA_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7",
    "Grade 8", "Grade 9", "Grade 10",
    "Grade 11 (NSSC)", "Grade 12 (NSSC)", "Tertiary",
)
_RW_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "P1", "P2", "P3", "P4", "P5", "P6",
    "S1", "S2", "S3",
    "S4", "S5", "S6", "Tertiary",
)
_DRC_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "P1", "P2", "P3", "P4", "P5", "P6",
    "CO1", "CO2",
    "HS1", "HS2", "HS3", "HS4", "Tertiary",
)
_ET_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6",
    "Grade 7", "Grade 8",
    "Grade 9", "Grade 10", "Grade 11", "Grade 12", "Tertiary",
)


_PROFILES: dict[str, CountryProfile] = {
    "Zimbabwe": CountryProfile(
        country="Zimbabwe",
        curriculum="ZIMSEC",
        level_system="Grade 1-7 (primary), Form 1-4 (secondary O-Level), Form 5-6 (A-Level), then tertiary",
        currency="USD/ZWL",
        mobile_money="EcoCash, OneMoney, InnBucks",
        transport="kombi, mushikashika, ZUPCO bus",
        food="sadza, mealie meal, dovi, kapenta",
        agriculture="maize, tobacco, cotton, cattle, smallholder farms",
        curriculum_options=("ZIMSEC", "Cambridge", "IB"),
        levels=_ZW_LEVELS,
    ),
    "South Africa": CountryProfile(
        country="South Africa",
        curriculum="CAPS",
        level_system="Grade R, Grade 1-9 (GET), Grade 10-12 (FET / Matric), then tertiary",
        currency="ZAR",
        mobile_money="MTN MoMo, Vodapay",
        transport="taxi (minibus), Gautrain, Putco bus",
        food="pap, boerewors, biltong, vetkoek",
        agriculture="maize, sugarcane, citrus, sheep, vineyards",
        curriculum_options=("CAPS", "IEB", "Cambridge", "IB"),
        levels=_ZA_LEVELS,
    ),
    "Kenya": CountryProfile(
        country="Kenya",
        curriculum="KNEC (CBC)",
        level_system="Grade 1-6 (primary), Grade 7-9 (junior secondary), Grade 10-12 (senior secondary), then tertiary",
        currency="KES",
        mobile_money="M-Pesa, Airtel Money",
        transport="matatu, boda boda, SGR train",
        food="ugali, sukuma wiki, nyama choma, chapati",
        agriculture="tea, coffee, maize, dairy cattle, horticulture",
        curriculum_options=("KNEC (CBC)", "Cambridge", "IB"),
        levels=_KE_LEVELS,
    ),
    "Nigeria": CountryProfile(
        country="Nigeria",
        curriculum="WAEC (NERDC)",
        level_system="Primary 1-6, JSS 1-3, SSS 1-3, then tertiary",
        currency="NGN",
        mobile_money="Opay, PalmPay, MTN MoMo",
        transport="danfo, keke (tricycle), okada",
        food="jollof rice, eba, egusi, suya, akara",
        agriculture="cassava, yam, cocoa, oil palm, livestock",
        curriculum_options=("WAEC (NERDC)", "Cambridge", "IB"),
        levels=_NG_LEVELS,
    ),
    "Ghana": CountryProfile(
        country="Ghana",
        curriculum="WAEC (NaCCA)",
        level_system="KG 1-2, Primary 1-6, JHS 1-3, SHS 1-3, then tertiary",
        currency="GHS",
        mobile_money="MTN MoMo, AirtelTigo Money",
        transport="trotro, Aayalolo bus, taxi",
        food="banku, kenkey, jollof rice, waakye, fufu",
        agriculture="cocoa, oil palm, cassava, plantain, livestock",
        curriculum_options=("WAEC (NaCCA)", "Cambridge", "IB"),
        levels=_GH_LEVELS,
    ),
    "Uganda": CountryProfile(
        country="Uganda",
        curriculum="UNEB",
        level_system="Primary 1-7, S1-S6 (lower & upper secondary), then tertiary",
        currency="UGX",
        mobile_money="MTN MoMo, Airtel Money",
        transport="boda boda, taxi (matatu), bus",
        food="matooke, posho, groundnut sauce, rolex (chapati + egg)",
        agriculture="coffee, bananas (matooke), tea, dairy cattle",
        curriculum_options=("UNEB", "Cambridge", "IB"),
        levels=_UG_LEVELS,
    ),
    "Tanzania": CountryProfile(
        country="Tanzania",
        curriculum="NECTA",
        level_system="Standard 1-7 (primary), Form 1-4 (O-Level), Form 5-6 (A-Level), then tertiary",
        currency="TZS",
        mobile_money="M-Pesa, Tigo Pesa, Airtel Money",
        transport="dala dala, bajaji, boda boda",
        food="ugali, mchuzi, mishkaki, chapati",
        agriculture="maize, cassava, coffee, cashew, livestock",
        curriculum_options=("NECTA", "Cambridge", "IB"),
        levels=_TZ_LEVELS,
    ),
    "Zambia": CountryProfile(
        country="Zambia",
        curriculum="ECZ",
        level_system="Grade 1-7 (primary), Grade 8-9 (junior secondary), Grade 10-12 (senior secondary), then tertiary",
        currency="ZMW",
        mobile_money="MTN MoMo, Airtel Money, Zamtel Kwacha",
        transport="taxi, minibus, Postbus",
        food="nshima, kapenta, ifisashi, samp",
        agriculture="maize, cassava, soya, cattle",
        curriculum_options=("ECZ", "Cambridge", "IB"),
        levels=_ZM_LEVELS,
    ),
    "Malawi": CountryProfile(
        country="Malawi",
        curriculum="MANEB",
        level_system="Standard 1-8 (primary), Form 1-4 (secondary), then tertiary",
        currency="MWK",
        mobile_money="Airtel Money, TNM Mpamba",
        transport="minibus, kabaza (bicycle taxi), bus",
        food="nsima, ndiwo, mandasi, chambo",
        agriculture="maize, tobacco, tea, sugar, smallholder farms",
        curriculum_options=("MANEB", "Cambridge", "IB"),
        levels=_MW_LEVELS,
    ),
    "Botswana": CountryProfile(
        country="Botswana",
        curriculum="BEC",
        level_system="Standard 1-7 (primary), Form 1-3 (junior secondary), Form 4-5 (senior secondary), then tertiary",
        currency="BWP",
        mobile_money="Orange Money, Mascom MyZaka, BTC Smega",
        transport="combi, taxi, A1 bus",
        food="seswaa, pap, morogo, bogobe",
        agriculture="cattle, sorghum, beef export, diamonds (mining)",
        curriculum_options=("BEC", "Cambridge", "IB"),
        levels=_BW_LEVELS,
    ),
    "Namibia": CountryProfile(
        country="Namibia",
        curriculum="NIED",
        level_system="Grade 1-7 (primary), Grade 8-12 (secondary, JSC then NSSC), then tertiary",
        currency="NAD/ZAR",
        mobile_money="MTC Mobile Money, EWallet",
        transport="taxi, combi, Intercape bus",
        food="oshifima, kapana, biltong, mahangu",
        agriculture="cattle, sheep, mining, fishing",
        curriculum_options=("NIED", "Cambridge", "IB"),
        levels=_NA_LEVELS,
    ),
    "Rwanda": CountryProfile(
        country="Rwanda",
        curriculum="REB (CBC)",
        level_system="P1-P6 (primary), S1-S3 (lower secondary), S4-S6 (upper secondary), then tertiary",
        currency="RWF",
        mobile_money="MTN MoMo, Airtel Money",
        transport="moto (motorbike taxi), twegerane, bus",
        food="ugali, isombe, brochettes, ibirayi (potatoes)",
        agriculture="coffee, tea, bananas, dairy cattle",
        curriculum_options=("REB (CBC)", "Cambridge", "IB"),
        levels=_RW_LEVELS,
    ),
    "DRC": CountryProfile(
        country="DRC",
        curriculum="MEPSP",
        level_system="P1-P6 (primary), CO1-CO2 (orientation), HS1-HS4 (humanities), then tertiary",
        currency="CDF",
        mobile_money="M-Pesa, Orange Money, Airtel Money",
        transport="taxi (kombi), moto, esprit de mort (van)",
        food="fufu, pondu, bidia, makayabu",
        agriculture="cassava, palm oil, coffee, copper (mining)",
        curriculum_options=("MEPSP", "Cambridge", "IB"),
        levels=_DRC_LEVELS,
    ),
    "Ethiopia": CountryProfile(
        country="Ethiopia",
        curriculum="MoE",
        level_system="Grade 1-6 (primary), Grade 7-8 (junior secondary), Grade 9-12 (senior secondary), then tertiary",
        currency="ETB",
        mobile_money="telebirr, M-Birr, HelloCash",
        transport="bajaj, minibus, Anbessa bus",
        food="injera, doro wat, shiro, kitfo",
        agriculture="coffee, teff, maize, cattle",
        curriculum_options=("MoE", "Cambridge", "IB"),
        levels=_ET_LEVELS,
    ),
}


# ── Pan-African default for unknown / multi-region cases ─────────────────────
_DEFAULT_LEVELS: tuple[str, ...] = (
    ALL_LEVELS_LABEL,
    "Grade 1", "Grade 2", "Grade 3", "Grade 4", "Grade 5", "Grade 6", "Grade 7",
    "Form 1", "Form 2", "Form 3", "Form 4", "Form 5", "Form 6", "Tertiary",
)

_DEFAULT_PROFILE = CountryProfile(
    country="Pan-African",
    curriculum="Generic",
    level_system="Grade 1-7 (primary), Form 1-6 (secondary), then tertiary — adjust as appropriate",
    currency="USD or local equivalent",
    mobile_money="local mobile money (e.g. EcoCash, M-Pesa, MTN MoMo)",
    transport="local minibus / taxi",
    food="staple grain (maize/cassava) with local sauce",
    agriculture="smallholder farming, livestock, cash crops",
    curriculum_options=("Generic", "Cambridge", "IB"),
    levels=_DEFAULT_LEVELS,
)


def country_profile(country: str | None) -> CountryProfile:
    """
    Return the concrete CountryProfile for *country* or the Pan-African
    default. Country names match those produced by
    ``shared.user_context.detect_country_from_phone``.
    """
    if not country:
        return _DEFAULT_PROFILE
    return _PROFILES.get(country, _DEFAULT_PROFILE)


def supported_countries() -> list[str]:
    """List of countries with a tailored profile (excludes the default)."""
    return list(_PROFILES.keys())


def levels_for_curriculum(country: str | None, curriculum: str) -> list[str]:
    """
    Return the level picker options for *curriculum* in *country*.

    Cambridge / IB levels are universal — the country only affects which
    of those alternatives are commonly offered. The native curriculum
    of the country uses its own level structure.
    """
    if curriculum == "Cambridge":
        return list(_CAMBRIDGE_LEVELS)
    if curriculum == "IB":
        return list(_IB_LEVELS)
    p = country_profile(country)
    # Native curriculum (e.g. ZIMSEC for Zimbabwe) → use the country's level list.
    if curriculum == p.curriculum:
        return list(p.levels)
    # Unknown alternative (e.g. IEB in South Africa we don't model separately)
    # → fall back to the country's native level list as the closest match.
    return list(p.levels)


def picker_options(country: str | None) -> dict:
    """
    Build the curriculum + level picker payload for the mobile teacher UI.

    Shape:
        {
          "country":             "Zimbabwe",
          "default_curriculum":  "ZIMSEC",
          "curriculum_options":  ["ZIMSEC", "Cambridge", "IB"],
          "level_options":       {
              "ZIMSEC":    [...],
              "Cambridge": [...],
              "IB":        [...],
          }
        }
    """
    p = country_profile(country)
    options: list[str] = list(p.curriculum_options) or [p.curriculum]
    return {
        "country":            p.country,
        "default_curriculum": options[0],
        "curriculum_options": options,
        "level_options": {
            cur: levels_for_curriculum(country, cur) for cur in options
        },
    }
