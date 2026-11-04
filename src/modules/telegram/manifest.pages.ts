import type { ModulePagesManifest } from "@/core/modules/types.server";
import { TelegramChannelPage, TelegramPage } from "./pages/TelegramPage";

export const telegramPagesManifest: ModulePagesManifest = {
  id: "telegram",
  routes: {
    "": TelegramPage,
    "[id]": TelegramChannelPage,
  },
};
