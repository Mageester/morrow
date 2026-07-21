// Shared E2E constants. Kept dependency-free so the Playwright config, the
// global setup/teardown, and the specs all agree on the local server address.
export const E2E_PORT = 4373;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
