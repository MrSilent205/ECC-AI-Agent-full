---
name: yoruba-localization-testing
description: Validate Yoruba (yo) and English bilingual application interfaces, Unicode diacritics, translations, and accessible localization tests.
origin: ECC
---

# Yoruba Localization Testing

## When to Activate

Use when building or reviewing Yoruba (yo) interfaces, Yoruba-English language switching, localized forms, search, notifications, or accessibility features.

## Core Concepts

- Preserve Yoruba tone marks and underdots: ẹ, ọ, ṣ and accented vowels such as á, à, ẹ́, ọ̀.
- Store and serve UTF-8; use Unicode normalization consistently (NFC) when comparing strings.
- Do not strip diacritics from displayed text or silently rewrite a speaker's wording.
- Use BCP 47 language tags `yo` and `en`. Keep locale separate from region.
- Avoid word-for-word translations of idioms. Have fluent Yoruba speakers review wording, context, and tone.
- Never use machine-translated strings as the only quality gate.
- Test long text, screen readers, keyboard navigation, font glyph coverage, and mobile layouts.

## Implementation Workflow

1. Inventory user-facing strings and identify hard-coded text.
2. Extract messages into locale dictionaries with stable keys.
3. Preserve placeholders, markup, punctuation, and pluralization semantics.
4. Implement explicit language selection and fallback to English for missing translations.
5. Test Unicode normalization and round-trip storage through API and database.
6. Ask a fluent Yoruba reviewer to check accuracy and naturalness before release.

## Code Examples

```typescript
const messages = {
  en: { welcome: "Welcome", search: "Search" },
  yo: { welcome: "Ẹ káàbọ̀", search: "Wá" },
} as const;

type Locale = keyof typeof messages;
type Key = keyof typeof messages.en;

export function translate(locale: Locale, key: Key): string {
  return messages[locale]?.[key] ?? messages.en[key];
}

export function sameNormalizedText(a: string, b: string): boolean {
  return a.normalize("NFC") === b.normalize("NFC");
}
```

### Test Cases

```typescript
import { strict as assert } from "node:assert";

assert.equal(translate("yo", "welcome"), "Ẹ káàbọ̀");
assert.equal(sameNormalizedText("ẹ́", "ẹ\u0301"), true);
assert.equal("Ọ̀rọ̀".normalize("NFC"), "Ọ̀rọ̀".normalize("NFD").normalize("NFC"));
```

## Anti-Patterns

- Removing accents or underdots for convenience.
- Assuming all Yoruba users prefer Yoruba-only navigation.
- Translating technical identifiers, code symbols, or API keys.
- Guessing a translation for sensitive legal, medical, or financial content.
- Claiming localization is complete without native-speaker review.

## Best Practices

- Keep UTF-8 source files and translation fixtures in version control.
- Use `Intl` APIs for locale-sensitive formatting where supported; verify runtime support.
- Allow bilingual switching without losing form state.
- Provide a user-visible way to report translation problems.
- Test on actual target fonts, browsers, and assistive technologies.

## Related Skills

- `accessibility`
- `frontend-patterns`
- `tdd-workflow`
