/* Web Speech playback in an offscreen document survives closing the popup. */
const synth = window.speechSynthesis;
let generation = 0;
let chunks = [];
let index = 0;
let nextIndex = 0;
let status = 'idle';
let lastError = '';
let currentUtterance = null;
let config = { lang: 'ru-RU', rate: 1, pitch: 1, volume: 1, voiceName: null };

function availableVoices() {
  return synth.getVoices().map(v => ({ name: v.name, lang: v.lang, localService: v.localService }));
}

async function voicesReady() {
  if (availableVoices().length) return availableVoices();
  return new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', done);
      resolve(availableVoices());
    };
    synth.addEventListener('voiceschanged', done);
    const timer = setTimeout(done, 800);
  });
}

function cancel(clear = true) {
  ++generation;
  synth.cancel();
  currentUtterance = null;
  status = 'idle';
  if (clear) { chunks = []; index = 0; nextIndex = 0; lastError = ''; }
}

function playNext(run) {
  if (run !== generation) return;
  if (nextIndex >= chunks.length) {
    status = 'idle';
    index = chunks.length;
    currentUtterance = null;
    return;
  }
  const itemIndex = nextIndex++;
  index = itemIndex;
  const utterance = new SpeechSynthesisUtterance(chunks[itemIndex]);
  const voice = synth.getVoices().find(v => v.name === config.voiceName)
    || synth.getVoices().find(v => v.lang?.toLowerCase().startsWith(config.lang.slice(0, 2).toLowerCase()));
  utterance.lang = voice?.lang || config.lang;
  if (voice) utterance.voice = voice;
  utterance.rate = config.rate;
  utterance.pitch = config.pitch;
  utterance.volume = config.volume;
  utterance.onstart = () => { if (generation === run) status = 'playing'; };
  utterance.onend = () => {
    if (generation !== run) return;
    index = itemIndex + 1;
    playNext(run);
  };
  utterance.onerror = event => {
    if (generation !== run) return;
    if (event.error === 'canceled' || event.error === 'interrupted') return;
    lastError = `Ошибка Web Speech: ${event.error || 'unknown'}`;
    status = 'error';
    currentUtterance = null;
  };
  currentUtterance = utterance;
  synth.speak(utterance);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  (async () => {
    switch (message.type) {
      case 'GET_VOICES': return { voices: await voicesReady() };
      case 'GET_STATE': return { status, index, total: chunks.length, lastError };
      case 'SPEAK': {
        cancel();
        const voices = await voicesReady();
        if (!voices.length) throw new Error('Web Speech не обнаружил голосов.');
        chunks = Array.isArray(message.chunks) ? message.chunks.filter(x => typeof x === 'string' && x.trim()) : [];
        if (!chunks.length) throw new Error('Нет текста для озвучивания.');
        config = {
          lang: message.lang || 'ru-RU', rate: message.rate ?? 1,
          pitch: message.pitch ?? 1, volume: message.volume ?? 1,
          voiceName: message.voiceName || null
        };
        index = nextIndex = 0;
        status = 'playing';
        playNext(generation);
        return { status, index, total: chunks.length };
      }
      case 'SEEK': {
        if (!chunks.length) throw new Error('Нет текущего текста.');
        const target = Math.max(0, Math.min(chunks.length - 1, Number(message.index) || 0));
        cancel(false);
        index = nextIndex = target;
        status = 'playing';
        playNext(generation);
        return { status, index, total: chunks.length };
      }
      case 'PAUSE':
        if (status === 'playing') { synth.pause(); status = 'paused'; }
        return { status, index, total: chunks.length };
      case 'RESUME':
        if (status === 'paused') { synth.resume(); status = 'playing'; }
        return { status, index, total: chunks.length };
      case 'STOP':
        cancel();
        return { status, index, total: 0 };
      default: throw new Error('Неизвестная команда речевого движка.');
    }
  })().then(sendResponse, error => sendResponse({ error: error?.message || String(error) }));
  return true;
});
