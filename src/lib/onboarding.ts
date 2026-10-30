export const ONBOARDING_STEPS = ["supplier", "account", "series", "logo", "look"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function parseStep(value: string | string[] | undefined): OnboardingStep | null {
  return ONBOARDING_STEPS.find((step) => step === value) ?? null;
}
