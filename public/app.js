const $ = (id) => document.getElementById(id);
const state = { key: '', slots: [], selected: null, date: '', pending: null, cursor: null, email: '', busy: false, generation: 0 };
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dateKey = (date) => new Date(date).toLocaleDateString('en-CA');
$('timezone').textContent = `Times shown in ${Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')}`;

function message(id, text, isError = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', isError);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-API-Key': state.key, ...options.headers } });
  } catch {
    throw new Error('We couldn’t reach the clinic. Check your connection and try again.');
  }
  const body = await response.json().catch(() => ({ error: 'The clinic returned an unexpected response. Please try again.' }));
  if (!response.ok) {
    const suffix = response.status === 429 ? ` Try again in ${response.headers.get('Retry-After') || '60'} seconds.` : '';
    const error = new Error((body.error || 'Something went wrong.') + suffix);
    error.status = response.status;
    throw error;
  }
  return body;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function resetSelection() {
  state.selected = null;
  state.pending = null;
  $('selected-slot').replaceChildren(el('span', '◷'));
  const copy = el('p', 'No time selected yet');
  copy.append(el('small', 'Pick an available appointment on the left.'));
  $('selected-slot').append(copy);
  for (const id of ['patient-name', 'patient-email', 'book-button']) $(id).disabled = true;
}

function selectSlot(slot) {
  state.selected = slot;
  state.pending = null;
  const copy = el('p', `${dateFormat.format(new Date(slot.start))} · ${timeFormat.format(new Date(slot.start))}`);
  copy.append(el('small', `${slot.provider} · ${Math.round((new Date(slot.end) - new Date(slot.start)) / 60000)} minutes`));
  $('selected-slot').replaceChildren(el('span', '◷'), copy);
  for (const id of ['patient-name', 'patient-email', 'book-button']) $(id).disabled = false;
  message('booking-message', '');
  renderTimes();
}

function filteredSlots() {
  return state.slots.filter((slot) => slot.available && new Date(slot.start) > new Date() &&
    (!$('provider').value || slot.provider === $('provider').value));
}

