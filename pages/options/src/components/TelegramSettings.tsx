import { useState, useEffect } from 'react';
import { telegramSettingsStore, DEFAULT_TELEGRAM_SETTINGS, type TelegramSettingsConfig } from '@extension/storage';

interface TelegramSettingsProps {
  isDarkMode?: boolean;
}

export const TelegramSettings = ({ isDarkMode = false }: TelegramSettingsProps) => {
  const [settings, setSettings] = useState<TelegramSettingsConfig>(DEFAULT_TELEGRAM_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  useEffect(() => {
    telegramSettingsStore.getSettings().then(setSettings);
  }, []);

  // Keep in sync if background changes isRunning
  useEffect(() => {
    const unsub = telegramSettingsStore.subscribe(async () => {
      const latest = await telegramSettingsStore.getSettings();
      setSettings(latest);
    });
    return unsub;
  }, []);

  const save = async () => {
    setSaving(true);
    await telegramSettingsStore.updateSettings(settings);
    setSaving(false);
    showToast('✅ Saved');
  };

  const toggle = async () => {
    const next = !settings.isRunning;
    await telegramSettingsStore.updateSettings({ isRunning: next });
    setSettings(s => ({ ...s, isRunning: next }));
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const border = isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-white';
  const label = `text-base font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`;
  const desc = `text-sm font-normal ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`;
  const input = `w-full rounded-md border px-3 py-2 text-sm ${isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-700'}`;

  return (
    <section className="space-y-6">
      <div className={`rounded-lg border ${border} p-6 text-left shadow-sm`}>
        <h2 className={`mb-1 text-left text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          Telegram Bot
        </h2>
        <p className={`mb-6 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Control Nanobrowser from your phone via Telegram — no separate server needed.
        </p>

        <div className="space-y-5">
          {/* Bot Token */}
          <div className="space-y-1">
            <h3 className={label}>Bot Token</h3>
            <p className={desc}>
              From <strong>@BotFather</strong> on Telegram — send <code>/newbot</code> to create one.
            </p>
            <input
              type="password"
              className={input}
              placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
              value={settings.botToken}
              onChange={e => setSettings(s => ({ ...s, botToken: e.target.value }))}
            />
          </div>

          {/* Allowed User IDs */}
          <div className="space-y-1">
            <h3 className={label}>Allowed Telegram User IDs</h3>
            <p className={desc}>
              Comma-separated IDs of people who can control this bot. Message <strong>@userinfobot</strong> to find
              yours.
            </p>
            <input
              type="text"
              className={input}
              placeholder="123456789, 987654321"
              value={settings.allowedUserIds}
              onChange={e => setSettings(s => ({ ...s, allowedUserIds: e.target.value }))}
            />
          </div>

          {/* Save button */}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-sky-500 px-5 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Credentials'}
          </button>

          {toast && <p className="text-sm text-green-500">{toast}</p>}
        </div>
      </div>

      {/* Start / Stop */}
      <div className={`rounded-lg border ${border} p-6 text-left shadow-sm`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className={label}>Bot Status</h3>
            <p className={desc}>
              {settings.isRunning
                ? '🟢 Running — send a message to your bot on Telegram to run a task.'
                : '⚫ Stopped — save your credentials above, then start the bot.'}
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            className={`min-w-[90px] rounded-md px-5 py-2 text-sm font-semibold text-white transition-colors ${
              settings.isRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'
            }`}>
            {settings.isRunning ? 'Stop Bot' : 'Start Bot'}
          </button>
        </div>
      </div>

      {/* Help */}
      <div className={`rounded-lg border ${border} p-6 text-left shadow-sm`}>
        <h3 className={`mb-3 text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
          Telegram Commands
        </h3>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-700/30">
            {[
              ['/start', 'Show help message'],
              ['/status', 'Check if the bot is connected'],
              ['/stop', 'Abort the current task'],
              ['/again', 'Repeat the last instruction'],
              ['/history', 'Show the last 10 completed tasks'],
              ['any text', 'Execute as a Nanobrowser task'],
            ].map(([cmd, desc_]) => (
              <tr key={cmd}>
                <td className={`py-2 pr-4 font-mono font-medium ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}>
                  {cmd}
                </td>
                <td className={`py-2 ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>{desc_}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
