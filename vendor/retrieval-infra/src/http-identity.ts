import { siteSetting } from "./site-config.js";

/**
 * Project identification for historical-source HTTP requests. A deployment adds its contact
 * details through FABENCH_HTTP_USER_AGENT or the httpUserAgent setting (see site-config.ts).
 */
export const HISTORICAL_USER_AGENT =
  siteSetting("httpUserAgent", "FABENCH_HTTP_USER_AGENT") ?? "FABench/0.1 (research)";
