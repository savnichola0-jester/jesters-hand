// EAS Update does not inherit eas.json build-profile env automatically.
// Copy only EXPO_PUBLIC_* client config into Expo's local dotenv input.
// These values are already embedded in preview builds; no private keys belong here.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = existsSync(resolve("eas.json"))
  ? process.cwd()
  : resolve("artifacts/jesters-hand");
if (!existsSync(join(root, "eas.json"))) {
  throw new Error("Cannot locate the Expo app's eas.json");
}
const config = JSON.parse(readFileSync(join(root, "eas.json"), "utf8"));
const publicEnv = Object.entries(config.build?.preview?.env ?? {})
  .filter(([name, value]) => name.startsWith("EXPO_PUBLIC_") && typeof value === "string");
for (const required of [
  "EXPO_PUBLIC_DOMAIN",
  "EXPO_PUBLIC_FIREBASE_API_KEY",
  "EXPO_PUBLIC_FIREBASE_PROJECT_ID",
  "EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET",
]) {
  if (!publicEnv.some(([name]) => name === required)) {
    throw new Error(`Missing required preview configuration: ${required}`);
  }
}
writeFileSync(
  join(root, ".env.local"),
  publicEnv.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n",
  { mode: 0o600 },
);