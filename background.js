/* Manifest V3. Only reads the active tab after a user action. */
const DEFAULTS = Object.freeze({
  rate: 1, pitch: 1, volume: 1, lang: 'auto', voiceId: 'auto', engine: 'auto', theme: 'system'
});
const MAX_TEXT_LENGTH = 60000;
const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreation;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: '🔊 Прочитать выделение', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-article', title: '📖 Прочитать текст страницы', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  (async () => {
    if (info.menuItemId === 'read-selection' && info.selectionText) await speakText(info.selectionText);
    if (info.menuItemId === 'read-article') await speakText(await pageText(tab?.id || await activeTabId()));
  })().catch(error => console.error('Голосовой читатель:', error));
});

chrome.commands.onCommand.addListener((name, tab) => {
  (async () => {
    if (name === 'stop-reading') await stopReading();
    if (name === 'read-selection') await speakText(await selectedText(tab?.id || await activeTabId()));
  })().catch(error => console.error('Голосовой читатель:', error));
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  (async () => {
    switch (message.type) {
      case 'GET_SELECTION': return { text: await selectedText(await activeTabId()) };
      case 'GET_PAGE_TEXT': return { text: await pageText(await activeTabId()) };
      case 'GET_INFO': return getInfo();
      case 'GET_STATUS': return { reading: await currentReading() };
      case 'SPEAK': return speakText(message.text);
      case 'PAUSE': case 'RESUME': return controlReading(message.type);
      case 'STOP': return stopReading();
      case 'SEEK': return seekReading(message.direction);
      case 'SAVE_SETTINGS': return saveSettings(message.settings);
      default: throw new Error('Неизвестная команда.');
    }
  })().then(data => sendResponse({ ok: true, ...data }), error => {
    sendResponse({ ok: false, error: error?.message || String(error) });
  });
  return true;
});

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('Активная вкладка не найдена.');
  return tabs[0].id;
}

async function executeOnTab(tabId, func, allFrames = false) {
  if (!tabId) throw new Error('Вкладка не найдена.');
  try {
    return await chrome.scripting.executeScript({ target: { tabId, allFrames }, func });
  } catch {
    throw new Error('На этой странице доступ к тексту ограничен. Попробуйте обычный сайт или вставьте текст вручную.');
  }
}

async function selectedText(tabId) {
  const getText = () => {
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(el.type)))) {
      if (typeof el.selectionStart === 'number' && el.selectionEnd > el.selectionStart) {
        return el.value.slice(el.selectionStart, el.selectionEnd).trim();
      }
    }
    return window.getSelection()?.toString().trim() || '';
  };
  // Cross-origin frames can prevent all-frame injection. The main frame is a safe fallback.
  let results;
  try { results = await executeOnTab(tabId, getText, true); }
  catch { results = await executeOnTab(tabId, getText); }
  return results.find(item => item.result)?.result || '';
}

async function pageText(tabId) {
  const results = await executeOnTab(tabId, () => {
    const ignored = 'nav, aside, footer, header, form, script, style, noscript, [aria-hidden="true"], [role="navigation"], [role="complementary"]';
    const containers = [...document.querySelectorAll('article, main, [role="main"]')];
    const root = containers.sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0))[0] || document.body;
    if (!root) return '';
    const sections = [...root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre')];
    const output = [];
    let total = 0;
    for (const el of sections) {
      if (el.closest(ignored) || !el.getClientRects().length) continue;
      // Skip containers containing nested paragraphs/list items, avoiding repeated lines.
      if (el.matches('li,blockquote') && el.querySelector('p,li')) continue;
      const value = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (value.length < 16 || value.length > 4000) continue;
      output.push(value);
      total += value.length + 2;
      if (total >= 59000) break;
    }
    return output.join('\n\n').slice(0, 60000);
  });
  const text = results[0]?.result || '';
  if (!text.trim()) throw new Error('Не удалось найти основной текст. Выделите нужный фрагмент вручную.');
  return text;
}

function detectLanguage(text) {
  const hy = (text.match(/[\u0531-\u058F]/g) || []).length;
  const ru = (text.match(/[\u0400-\u052F]/g) || []).length;
  return hy > ru && hy > 0 ? 'hy-AM' : ru > 0 ? 'ru-RU' : 'en-US';
}

