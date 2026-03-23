import { telegramSettingsStore } from '@extension/storage';
import { createLogger } from '../log';

const logger = createLogger('TelegramBot');

const STEP_FLUSH_MS = 4000;
const POLL_TIMEOUT_S = 25; // seconds for long-poll
const STORAGE_KEY_LAST_UPDATE = 'telegram_last_update_id';

async function loadLastUpdateId(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_LAST_UPDATE);
    const val = stored[STORAGE_KEY_LAST_UPDATE];
    return typeof val === 'number' && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

async function saveLastUpdateId(id: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_UPDATE]: id });
  } catch {
    // non-fatal
  }
}

export type TaskExecutor = (task: string, taskId: string, onStatus: StatusCallback) => void;
export type CancelExecutor = () => void;
export type ScreenshotCapture = () => Promise<string | null>; // resolves to a data-URL or null
export type StatusCallback = (status: string, text: string) => void;

interface PendingTask {
  chatId: number;
  instruction: string;
  startedAt: number;
}

export class TelegramBotService {
  private polling = false;
  private abortController: AbortController | null = null;
  private lastUpdateId = 0;
  private taskExecutor: TaskExecutor;
  private cancelExecutor: CancelExecutor;
  private screenshotCapture: ScreenshotCapture;
  private pendingTasks = new Map<string, PendingTask>();
  private taskHistory: Array<{ instruction: string; status: string; duration: number }> = [];
  private lastInstruction = new Map<number, string>();
  private stepBuffers = new Map<string, { lines: string[]; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(taskExecutor: TaskExecutor, cancelExecutor: CancelExecutor, screenshotCapture: ScreenshotCapture) {
    this.taskExecutor = taskExecutor;
    this.cancelExecutor = cancelExecutor;
    this.screenshotCapture = screenshotCapture;
  }

  async init() {
    const settings = await telegramSettingsStore.getSettings();
    if (settings.isRunning && settings.botToken) {
      logger.info('Resuming Telegram bot (was running before restart)');
      this.beginPolling(settings.botToken, settings.allowedUserIds);
    }
  }

  async start() {
    const settings = await telegramSettingsStore.getSettings();
    if (!settings.botToken.trim()) {
      logger.error('Cannot start: no bot token configured');
      return;
    }
    if (this.polling) return;
    await telegramSettingsStore.updateSettings({ isRunning: true });
    this.beginPolling(settings.botToken, settings.allowedUserIds);
    logger.info('Telegram bot started');
  }

  async stop() {
    this.polling = false;
    this.abortController?.abort();
    this.abortController = null;
    // Clear persisted offset so next start re-drains (don't keep stale offset forever)
    await chrome.storage.local.remove(STORAGE_KEY_LAST_UPDATE);
    this.lastUpdateId = 0;
    await telegramSettingsStore.updateSettings({ isRunning: false });
    logger.info('Telegram bot stopped');
  }

  // Called when storage changes (e.g. user clicks Start/Stop from UI)
  async syncWithStorage() {
    const settings = await telegramSettingsStore.getSettings();
    if (settings.isRunning && !this.polling) {
      this.beginPolling(settings.botToken, settings.allowedUserIds);
    } else if (!settings.isRunning && this.polling) {
      this.polling = false;
      this.abortController?.abort();
      this.abortController = null;
    }
  }

  private parseAllowedIds(raw: string): number[] {
    return raw
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  private beginPolling(botToken: string, allowedUserIds: string) {
    if (this.polling) return;
    this.polling = true;
    const allowed = this.parseAllowedIds(allowedUserIds);
    // Bootstrap: fetch latest update ID without processing, then start real loop
    this.bootstrapAndPoll(botToken, allowed);
  }

  private async bootstrapAndPoll(botToken: string, allowed: number[]) {
    // 1. Try to restore the last processed update_id from persistent storage.
    //    This survives MV3 service-worker restarts, preventing old messages from
    //    being re-delivered and causing tasks to re-run.
    const stored = await loadLastUpdateId();
    if (stored > 0) {
      this.lastUpdateId = stored;
      logger.info(`Resumed polling from stored update_id ${this.lastUpdateId}`);
      this.pollLoop(botToken, allowed);
      return;
    }

    // 2. First-ever start: ask Telegram for the latest pending update_id so we
    //    don't accidentally process messages that arrived before the bot was set up.
    //    We call getUpdates with timeout=0 and keep draining until empty.
    try {
      let offset = 0;
      for (let i = 0; i < 5; i++) {
        // max 5 drain rounds to avoid infinite loop
        const url =
          `https://api.telegram.org/bot${botToken}/getUpdates?limit=100&timeout=0` +
          (offset > 0 ? `&offset=${offset}` : '');
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const data = await res.json();
        if (!data.ok || data.result.length === 0) break;
        const lastId = data.result[data.result.length - 1].update_id as number;
        offset = lastId + 1;
        this.lastUpdateId = lastId;
      }
      if (this.lastUpdateId > 0) {
        // Confirm (acknowledge) everything up to lastUpdateId so Telegram clears them
        await fetch(
          `https://api.telegram.org/bot${botToken}/getUpdates?limit=1&timeout=0&offset=${this.lastUpdateId + 1}`,
          { signal: AbortSignal.timeout(10_000) },
        );
        await saveLastUpdateId(this.lastUpdateId);
        logger.info(`Bootstrap drained up to update_id ${this.lastUpdateId}`);
      }
    } catch {
      // Non-fatal — poll from offset 0 (safe, as there may be no old messages)
    }
    this.pollLoop(botToken, allowed);
  }

  private async pollLoop(botToken: string, allowed: number[]) {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${this.lastUpdateId + 1}`;
        const res = await fetch(url, { signal: this.abortController.signal });
        const data = await res.json();

        if (!data.ok) {
          logger.error('Telegram API error:', data.description);
          await this.sleep(5000);
          continue;
        }

        for (const update of data.result as TelegramUpdate[]) {
          this.lastUpdateId = update.update_id;
          await this.handleUpdate(update, botToken, allowed);
        }
        // Persist after every batch so restarts resume from here
        if ((data.result as TelegramUpdate[]).length > 0) {
          await saveLastUpdateId(this.lastUpdateId);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') break;
        logger.error('Poll error:', err);
        await this.sleep(3000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate, botToken: string, allowed: number[]) {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id ?? 0;
    const text = msg.text.trim();

    // Auth guard
    if (allowed.length > 0 && !allowed.includes(userId)) {
      await this.send(botToken, chatId, `⛔ Unauthorized. Your ID: <code>${userId}</code>`);
      return;
    }

    if (text === '/start') {
      await this.send(
        botToken,
        chatId,
        `👋 <b>Nanobrowser Telegram Control</b>\n\nSend any message to run it as a web task.\n\n` +
          `/status — connection status\n/stop — abort current task\n/sc — screenshot current page\n/again — repeat last task\n/history — recent tasks`,
      );
      return;
    }

    if (text === '/status') {
      const settings = await telegramSettingsStore.getSettings();
      await this.send(
        botToken,
        chatId,
        `✅ <b>Bot running</b>\n🔄 Active tasks: ${this.pendingTasks.size}\n` +
          `🤖 Bot: ${settings.isRunning ? 'on' : 'off'}`,
      );
      return;
    }

    if (text === '/stop') {
      this.cancelExecutor();
      await this.send(botToken, chatId, '🛑 Abort signal sent.');
      return;
    }

    if (text === '/sc') {
      await this.send(botToken, chatId, '📸 Capturing screenshot…');
      const dataUrl = await this.screenshotCapture();
      if (!dataUrl) {
        await this.send(botToken, chatId, '❌ Screenshot failed — no active tab found.');
        return;
      }
      await this.sendPhoto(botToken, chatId, dataUrl);
      return;
    }

    if (text === '/again') {
      const last = this.lastInstruction.get(chatId);
      if (!last) {
        await this.send(botToken, chatId, 'No previous instruction found.');
        return;
      }
      await this.dispatchTask(botToken, chatId, last);
      return;
    }

    if (text === '/history') {
      if (this.taskHistory.length === 0) {
        await this.send(botToken, chatId, 'No tasks completed yet this session.');
        return;
      }
      const lines = [...this.taskHistory]
        .reverse()
        .slice(0, 10)
        .map((t, i) => {
          const icon = t.status === 'completed' ? '✅' : '❌';
          const preview = t.instruction.length > 60 ? t.instruction.slice(0, 60) + '…' : t.instruction;
          return `${icon} <b>${i + 1}.</b> ${this.escape(preview)} <i>(${t.duration}s)</i>`;
        });
      await this.send(botToken, chatId, `<b>Recent tasks:</b>\n\n${lines.join('\n\n')}`);
      return;
    }

    if (text.startsWith('/')) return; // ignore unknown commands

    await this.dispatchTask(botToken, chatId, text);
  }

  private async dispatchTask(botToken: string, chatId: number, instruction: string) {
    const taskId = `tg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.pendingTasks.set(taskId, { chatId, instruction, startedAt: Date.now() });
    this.lastInstruction.set(chatId, instruction);

    await this.send(
      botToken,
      chatId,
      `⚡ <b>Task received!</b>\n\n<i>${this.escape(instruction)}</i>\n\nNanobrowser is executing…`,
    );

    this.taskExecutor(instruction, taskId, (status, text) => {
      this.handleTaskStatus(botToken, taskId, status, text);
    });
  }

  private handleTaskStatus(botToken: string, taskId: string, status: string, text: string) {
    const task = this.pendingTasks.get(taskId);
    if (!task) return;

    if (status === 'step' || status === 'started') {
      if (!this.stepBuffers.has(taskId)) {
        this.stepBuffers.set(taskId, { lines: [], timer: null });
      }
      const buf = this.stepBuffers.get(taskId)!;
      if (text) buf.lines.push(text);
      if (!buf.timer) {
        buf.timer = setTimeout(() => {
          const b = this.stepBuffers.get(taskId);
          if (!b || b.lines.length === 0) {
            this.stepBuffers.delete(taskId);
            return;
          }
          const combined = b.lines.splice(0).slice(-6).join('\n');
          this.stepBuffers.set(taskId, { lines: [], timer: null });
          this.send(botToken, task.chatId, `🔸 <b>Working…</b>\n${this.escape(combined)}`).catch(() => {});
        }, STEP_FLUSH_MS);
      }
      return;
    }

    // Terminal status — flush buffer then send final message
    const buf = this.stepBuffers.get(taskId);
    if (buf?.timer) {
      clearTimeout(buf.timer);
      this.stepBuffers.delete(taskId);
    }

    const emoji = status === 'completed' ? '✅' : status === 'error' ? '❌' : '🔄';
    const duration = Math.round((Date.now() - task.startedAt) / 1000);

    this.send(
      botToken,
      task.chatId,
      `${emoji} <b>${status.charAt(0).toUpperCase() + status.slice(1)}</b> <i>(${duration}s)</i>\n${this.escape(text || '')}`,
    ).catch(() => {});

    if (status === 'completed' || status === 'error') {
      this.taskHistory.push({ instruction: task.instruction, status, duration });
      if (this.taskHistory.length > 10) this.taskHistory.shift();
      this.pendingTasks.delete(taskId);
    }
  }

  private async send(botToken: string, chatId: number, html: string) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error('sendMessage failed:', err);
    }
  }

  private async sendPhoto(botToken: string, chatId: number, dataUrl: string) {
    try {
      // Convert data-URL to Blob by fetching it (works in service workers)
      const blob = await (await fetch(dataUrl)).blob();
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('photo', blob, 'screenshot.png');
      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();
      if (!data.ok) {
        logger.error('sendPhoto failed:', data.description);
        await this.send(botToken, chatId, `❌ Could not send photo: ${data.description}`);
      }
    } catch (err) {
      logger.error('sendPhoto error:', err);
      await this.send(botToken, chatId, '❌ Screenshot upload failed.');
    }
  }

  private escape(str: string) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ── Telegram API types ────────────────────────────────────────────────────────
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}
