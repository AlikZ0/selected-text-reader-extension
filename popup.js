const $ = id => document.getElementById(id);
const text = $('text');
const feedback = $('feedback');
const settingsInputs = ['rate', 'lang', 'engine', 'voice'];
let voiceOptions = [];

async function request(type, data = {}) {
  const reply = await chrome.runtime.sendMessage({ type, ...data });
  if (!reply?.ok) throw new Error(reply?.error || 'Ошибка связи с расширением.');
  return reply;
}

function setFeedback(message, isError = false) {
  feedback.textContent = message;
  feedback.classList.toggle('error', isError);
}

function setState(state) {
  const names = { idle: 'Готово', playing: 'Читает', paused: 'Пауза' };
  const el = $('state');
  el.textContent = names[state] || 'Готово';
  el.className = 'state ' + (state || 'idle');
}

function countText() {
  $('counter').textContent = text.value.length.toLocaleString('ru-RU') + ' символов';
}

function updateRate() {
  $('rateValue').textContent = Number($('rate').value).toFixed(1) + '×';
}

function renderVoices(selected = 'auto') {
  const select = $('voice');
  select.replaceChildren(new Option('Автовыбор голоса', 'auto'));
  const engine = $('engine').value;
  const matching = voiceOptions.filter(v => engine === 'auto' || v.engine === engine);
  for (const voice of matching) {
    const prefix = engine === 'auto' ? (voice.engine === 'chrome' ? 'Chrome · ' : 'Web · ') : '';
    select.add(new Option(prefix + voice.label, voice.id));
  }
  select.value = matching.some(v => v.id === selected) ? selected : 'auto';
  const noVoices = voiceOptions.length === 0;
  $('voiceHint').textContent = noVoices
    ? 'Голоса не обнаружены. На Ubuntu может потребоваться дополнительный голосовой движок. Попробуйте «Веб-движок».'
    : `Доступно голосов: ${matching.length}. Доступность русского и армянского зависит от установленных голосов.`;
}

async function saveSettings() {
  const settings = {
    rate: Number($('rate').value),
    lang: $('lang').value,
    engine: $('engine').value,
    voiceId: $('voice').value
  };
  await request('SAVE_SETTINGS', { settings });
}

async function loadSelection() {
  try {
    const reply = await request('GET_SELECTION');
    if (reply.text) {
      text.value = reply.text;
      countText();
      setFeedback('Выделенный текст получен.');
    } else if (!text.value) {
      setFeedback('Выделите текст на странице или вставьте его сюда.');
    }
  } catch (error) {
    setFeedback(error.message, true);
  }
}

async function action(type, data) {
  const button = type === 'SPEAK' ? $('play') : null;
  if (button) button.disabled = true;
  try {
    const reply = await request(type, data);
    setState(reply.state);
    setFeedback(type === 'SPEAK'
      ? `Озвучивание запущено (${reply.engine === 'web' ? 'веб-движок' : 'Chrome TTS'}).`
      : type === 'PAUSE' ? 'Чтение приостановлено.'
      : type === 'RESUME' ? 'Чтение продолжается.' : 'Чтение остановлено.');
  } catch (error) {
    setFeedback(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

text.addEventListener('input', countText);
$('refresh').addEventListener('click', loadSelection);
$('play').addEventListener('click', async () => {
  await saveSettings().catch(e => setFeedback(e.message, true));
  await action('SPEAK', { text: text.value });
});
$('pause').addEventListener('click', () => action('PAUSE'));
$('resume').addEventListener('click', () => action('RESUME'));
$('stop').addEventListener('click', () => action('STOP'));
$('rate').addEventListener('input', updateRate);
for (const id of settingsInputs) {
  $(id).addEventListener('change', async () => {
    if (id === 'engine') renderVoices($('voice').value);
    try { await saveSettings(); }
    catch (error) { setFeedback(error.message, true); }
  });
}

(async () => {
  countText();
  try {
    const info = await request('GET_INFO');
    const s = info.settings;
    $('rate').value = s.rate;
    $('lang').value = s.lang;
    $('engine').value = s.engine;
    voiceOptions = info.voices || [];
    renderVoices(s.voiceId);
    updateRate();
    setState(info.state);
  } catch (error) {
    setFeedback(error.message, true);
  }
  await loadSelection();
})();
