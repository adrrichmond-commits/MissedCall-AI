/**
 * KB version stamp — single source of truth for the knowledge base version.
 * Stamped into every KB result (guardrail results, matches, manifests) so
 * downstream consumers can tell which KB revision produced a row, the same
 * way RULES_CLASSIFIER_VERSION stamps classifier output.
 */

/** KB revision — bump when service/emergency/policy content materially changes. */
export const KB_VERSION = "kb-v1";
