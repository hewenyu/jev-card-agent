import { endpoint } from '../policies/metering.js';

/** The SDK appends /v1/systemone; keep existing root-or-/v1 configuration compatible. */
export function sdkBaseUrl(baseUrl: string): string {
  return endpoint(baseUrl, 'systemone').slice(0, -'/v1/systemone'.length);
}
