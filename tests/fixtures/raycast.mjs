// The parts of @raycast/api the runner code uses.
export const environment = { supportPath: process.env.CLI_TEST_SUPPORT };
export function getPreferenceValues() {
  return JSON.parse(process.env.CLI_TEST_PREFERENCES || "{}");
}
const values = new Map();
export const LocalStorage = {
  async getItem(key) {
    return values.get(key);
  },
  async setItem(key, value) {
    values.set(key, value);
  },
  async removeItem(key) {
    values.delete(key);
  },
};
export const Toast = { Style: { Failure: "failure", Success: "success" } };
export async function showToast() {}
