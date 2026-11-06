/* The Web Speech fallback lives here so it survives popup closure. */
const synth = window.speechSynthesis;
let generation = 0;
let queue = [];
let nextIndex = 0;
let status = 'idle';
let currentUtterance = null;
let config = { lang: 'ru-RU', rate: 1, voiceName: null };

function availableVoices() {
  return synth.getVoices().map(v => ({ name: v.name, lang: v.lang, localService: v.localService }));
}

async function voicesReady() {
  const initial = availableVoices();
  if (initial.length) return initial;
  return new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      synth.removeEventListener('voiceschanged', finish);
      clearTimeout(timeout);
      resolve(availableVoices());
    };
    synth.addEventListener('voiceschanged', finish);
    const timeout = setTimeout(finish, 700);
  });
}

function cancel() {
  generation++;
  queue = [];
  nextIndex = 0;
  currentUtterance = null;
  status = 'idle';
  synth.cancel();
}

function continueQueue(id) {
  if (id !== generation) return;
  if (nextIndex >= queue.length) {
    currentUtterance = null;
    queue = [];
    status = 'idle';
    return;
  }
  const utterance = new SpeechSynthesisUtterance(queue[nextIndex++]);
  utterance.lang = config.lang;
  utterance.rate = config.rate;
  const found = synth.getVoices().find(v => v.name === config.voiceName);
  if (found) {
    utterance.voice = found;
    utterance.lang = found.lang || config.lang;
  }
  utterance.onstart = () => { if (id === generation) status = 'playing'; };
  utterance.onend = () => { if (id === generation) continueQueue(id); };
  utterance.onerror = (event) => {
    if (id !== generation) return;
    // 'canceled' and 'interrupted' can legitimately follow Stop.
    console.error('Web Speech:', event.error);
    cancel();
  };
  currentUtterance = utterance;
  synth.speak(utterance);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  (async () => {
    switch (msg.type) {
      case 'GET_VOICES':
        return { voices: await voicesReady() };
      case 'GET_STATE':
        return { status };
      case 'SPEAK': {
        cancel();
        queue = Array.isArray(msg.chunks) ? msg.chunks.filter(Boolean) : [];
        if (!queue.length) throw new Error('Текст отсутствует.');
        config = { lang: msg.lang || 'ru-RU', rate: msg.rate || 1, voiceName: msg.voiceName || null };
        // Browser engines may provide an unnamed default voice.
        const voices = await voicesReady();
        if (!voices.length) {
          cancel();
          throw new Error('Браузер не обнаружил голоса для озвучивания. Установите совместимый движок речи или голос для Chrome.');
        }
        status = 'playing';
        continueQueue(generation);
        return { started: true, status };
      }
      case 'PAUSE':
        if (status === 'playing') { synth.pause(); status = 'paused'; }
        return { status };
      case 'RESUME':
        if (status === 'paused') { synth.resume(); status = 'playing'; }
        return { status };
      case 'STOP':
        cancel();
        return { status };
      default:
        return { error: 'Неизвестная команда аудио-движка.' };
    }
  })().then(
    reply => sendResponse(reply),
    error => sendResponse({ error: error?.message || String(error) })
  );
  return true;
});
