const $ = id => document.getElementById(id);
const textarea = $('text');
let voices = [];
let currentStatus = { status: 'idle', index: 0, total: 0 };
let library = [];
let statusTimer;
const inputIds = ['rate', 'pitch', 'volume', 'lang', 'engine', 'voice', 'theme'];

async function call(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'Нет ответа от расширения.');
  return response;
}

function feedback(text = '', error = false) {
  $('feedback').textContent = text;
  $('feedback').classList.toggle('error', error);
}

function wordCount(text) {
  return (text.trim().match(/[^\s]+/g) || []).length;
}

function updateTextStats() {
  const length = textarea.value.length;
  const words = wordCount(textarea.value);
  const minutes = words ? Math.max(1, Math.ceil(words / (175 * Number($('rate').value)))) : 0;
  $('wordCount').textContent = `${words.toLocaleString('ru-RU')} слов`;
  $('timeEstimate').textContent = `~${minutes} мин`;
  $('charCount').textContent = `${length.toLocaleString('ru-RU')} / 60 000`;
  const lang = $('lang').value;
  const hy = (textarea.value.match(/[\u0531-\u058F]/g) || []).length;
  const ru = (textarea.value.match(/[\u0400-\u052F]/g) || []).length;
  const detected = hy > ru && hy > 0 ? 'Հայերեն' : ru > 0 ? 'Русский' : 'English';
  $('languageTag').textContent = lang === 'auto' ? (length ? detected + ' · авто' : 'Автоязык') :
    ({ 'ru-RU': 'Русский', 'en-US': 'English', 'hy-AM': 'Հայերեն' }[lang]);
}

function renderReading(reading = {}) {
  currentStatus = reading;
  const status = reading.status || 'idle';
  const total = reading.total || 0;
  const index = Math.min(total, reading.index || 0);
  const percentage = total ? Math.round(index / total * 100) : 0;
  $('statusText').textContent = ({ idle: 'Готов', playing: 'Читает', paused: 'Пауза', error: 'Ошибка' })[status] || 'Готов';
  $('status').className = 'status ' + status;
  $('progressFill').style.width = percentage + '%';
  $('progressTrack').setAttribute('aria-valuenow', percentage);
  $('progressPercent').textContent = percentage + '%';
  $('progressLabel').textContent = total ? `Фрагмент ${Math.min(index + 1, total)} из ${total}` : 'Готов к чтению';
  if (total && index === total) $('progressLabel').textContent = 'Чтение завершено';
  const active = status === 'playing' || status === 'paused';
  $('prev').disabled = !active || index < 1;
  $('next').disabled = !active || index >= total - 1;
  $('pause').disabled = !active;
  $('stop').disabled = !active;
  $('pause').setAttribute('aria-label', status === 'paused' ? 'Продолжить' : 'Пауза');
  $('pause').title = status === 'paused' ? 'Продолжить' : 'Пауза';
  $('pauseIcon').innerHTML = status === 'paused' ? '<path d="m8 5 11 7-11 7Z" />' : '<path d="M8 5v14M16 5v14" />';
  if (reading.error) feedback(reading.error, true);
}

function updateControls() {
  const rate = Number($('rate').value);
  $('rateValue').textContent = rate.toFixed(1) + '×';
  $('rateChip').textContent = rate.toFixed(1) + '×';
  $('pitchValue').textContent = Number($('pitch').value).toFixed(1);
  $('volumeValue').textContent = Math.round(Number($('volume').value) * 100) + '%';
  document.querySelectorAll('.rate-presets button').forEach(button => {
    button.classList.toggle('active', Math.abs(Number(button.dataset.rate) - rate) < .01);
  });
  updateTextStats();
}

function renderVoices(selected = 'auto') {
  const engine = $('engine').value;
  const lang = $('lang').value;
  const filtered = voices.filter(v => engine === 'auto' || engine === v.engine)
    .sort((a, b) => {
      const pref = v => lang === 'auto' ? 0 : (v.lang || '').startsWith(lang.slice(0, 2)) ? -1 : 0;
      return pref(a) - pref(b) || a.label.localeCompare(b.label);
    });
  const dropdown = $('voice');
  dropdown.replaceChildren(new Option('Автовыбор голоса', 'auto'));
  filtered.forEach(v => dropdown.add(new Option(`${v.label} · ${v.lang || '?'} (${v.engine === 'web' ? 'Web' : 'Chrome'})`, v.id)));
  dropdown.value = filtered.some(v => v.id === selected) ? selected : 'auto';
  $('voiceHint').textContent = filtered.length
    ? `Найдено голосов: ${filtered.length}. Армянский доступен только при наличии подходящего голоса.`
    : 'Голоса не обнаружены. На Linux может потребоваться речевой движок.';
}

function settingsPayload() {
  return {
    rate: Number($('rate').value), pitch: Number($('pitch').value),
    volume: Number($('volume').value), lang: $('lang').value,
    engine: $('engine').value, voiceId: $('voice').value, theme: $('theme').value
  };
}

async function saveSettings() {
  await call('SAVE_SETTINGS', { settings: settingsPayload() });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme === 'system' ? '' : theme;
}

async function readFromPage(type) {
  const button = $(type === 'GET_SELECTION' ? 'getSelection' : 'getArticle');
  button.disabled = true;
  try {
    const { text } = await call(type);
    if (!text) {
      feedback('Выделение пустое. Выделите нужный текст на странице.');
      return;
    }
    textarea.value = text;
    updateTextStats();
    feedback(type === 'GET_PAGE_TEXT' ? 'Текст страницы загружен.' : 'Выделенный текст загружен.');
  } catch (error) { feedback(error.message, true); }
  finally { button.disabled = false; }
}

