/* Background service worker — Chrome Manifest V3. */
const MENU_ID = 'read-selected-text';
const DEFAULTS = Object.freeze({ rate: 1, lang: 'auto', voiceId: 'auto', engine: 'auto' });
const MAX_TEXT_LENGTH = 60000;
const OFFSCREEN_PATH = 'offscreen.html';
let offscreenCreation;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '🔊 Прочитать выделенный текст',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID || !info.selectionText) return;
  speakText(info.selectionText).catch(console.error);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    if (command === 'stop-reading') {
      await stopReading();
      return;
    }
    if (command === 'read-selection') {
      const tabId = tab?.id ?? (await activeTabId());
      const text = await selectedText(tabId);
      if (text) await speakText(text);
    }
  } catch (error) {
    console.error('Команда не выполнена:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target === 'offscreen') return false;
  (async () => {
    switch (message.type) {
      case 'GET_SELECTION':
        return { text: await selectedText(await activeTabId()) };
      case 'GET_INFO':
        return await getInfo();
      case 'SPEAK':
        return await speakText(message.text);
      case 'PAUSE':
      case 'RESUME':
      case 'STOP':
        return await controlReading(message.type);
      case 'SAVE_SETTINGS':
        return await saveSettings(message.settings);
      default:
        throw new Error('Неизвестная команда расширения.');
    }
  })().then(
    (data) => sendResponse({ ok: true, ...data }),
    (error) => sendResponse({ ok: false, error: error?.message || String(error) })
  );
  return true;
});

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('Не удалось определить вкладку.');
  return tabs[0].id;
}

async function selectedText(tabId) {
  if (!tabId) throw new Error('Вкладка не найдена.');
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const element = document.activeElement;
        if (element && (element.tagName === 'TEXTAREA' ||
            (element.tagName === 'INPUT' && /^(text|search|url|email|tel)$/i.test(element.type)))) {
          const start = element.selectionStart;
          const end = element.selectionEnd;
          if (typeof start === 'number' && typeof end === 'number' && end > start) {
            return element.value.substring(start, end).trim();
          }
        }
        return window.getSelection()?.toString().trim() || '';
      }
    });
  } catch {
    throw new Error('Не могу прочитать выделение на этой странице. Выделите текст на обычном сайте или вставьте его в окно расширения.');
  }
  return results?.map(item => item.result || '').find(Boolean) || '';
}

function detectLanguage(text) {
  const armenian = (text.match(/[\u0531-\u058F]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u052F]/g) || []).length;
  if (armenian > cyrillic && armenian > 0) return 'hy-AM';
  if (cyrillic > 0) return 'ru-RU';
  return 'en-US';
}

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function saveSettings(raw) {
  const allowed = {};
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.rate)) allowed.rate = Math.max(0.5, Math.min(2, raw.rate));
    if (['auto', 'ru-RU', 'en-US', 'hy-AM'].includes(raw.lang)) allowed.lang = raw.lang;
    if (typeof raw.voiceId === 'string' && raw.voiceId.length < 300) allowed.voiceId = raw.voiceId;
    if (['auto', 'chrome', 'web'].includes(raw.engine)) allowed.engine = raw.engine;
  }
  await chrome.storage.local.set(allowed);
  return { settings: await getSettings() };
}

async function getChromeVoices() {
  try { return await chrome.tts.getVoices(); }
  catch { return []; }
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Озвучивание выделенного пользователем текста при закрытом окне расширения'
    }).finally(() => { offscreenCreation = undefined; });
  }
  await offscreenCreation;
}

