import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.nasqo.proerp",
  appName: "NasqoProERP",
  webDir: "dist/capacitor",
  server: { androidScheme: "https" },
  android: { allowMixedContent: false },
};
export default config;