function chunksOf(input, limit = 240) {
  const parts = [];
  for (const paragraph of input.replace(/\r/g, '').split(/\n+/)) {
    let remaining = paragraph.replace(/\s+/g, ' ').trim();
    while (remaining) {
      if (remaining.length <= limit) { parts.push(remaining); break; }
      const fragment = remaining.slice(0, limit + 1);
      const marks = [...fragment.matchAll(/[.!?։。！？]\s/g)];
      const sentence = marks.length ? marks[marks.length - 1].index + 1 : -1;
      const word = fragment.lastIndexOf(' ');
      const split = sentence > limit * 0.38 ? sentence : word > limit * 0.38 ? word : limit;
      parts.push(remaining.slice(0, split).trim());
      remaining = remaining.slice(split).trim();
    }
  }
  return parts.filter(Boolean);
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function saveSettings(raw = {}) {
  const safe = {};
  if (Number.isFinite(raw.rate)) safe.rate = Math.max(0.5, Math.min(2.5, raw.rate));
  if (Number.isFinite(raw.pitch)) safe.pitch = Math.max(0.5, Math.min(2, raw.pitch));
  if (Number.isFinite(raw.volume)) safe.volume = Math.max(0, Math.min(1, raw.volume));
  if (['auto', 'ru-RU', 'en-US', 'hy-AM'].includes(raw.lang)) safe.lang = raw.lang;
  if (['auto', 'chrome', 'web'].includes(raw.engine)) safe.engine = raw.engine;
  if (['system', 'light', 'dark'].includes(raw.theme)) safe.theme = raw.theme;
  if (typeof raw.voiceId === 'string' && raw.voiceId.length <= 350) safe.voiceId = raw.voiceId;
  await chrome.storage.local.set(safe);
  return { settings: await getSettings() };
}

async function chromeVoices() {
  try { return await chrome.tts.getVoices(); } catch { return []; }
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Воспроизведение текста через Web Speech API при закрытом окне расширения'
    }).finally(() => { offscreenCreation = undefined; });
  }
  await offscreenCreation;
}