async function offscreenMessage(type, payload = {}, create = true) {
  if (create) await ensureOffscreen();
  else if (!(await hasOffscreenDocument())) return null;
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen', type, ...payload
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function getInfo() {
  const [settings, chromeVoices, offscreenVoices, isSpeaking] = await Promise.all([
    getSettings(),
    getChromeVoices(),
    offscreenMessage('GET_VOICES').catch(() => ({ voices: [] })),
    chrome.tts.isSpeaking().catch(() => false)
  ]);
  const voices = [
    ...chromeVoices.filter(v => v.voiceName).map(v => ({
      id: 'chrome:' + v.voiceName,
      label: `${v.voiceName} · ${v.lang || 'неизвестный язык'}`,
      engine: 'chrome'
    })),
    ...(offscreenVoices?.voices || []).filter(v => v.name).map(v => ({
      id: 'web:' + v.name,
      label: `${v.name} · ${v.lang || 'неизвестный язык'}`,
      engine: 'web'
    }))
  ];
  const active = await chrome.storage.session.get('activeEngine');
  const webState = await offscreenMessage('GET_STATE', {}, false).catch(() => null);
  const state = active.activeEngine === 'web'
    ? (webState?.status || 'idle')
    : (isSpeaking ? 'playing' : 'idle');
  return { settings, voices, state, chromeVoiceCount: chromeVoices.length, webVoiceCount: offscreenVoices?.voices?.length || 0 };
}

function chunksOf(text, limit = 260) {
  const result = [];
  const paragraphs = text.replace(/\r/g, '').split(/\n+/);
  for (const paragraph of paragraphs) {
    let remaining = paragraph.trim();
    while (remaining.length) {
      if (remaining.length <= limit) {
        result.push(remaining);
        break;
      }
      const candidate = remaining.substring(0, limit + 1);
      const sentence = Math.max(candidate.lastIndexOf('. '), candidate.lastIndexOf('! '), candidate.lastIndexOf('? '));
      const space = candidate.lastIndexOf(' ');
      const cut = sentence > limit * 0.35 ? sentence + 1 : (space > limit * 0.35 ? space : limit);
      result.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
  }
  return result.filter(Boolean);
}

async function speakText(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) throw new Error('Сначала выделите текст на странице или вставьте его в поле.');
  if (text.length > MAX_TEXT_LENGTH) throw new Error('Выделено более 60 000 символов. Выберите фрагмент короче.');

  const settings = await getSettings();
  const lang = settings.lang === 'auto' ? detectLanguage(text) : settings.lang;
  const voiceId = settings.voiceId;
  const voiceType = voiceId.startsWith('chrome:') ? 'chrome' : voiceId.startsWith('web:') ? 'web' : null;
  const chromeVoices = await getChromeVoices();
  const engine = settings.engine !== 'auto'
    ? settings.engine
    : (voiceType || (chromeVoices.length ? 'chrome' : 'web'));

  await stopReading();
  const chunks = chunksOf(text);
  if (engine === 'web') {
    const result = await offscreenMessage('SPEAK', {
      chunks, lang, rate: settings.rate,
      voiceName: voiceType === 'web' ? voiceId.slice(4) : null
    });
    if (!result?.started) throw new Error('Веб-движок не смог запустить озвучивание.');
  } else {
    if (!chromeVoices.length) {
      throw new Error('Голоса Chrome TTS не найдены. Выберите «Автоматически» или «Веб-движок» в настройках.');
    }
    const options = { rate: settings.rate, lang };
    if (voiceType === 'chrome') {
      const selected = chromeVoices.find(v => v.voiceName === voiceId.slice(7));
      if (selected) {
        options.voiceName = selected.voiceName;
        if (settings.lang === 'auto' && selected.lang) options.lang = selected.lang;
      }
    }
    try {
      for (let i = 0; i < chunks.length; i++) {
        await chrome.tts.speak(chunks[i], { ...options, enqueue: i > 0 });
      }
    } catch (error) {
      chrome.tts.stop();
      throw new Error('Ошибка Chrome TTS: ' + (error?.message || String(error)));
    }
  }
  await chrome.storage.session.set({ activeEngine: engine });
  return { state: 'playing', length: text.length, engine };
}

async function controlReading(type) {
  const { activeEngine } = await chrome.storage.session.get('activeEngine');
  if (type === 'STOP') return stopReading();
  if (activeEngine === 'web') {
    const reply = await offscreenMessage(type, {}, false);
    return { state: reply?.status || 'idle' };
  }
  if (type === 'PAUSE') chrome.tts.pause();
  if (type === 'RESUME') chrome.tts.resume();
  return { state: type === 'PAUSE' ? 'paused' : 'playing' };
}

async function stopReading() {
  chrome.tts.stop();
  await offscreenMessage('STOP', {}, false).catch(() => {});
  await chrome.storage.session.remove('activeEngine');
  return { state: 'idle' };
}
