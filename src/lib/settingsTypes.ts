/**
 * Client-safe shared types + constants for onboarding & settings.
 * No server imports — both the server-fn layer and route components use this.
 */

export const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Order used by the wizard + settings hours editor (Mon–Sun). */
export const BUSINESS_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN",
  "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH",
  "NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT",
  "VT","VA","WA","WV","WI","WY",
] as const;

/** Curated list rendered in the timezone <select> and accepted by the server. */
export const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Detroit",
  "America/Indiana/Indianapolis",
  "America/Boise",
  "America/Juneau",
] as const;

export interface NotificationPrefs {
  /** Text the customer when a call is missed (Phase 2 — delivery pending provider setup). */
  onMissedCallSms: boolean;
  onNewLeadEmail: boolean;
  dailySummaryEmail: boolean;
  weeklySummaryEmail: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  onMissedCallSms: true,
  onNewLeadEmail: true,
  dailySummaryEmail: false,
  weeklySummaryEmail: true,
};

export const NOTIFICATION_PREF_KEYS = [
  "onMissedCallSms",
  "onNewLeadEmail",
  "dailySummaryEmail",
  "weeklySummaryEmail",
] as const satisfies readonly (keyof NotificationPrefs)[];

/** Step 5 of the 9-step onboarding (owner brief section 12: emergency prefs). */
export interface EmergencyPrefs {
  /** Take emergency calls after hours (drives the receptionist's greeting). */
  afterHoursEmergency: boolean;
  /** Email the owner when a lead is classified an emergency. */
  emergencyNotificationEmail: boolean;
  /** Text the owner when a lead is classified an emergency. */
  emergencyNotificationSms: boolean;
  /** Free-text instructions the AI follows on emergency calls. */
  emergencyInstructions: string;
}

export const DEFAULT_EMERGENCY_PREFS: EmergencyPrefs = {
  afterHoursEmergency: true,
  emergencyNotificationEmail: true,
  emergencyNotificationSms: false,
  emergencyInstructions: "",
};

export interface OnboardingStepStatus {
  id: number;
  key:
    | "company"
    | "services"
    | "hours"
    | "emergency"
    | "notifications"
    | "phone"
    | "testAi"
    | "review";
  label: string;
  done: boolean;
}

export interface OnboardingState {
  steps: OnboardingStepStatus[];
  /** 0–100 rounded progress across the 9 steps. */
  percent: number;
  /** Index of the first unfinished step (0-based), or 8 when everything is done. */
  resumeStep: number;
  /** True when the business is missing baseline config (no hours or no services). */
  needsOnboarding: boolean;
}

export interface SettingsBusinessView {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  timezone: string;
}

export interface SettingsHourView {
  dayOfWeek: number;
  isOpen: boolean;
  /** "HH:MM" for <input type="time">, null when closed. */
  opensAt: string | null;
  closesAt: string | null;
}

export interface SettingsServiceView {
  id: string;
  name: string;
  description: string | null;
  basePriceCents: number | null;
  durationMinutes: number | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface SettingsServiceAreaView {
  id: string;
  kind: "zip" | "city";
  value: string;
  state: string | null;
}

export interface SettingsView {
  role: "owner" | "manager" | "employee";
  canEdit: boolean;
  business: SettingsBusinessView;
  hours: SettingsHourView[];
  services: SettingsServiceView[];
  serviceAreas: SettingsServiceAreaView[];
  serviceDefaults: { id: string; name: string; description: string | null }[];
  notificationPrefs: NotificationPrefs;
  emergencyPrefs: EmergencyPrefs;
  /** True once the owner saved emergency prefs at least once (emergencyPrefsSavedAt). */
  emergencyPrefsSaved: boolean;
  onboarding: OnboardingState;
}