async function playerAction(type, extra = {}) {
  const button = type === 'SPEAK' ? $('play') : null;
  if (button) button.disabled = true;
  try {
    if (type === 'SPEAK') {
      await saveSettings();
      extra.text = textarea.value;
    }
    const answer = await call(type, extra);
    renderReading(answer.reading);
    const messages = {
      SPEAK: 'Чтение начато.', PAUSE: 'Чтение приостановлено.', RESUME: 'Чтение продолжено.',
      STOP: 'Чтение остановлено.', SEEK: 'Переключено на другой фрагмент.'
    };
    feedback(messages[type]);
  } catch (error) { feedback(error.message, true); }
  finally { if (button) button.disabled = false; }
}

async function loadLibrary() {
  const values = await chrome.storage.local.get('library');
  library = Array.isArray(values.library) ? values.library.slice(0, 12) : [];
  renderLibrary();
}

async function commitLibrary() {
  await chrome.storage.local.set({ library });
  renderLibrary();
}

function renderLibrary() {
  $('libraryCount').firstChild.textContent = library.length + ' ';
  const list = $('libraryList');
  list.replaceChildren();
  if (!library.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Здесь появятся тексты, которые вы сохраните вручную.';
    list.append(p);
    return;
  }
  for (const item of library) {
    const row = document.createElement('div'); row.className = 'saved-item';
    const main = document.createElement('div'); main.className = 'saved-main';
    const title = document.createElement('div'); title.className = 'saved-title'; title.textContent = item.title;
    const date = document.createElement('div'); date.className = 'saved-date';
    date.textContent = `${new Date(item.createdAt).toLocaleDateString('ru-RU')} · ${wordCount(item.text)} слов`;
    main.append(title, date);
    const load = document.createElement('button'); load.type = 'button'; load.className = 'saved-load'; load.textContent = 'Открыть';
    load.addEventListener('click', () => {
      textarea.value = item.text;
      updateTextStats();
      feedback('Текст открыт. Нажмите «Читать».');
      $('libraryDetails').open = false;
    });
    const del = document.createElement('button'); del.type = 'button'; del.className = 'saved-delete'; del.textContent = '×'; del.title = 'Удалить';
    del.setAttribute('aria-label', 'Удалить сохранённый текст');
    del.addEventListener('click', async () => {
      library = library.filter(i => i.id !== item.id);
      await commitLibrary();
      feedback('Текст удалён из сохранённых.');
    });
    row.append(main, load, del);
    list.append(row);
  }
}

async function saveText() {
  const value = textarea.value.trim();
  if (!value) { feedback('Нет текста для сохранения.', true); return; }
  if (library.some(item => item.text === value)) {
    feedback('Этот текст уже сохранён.');
    $('libraryDetails').open = true;
    return;
  }
  library.unshift({ id: crypto.randomUUID(), title: value.split('\n')[0].slice(0, 48), text: value, createdAt: Date.now() });
  library = library.slice(0, 12);
  try {
    await commitLibrary();
    $('libraryDetails').open = true;
    feedback('Текст сохранён локально. Максимум — 12 фрагментов.');
  } catch (error) { feedback('Не удалось сохранить: ' + error.message, true); }
}

textarea.addEventListener('input', updateTextStats);
$('getSelection').addEventListener('click', () => readFromPage('GET_SELECTION'));
$('getArticle').addEventListener('click', () => readFromPage('GET_PAGE_TEXT'));
$('play').addEventListener('click', () => playerAction('SPEAK'));
$('pause').addEventListener('click', () => playerAction(currentStatus.status === 'paused' ? 'RESUME' : 'PAUSE'));
$('prev').addEventListener('click', () => playerAction('SEEK', { direction: -1 }));
$('next').addEventListener('click', () => playerAction('SEEK', { direction: 1 }));
$('stop').addEventListener('click', () => playerAction('STOP'));
$('saveText').addEventListener('click', saveText);
$('clearText').addEventListener('click', () => { textarea.value = ''; updateTextStats(); feedback('Текст очищен.'); });
for (const id of inputIds) {
  $(id).addEventListener('input', () => {
    if (id === 'theme') setTheme($('theme').value);
    if (id === 'engine' || id === 'lang') renderVoices($('voice').value);
    updateControls();
  });
  $(id).addEventListener('change', () => saveSettings().catch(error => feedback(error.message, true)));
}
document.querySelectorAll('.rate-presets button').forEach(button => {
  button.addEventListener('click', async () => {
    $('rate').value = button.dataset.rate;
    updateControls();
    try { await saveSettings(); } catch (error) { feedback(error.message, true); }
  });
});

async function init() {
  updateControls();
  try {
    const [{ settings, voices: voiceList, reading }] = await Promise.all([call('GET_INFO'), loadLibrary()]);
    voices = voiceList || [];
    for (const id of inputIds) if (id !== 'voice' && settings[id] !== undefined) $(id).value = settings[id];
    renderVoices(settings.voiceId);
    setTheme(settings.theme);
    updateControls();
    renderReading(reading);
    if (reading?.text) { textarea.value = reading.text; updateTextStats(); }
    else await readFromPage('GET_SELECTION');
  } catch (error) { feedback(error.message, true); }
  statusTimer = window.setInterval(async () => {
    try { const { reading } = await call('GET_STATUS'); renderReading(reading); }
    catch { /* Worker can be briefly unavailable while Chromium restarts it. */ }
  }, 900);
}
init();