function renderDates() {
  const dates = [...new Set(filteredSlots().map((slot) => dateKey(slot.start)))];
  if (!dates.includes(state.date)) state.date = dates[0] || '';
  $('date-list').replaceChildren();
  for (const date of dates) {
    const start = new Date(filteredSlots().find((slot) => dateKey(slot.start) === date).start);
    const button = el('button', undefined, `date-button${state.date === date ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.date === date));
    button.setAttribute('aria-label', dateFormat.format(start));
    button.append(el('small', start.toLocaleDateString(undefined, { weekday: 'short' })),
      el('strong', String(start.getDate())), el('small', start.toLocaleDateString(undefined, { month: 'short' })));
    button.addEventListener('click', () => { state.date = date; renderDates(); });
    $('date-list').append(button);
  }
  renderTimes();
}

function renderTimes() {
  const slots = filteredSlots().filter((slot) => dateKey(slot.start) === state.date);
  $('slot-count').textContent = `${slots.length} available`;
  $('slot-list').replaceChildren();
  if (!slots.length) {
    const empty = el('div', undefined, 'empty-state');
    empty.append(el('span', '◷'), el('p', state.key ? 'No available appointments right now.' : 'Your next appointment starts here.'),
      el('small', state.key ? 'Try another practitioner or check back soon.' : 'Connect above to see available times.'));
    $('slot-list').append(empty);
  }
  for (const slot of slots) {
    const button = el('button', timeFormat.format(new Date(slot.start)), `slot-button${state.selected?.id === slot.id ? ' selected' : ''}`);
    button.type = 'button';
    button.disabled = state.busy;
    button.setAttribute('aria-pressed', String(state.selected?.id === slot.id));
    button.append(el('small', slot.provider));
    button.addEventListener('click', () => selectSlot(slot));
    $('slot-list').append(button);
  }
}

async function refreshSlots() {
  const generation = state.generation;
  $('refresh').disabled = true;
  message('slot-message', 'Checking the latest availability…');
  try {
    const data = await api('/slots');
    if (generation !== state.generation) return;
    state.slots = data.slots;
    const previous = $('provider').value;
    $('provider').replaceChildren(new Option('All practitioners', ''));
    for (const provider of [...new Set(state.slots.map((s) => s.provider))].sort()) $('provider').add(new Option(provider, provider));
    if ([...$('provider').options].some((o) => o.value === previous)) $('provider').value = previous;
    if (state.selected && !filteredSlots().some((s) => s.id === state.selected.id)) resetSelection();
    renderDates();
    message('slot-message', 'Choose a day, then a time that suits you.');
  } finally {
    if (generation === state.generation) $('refresh').disabled = !state.key;
  }
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = $('api-key').value.trim();
  state.generation++;
  $('connect-button').disabled = true;
  $('connect-button').textContent = 'Connecting…';
  try {
    await refreshSlots();
    $('connect-form').hidden = true;
    $('connected-bar').hidden = false;
    $('api-key').value = '';
    for (const id of ['provider', 'lookup-value', 'lookup-button']) $(id).disabled = false;
    message('lookup-message', '');
  } catch (error) {
    state.key = '';
    $('refresh').disabled = true;
    message('slot-message', error.message, true);
  } finally {
    $('connect-button').disabled = false;
    $('connect-button').textContent = 'Connect →';
  }
});

$('disconnect').addEventListener('click', () => {
  state.key = '';
  state.generation++;
  state.slots = [];
  state.date = '';
  state.cursor = null;
  state.email = '';
  resetSelection();
  $('connect-form').hidden = false;
  $('connected-bar').hidden = true;
  $('confirmation').hidden = true;
  $('booking-list').replaceChildren();
  $('load-more').hidden = true;
  $('provider').replaceChildren(new Option('All practitioners', ''));
  for (const id of ['provider', 'refresh', 'lookup-value', 'lookup-button']) $(id).disabled = true;
  for (const id of ['patient-name', 'patient-email', 'lookup-value']) $(id).value = '';
  message('slot-message', 'Connect above to see available appointments.');
  message('booking-message', '');
  message('lookup-message', 'Connect to the clinic to manage your appointments.');
  renderDates();
});

$('refresh').addEventListener('click', () => refreshSlots().catch((error) => message('slot-message', error.message, true)));
$('provider').addEventListener('change', () => { resetSelection(); renderDates(); });

$('booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.selected || state.busy) return;
  const selected = state.selected;
  const body = { slot_id: selected.id, name: $('patient-name').value.trim(), email: $('patient-email').value.trim().toLowerCase() };
  const fingerprint = JSON.stringify(body);
  if (state.pending?.fingerprint !== fingerprint) state.pending = { fingerprint, key: crypto.randomUUID() };
  state.busy = true;
  $('book-button').disabled = true;
  $('book-button').textContent = 'Confirming your visit…';
  for (const id of ['patient-name', 'patient-email', 'provider', 'disconnect', 'refresh']) $(id).disabled = true;
  renderTimes();
  message('booking-message', '');
  try {
    const booking = await api('/bookings', { method: 'POST', headers: { 'Idempotency-Key': state.pending.key }, body: fingerprint });
    $('confirmation-detail').textContent = `${booking.name}, your appointment with ${selected.provider} is confirmed for ${dateFormat.format(new Date(selected.start))} at ${timeFormat.format(new Date(selected.start))}.`;
    $('confirmation-id').textContent = booking.id;
    $('confirmation').hidden = false;
    $('lookup-value').value = booking.email;
    $('confirmation').focus({ preventScroll: true });
    $('confirmation').scrollIntoView({ behavior: 'smooth', block: 'center' });
    resetSelection();
    $('booking-form').reset();
    await refreshSlots().catch(() => message('slot-message', 'Your booking is confirmed. Refresh to update the remaining times.', true));
  } catch (error) {
    message('booking-message', error.message, true);
    // Keep the same key for network errors and 5xx; those requests may have committed.
    if (error.status && error.status < 500) state.pending = null;
    if ([400, 404, 409].includes(error.status)) await refreshSlots().catch(() => {});
  } finally {
    state.busy = false;
    $('book-button').textContent = 'Confirm appointment ↗';
    for (const id of ['patient-name', 'patient-email', 'book-button']) $(id).disabled = !state.selected;
    for (const id of ['provider', 'disconnect', 'refresh']) $(id).disabled = false;
    renderTimes();
  }
});

$('another-booking').addEventListener('click', () => {
  $('confirmation').hidden = true;
  $('appointments').scrollIntoView({ behavior: 'smooth' });
});

function renderBooking(booking) {
  const row = el('article', undefined, 'booking-row');
  const details = el('div');
  const slot = state.slots.find((s) => s.id === booking.slot_id);
  details.append(el('span', booking.status, `badge ${booking.status}`),
    el('h3', slot ? `${slot.provider} · ${timeFormat.format(new Date(slot.start))}` : `Appointment ${booking.slot_id}`),
    el('p', slot ? dateFormat.format(new Date(slot.start)) : 'Slot details are unavailable.'),
    el('p', `${booking.name} · ${booking.email}`), el('code', booking.id));
  row.append(details);
  if (booking.status === 'confirmed') {
    const cancel = el('button', 'Cancel visit', 'text-button cancel-button');
    cancel.type = 'button';
    let confirm = false;
    cancel.addEventListener('click', async () => {
      if (!confirm) { confirm = true; cancel.textContent = 'Confirm cancellation?'; return; }
      cancel.disabled = true;
      const generation = state.generation;
      try {
        const cancelled = await api(`/bookings/${encodeURIComponent(booking.id)}`, { method: 'DELETE' });
        if (generation !== state.generation) return;
        row.replaceWith(renderBooking(cancelled));
        if ($('confirmation-id').textContent === booking.id) $('confirmation').hidden = true;
        message('lookup-message', 'Appointment cancelled. The time is available to book again.');
        await refreshSlots().catch(() => {});
      } catch (error) {
        if (generation === state.generation) message('lookup-message', error.message, true);
        cancel.disabled = false;
      }
    });
    row.append(cancel);
  }
  return row;
}

async function lookup(more = false) {
  const value = $('lookup-value').value.trim();
  const generation = state.generation;
  $('lookup-button').disabled = true;
  $('load-more').disabled = true;
  message('lookup-message', 'Finding your appointments…');
  if (!more) { $('booking-list').replaceChildren(); state.cursor = null; $('load-more').hidden = true; }
  try {
    let data;
    if (more || value.includes('@')) {
      if (!more) state.email = value;
      const query = new URLSearchParams({ email: state.email, limit: '5' });
      if (more && state.cursor) query.set('cursor', state.cursor);
      data = await api(`/bookings?${query}`);
    } else {
      data = { bookings: [await api(`/bookings/${encodeURIComponent(value)}`)], next_cursor: null };
    }
    if (generation !== state.generation) return;
    state.cursor = data.next_cursor;
    for (const booking of data.bookings) $('booking-list').append(renderBooking(booking));
    $('load-more').hidden = !state.cursor;
    message('lookup-message', $('booking-list').childElementCount ? 'Your appointments, oldest first.' : 'No bookings found for this email.');
  } catch (error) {
    if (generation === state.generation) message('lookup-message', error.message, true);
  } finally {
    $('lookup-button').disabled = !state.key;
    $('load-more').disabled = false;
  }
}
$('lookup-form').addEventListener('submit', (event) => { event.preventDefault(); lookup(); });
$('load-more').addEventListener('click', () => lookup(true));
