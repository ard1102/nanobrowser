import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface TelegramSettingsConfig {
  botToken: string;
  allowedUserIds: string; // comma-separated Telegram user IDs
  isRunning: boolean;
}

export type TelegramSettingsStorage = BaseStorage<TelegramSettingsConfig> & {
  updateSettings: (settings: Partial<TelegramSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<TelegramSettingsConfig>;
};

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettingsConfig = {
  botToken: '',
  allowedUserIds: '',
  isRunning: false,
};

const storage = createStorage<TelegramSettingsConfig>('telegram-settings', DEFAULT_TELEGRAM_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const telegramSettingsStore: TelegramSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<TelegramSettingsConfig>) {
    const current = (await storage.get()) || DEFAULT_TELEGRAM_SETTINGS;
    await storage.set({ ...current, ...settings });
  },
  async getSettings() {
    const settings = await storage.get();
    return { ...DEFAULT_TELEGRAM_SETTINGS, ...settings };
  },
};