async function offscreen(type, data = {}, create = true) {
  if (create) await ensureOffscreen();
  else if (!(await hasOffscreen())) return null;
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function currentReading() {
  const { reading } = await chrome.storage.session.get('reading');
  if (!reading) return { status: 'idle', index: 0, total: 0 };
  if (reading.engine === 'web') {
    const live = await offscreen('GET_STATE', {}, false).catch(() => null);
    return { status: live?.status || 'idle', index: live?.index ?? reading.index,
      total: live?.total ?? reading.chunks.length, engine: 'web', text: reading.text,
      error: live?.lastError || '' };
  }
  return { status: reading.status, index: reading.index,
    total: reading.chunks.length, engine: 'chrome', text: reading.text, error: reading.error || '' };
}

async function getInfo() {
  const [settings, cVoices, wVoices, reading] = await Promise.all([
    getSettings(), chromeVoices(), offscreen('GET_VOICES').catch(() => ({ voices: [] })), currentReading()
  ]);
  const voices = [
    ...cVoices.filter(v => v.voiceName).map(v => ({
      id: 'chrome:' + v.voiceName, label: v.voiceName, lang: v.lang || '', engine: 'chrome'
    })),
    ...(wVoices?.voices || []).filter(v => v.name).map(v => ({
      id: 'web:' + v.name, label: v.name, lang: v.lang || '', engine: 'web'
    }))
  ];
  return { settings, voices, reading };
}

async function setBadge(status) {
  try {
    await chrome.action.setBadgeText({ text: status === 'playing' ? '▶' : status === 'paused' ? 'Ⅱ' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#516fe4' });
  } catch { /* Badge isn't essential to playback. */ }
}

async function speakText(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) throw new Error('Выделите текст или вставьте его в поле.');
  if (text.length > MAX_TEXT_LENGTH) throw new Error('Максимальная длина — 60 000 символов.');
  const settings = await getSettings();
  const lang = settings.lang === 'auto' ? detectLanguage(text) : settings.lang;
  const [cVoices, wVoices] = await Promise.all([
    chromeVoices(), offscreen('GET_VOICES').catch(() => ({ voices: [] }))
  ]);
  const webVoices = wVoices?.voices || [];
  const preferred = settings.voiceId.startsWith('chrome:') ? 'chrome' :
    settings.voiceId.startsWith('web:') ? 'web' : null;
  const chromeMatch = cVoices.some(v => v.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const webMatch = webVoices.some(v => v.lang?.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
  const engine = settings.engine !== 'auto' ? settings.engine :
    preferred || (chromeMatch ? 'chrome' : webMatch ? 'web' : cVoices.length ? 'chrome' : 'web');
  if (engine === 'chrome' && !cVoices.length) throw new Error('Chrome TTS не обнаружил голосов. Выберите «Web Speech».');
  if (engine === 'web' && !webVoices.length) throw new Error('Web Speech не обнаружил голосов. Выберите «Chrome TTS» или установите совместимый голос.');
  const chunks = chunksOf(text);
  if (!chunks.length) throw new Error('В тексте нет фрагментов для чтения.');
  await stopReading();
  const reading = {
    id: crypto.randomUUID(), text, chunks, engine, lang,
    rate: settings.rate, pitch: settings.pitch, volume: settings.volume,
    voiceId: settings.voiceId, status: 'playing', index: 0, error: ''
  };
  await chrome.storage.session.set({ reading });
  try {
    if (engine === 'web') {
      await offscreen('SPEAK', {
        chunks, lang, rate: reading.rate, pitch: reading.pitch, volume: reading.volume,
        voiceName: preferred === 'web' ? settings.voiceId.slice(4) : null
      });
    } else {
      await queueChrome(reading, 0, cVoices);
    }
    await setBadge('playing');
    return { reading: await currentReading(), engine };
  } catch (error) {
    await stopReading();
    throw error;
  }
}

async function queueChrome(reading, fromIndex, suppliedVoices) {
  const voices = suppliedVoices || await chromeVoices();
  chrome.tts.stop();
  const selected = reading.voiceId.startsWith('chrome:')
    ? voices.find(v => v.voiceName === reading.voiceId.slice(7)) : null;
  const automatic = selected || voices.find(v => v.lang?.toLowerCase().startsWith(reading.lang.slice(0, 2).toLowerCase()));
  for (let i = fromIndex; i < reading.chunks.length; i++) {
    const idx = i;
    const options = {
      lang: automatic?.lang || reading.lang,
      rate: reading.rate, pitch: reading.pitch, volume: reading.volume,
      enqueue: i > fromIndex,
      onEvent: event => onChromeEvent(reading.id, idx, event).catch(console.error)
    };
    if (automatic?.voiceName) options.voiceName = automatic.voiceName;
    await chrome.tts.speak(reading.chunks[i], options);
  }
}

async function onChromeEvent(id, index, event) {
  const { reading } = await chrome.storage.session.get('reading');
  if (!reading || reading.id !== id || reading.engine !== 'chrome') return;
  if (event.type === 'start') {
    reading.status = 'playing';
    reading.index = Math.max(reading.index, index);
  } else if (event.type === 'end') {
    reading.index = Math.max(reading.index, index + 1);
    if (reading.index >= reading.chunks.length) {
      reading.status = 'idle';
      await setBadge('idle');
    }
  } else if (event.type === 'error') {
    reading.status = 'error';
    reading.error = event.errorMessage || 'Ошибка речевого движка.';
    await setBadge('idle');
  } else if (event.type === 'pause' || event.type === 'resume') {
    reading.status = event.type === 'pause' ? 'paused' : 'playing';
  } else return;
  await chrome.storage.session.set({ reading });
}

async function controlReading(type) {
  const { reading } = await chrome.storage.session.get('reading');
  if (!reading || !['playing', 'paused'].includes((await currentReading()).status)) {
    throw new Error('Сейчас ничего не воспроизводится.');
  }
  if (reading.engine === 'web') {
    const live = await offscreen(type, {}, false);
    reading.status = live?.status || 'idle';
  } else {
    if (type === 'PAUSE') chrome.tts.pause();
    else chrome.tts.resume();
    reading.status = type === 'PAUSE' ? 'paused' : 'playing';
  }
  await chrome.storage.session.set({ reading });
  await setBadge(reading.status);
  return { reading: await currentReading() };
}

async function seekReading(direction) {
  if (direction !== -1 && direction !== 1) throw new Error('Неверное направление перехода.');
  const { reading } = await chrome.storage.session.get('reading');
  if (!reading || !reading.chunks?.length) throw new Error('Нет текущего текста.');
  if (!['playing', 'paused'].includes((await currentReading()).status)) {
    throw new Error('Сначала запустите чтение.');
  }
  const fromIndex = (await currentReading()).index;
  const targetIndex = Math.max(0, Math.min(reading.chunks.length - 1, fromIndex + direction));
  reading.id = crypto.randomUUID();
  reading.index = targetIndex;
  reading.status = 'playing';
  await chrome.storage.session.set({ reading });
  if (reading.engine === 'web') {
    await offscreen('SEEK', { index: targetIndex }, false);
  } else {
    await queueChrome(reading, targetIndex);
  }
  await setBadge('playing');
  return { reading: await currentReading() };
}

async function stopReading() {
  chrome.tts.stop();
  await offscreen('STOP', {}, false).catch(() => {});
  await chrome.storage.session.remove('reading');
  await setBadge('idle');
  return { reading: { status: 'idle', index: 0, total: 0 } };
}
