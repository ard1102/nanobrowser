console.log('content script loaded');

// Relay Telegram bridge status updates from the background as DOM events.
// The Nanobrowser Telegram Bridge sidecar extension listens for 'nanobrowser:status'.
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'nb_telegram_status') {
    document.dispatchEvent(
      new CustomEvent('nanobrowser:status', {
        detail: {
          taskId: message.taskId,
          status: message.status,
          text: message.text,
        },
        bubbles: true,
      }),
    );
  }
});

// DOM event fallback: sidecar dispatches 'nanobrowser:telegram:task' when
// cross-extension messaging is unavailable. Relay it to the background.
document.addEventListener('nanobrowser:telegram:task', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  if (!detail?.instruction) return;
  chrome.runtime.sendMessage({
    type: 'nb_telegram_task',
    task: detail.instruction,
    taskId: detail.taskId,
  });
});
