require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const dayjs = require('dayjs');
// const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const utc = require('dayjs/plugin/utc');
const { formatAvailabilityForChat } = require('./formatAvailabilityForChat');
const timezone = require('dayjs/plugin/timezone');
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter');


const {
 AUTH_MODE = 'OAUTH_USER',
 GOOGLE_CALENDAR_ID,
 CAL_BY_COACH = '',
 TIMEZONE = 'America/Mexico_City',
 GOOGLE_CLIENT_EMAIL,
 GOOGLE_PRIVATE_KEY,
 BOOKING_SUBJECT,
 CLIENT_ID,
 CLIENT_SECRET,
 REFRESH_TOKEN,
 // Opcionales
 DEFAULT_SEND_UPDATES = 'all' // 'all' | 'externalOnly' | 'none'
} = process.env;


/** Auth factory */
function getAuth() {
 if (AUTH_MODE === 'SERVICE_ACCOUNT') {
   if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !BOOKING_SUBJECT) {
     throw new Error('Faltan vars SERVICE_ACCOUNT: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, BOOKING_SUBJECT');
   }
   return new google.auth.JWT({
     email: GOOGLE_CLIENT_EMAIL,
     key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
     scopes: [
       'https://www.googleapis.com/auth/calendar',
       'https://www.googleapis.com/auth/calendar.events',
     ],
     subject: BOOKING_SUBJECT, // impersonación
   });
 }


 // OAUTH_USER
 if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
   throw new Error('Faltan vars OAUTH_USER: CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN');
 }
 const oAuth2 = new google.auth.OAuth2({
   clientId: CLIENT_ID,
   clientSecret: CLIENT_SECRET,
 });
 oAuth2.setCredentials({ refresh_token: REFRESH_TOKEN });
 return oAuth2;
}


function calendarClient() {
 return google.calendar({ version: 'v3', auth: getAuth() });
}


const app = express();
app.use(cors());
app.use(express.json());


/**
* GET /availability
* Query:
*  - start=2025-10-07T09:00:00
*  - end=2025-10-07T18:00:00
*  - granularity=30 (min) opcional
* Respuesta: { busy: [ { start, end } ], freeSlots: [ { start, end } ] }
*/


// dayjs.extend(isSameOrBefore);
// dayjs.extend(utc);
// dayjs.extend(timezone);
// dayjs.extend(isSameOrAfter);

// nueva version ordenada
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

// Forzamos que por defecto todo lo que procese dayjs use la zona del club si no se especifica
dayjs.tz.setDefault(TIMEZONE);


// --- Reglas del club (Puerto Vallarta / MX City timezone) ---
const BUSINESS_HOURS = {
 weekday: { start: '07:00', end: '22:30' }, // L–V
 weekend: { start: '08:00', end: '14:00' }  // S–D
};


function parseHHMM(s) {
 const [h, m] = String(s).split(':').map(n => parseInt(n, 10));
 return { h: h || 0, m: m || 0 };
}


// // Verifica que [startUTC, endUTC) esté completamente dentro de la ventana operativa del día en tz local
// function isWithinBusinessWindow(startUTC, endUTC, tz) {
//  const sLocal = dayjs(startUTC).tz(tz);
//  const eLocal = dayjs(endUTC).tz(tz);
//  // Deben caer el mismo día local para ser válidos (no se permite cruzar día)
//  if (!sLocal.isSame(eLocal, 'day')) return false;
//  const dow = sLocal.day(); // 0 = domingo, 6 = sábado
//  const isWeekend = (dow === 0 || dow === 6);
//  const { start, end } = isWeekend ? BUSINESS_HOURS.weekend : BUSINESS_HOURS.weekday;
//  const { h: sh, m: sm } = parseHHMM(start);
//  const { h: eh, m: em } = parseHHMM(end);
//  const openStart = sLocal.startOf('day').hour(sh).minute(sm);
//  const openEnd   = sLocal.startOf('day').hour(eh).minute(em);
//  return sLocal.isSameOrAfter(openStart) && eLocal.isSameOrBefore(openEnd);
// }

// --- Mejorada: Validación de ventana operativa ---
function isWithinBusinessWindow(startUTC, endUTC, tz) {
  const sLocal = dayjs(startUTC).tz(tz);
  const eLocal = dayjs(endUTC).tz(tz);

  if (!sLocal.isSame(eLocal, 'day')) return false;

  const dow = sLocal.day(); 
  const isWeekend = (dow === 0 || dow === 6);
  const { start, end } = isWeekend ? BUSINESS_HOURS.weekend : BUSINESS_HOURS.weekday;
  
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  
  const openStart = sLocal.clone().hour(sh).minute(sm).second(0);
  const openEnd   = sLocal.clone().hour(eh).minute(em).second(0);

  return sLocal.isSameOrAfter(openStart) && eLocal.isSameOrBefore(openEnd);
}

// 2. Función de parseo flexible (alias=email, alias=id@group.calendar..., o JSON)
function parseCoachMap(str) {
 if (!str) return {};
 try {
   // Permite CAL_BY_COACH como JSON válido
   // EJ: {"Enzo":"enzo@escalateops.com","Wil":"wil.escalanteh@gmail.com"}
   return JSON.parse(str);
 } catch (_) {
   // Permite formato "Alias=valor,Alias2=valor2"
   // EJ: "Enzo=enzo@escalateops.com,Wil=wil.escalanteh@gmail.com"
   return String(str).split(',').reduce((acc, pair) => {
     const [k, v] = pair.split('=').map(s => (s || '').trim());
     if (k && v) acc[k] = v;
     return acc;
   }, {});
 }
}
const COACH_MAP = parseCoachMap(CAL_BY_COACH);


function resolveCoachEmail(qs = {}) {
 const alias = qs.coach && String(qs.coach).trim();
 return alias && COACH_MAP[alias] ? COACH_MAP[alias] : null;
}


// 3. Resolver calendarId según la query
// function resolveCalendarIdFromQuery(qs = {}) {
//  // prioridad 1: calendarId explícito
//  if (qs.calendarId && String(qs.calendarId).trim()) return String(qs.calendarId).trim();
//  // prioridad 2: coach=Alias → mapeo .env
//  const alias = qs.coach && String(qs.coach).trim();
//  if (alias && COACH_MAP[alias]) return COACH_MAP[alias];
//  // fallback: calendario general
//  return GOOGLE_CALENDAR_ID;
// }

function resolveCalendarIdFromQuery(qs = {}) {
 // Siempre usamos el calendario del club por defecto
 // (donde Wil, Joe y Enzo tienen sus clases)
 return GOOGLE_CALENDAR_ID; 
}



// // Devuelve [{start, end}, ...] con los eventos que ocupan al coach
// async function getBusyFromEventsList(cal, {
//  calendarId, timeMin, timeMax, coachEmail, fallbackQuery
// }) {
//  const items = [];
//  let pageToken = undefined;


//  do {
//    const resp = await cal.events.list({
//      calendarId,
//      timeMin: timeMin.toISOString(),
//      timeMax: timeMax.toISOString(),
//      singleEvents: true,          // expande recurrencias
//      orderBy: 'startTime',
//      maxResults: 2500,
//      pageToken,
//    });
//    items.push(...(resp.data.items || []));
//    pageToken = resp.data.nextPageToken;
//  } while (pageToken);


//  // 1) Filtrar por “ocupado” (ignora cancelados y transparentes)
//  const candidates = items.filter(ev =>
//    ev.status !== 'cancelled' &&
//    (ev.transparency || 'opaque') !== 'transparent'
//  );


//  // 2) Mantener solo los que pertenecen al coach
//  const belongsToCoach = (ev) => {
//    // a) por attendees (ideal)
//    const att = Array.isArray(ev.attendees) ? ev.attendees : [];
//    const attHit = coachEmail
//      ? att.some(a => (a.email || '').toLowerCase() === coachEmail.toLowerCase())
//      : false;


//    if (attHit) return true;


//    // NUEVO: si el creador/organizador es el coach, cuenta como ocupado
//  const creatorEmail = (ev.creator?.email || ev.organizer?.email || '').toLowerCase();
//  if (coachEmail && creatorEmail === coachEmail.toLowerCase()) return true;




//    // b) fallback por texto (si aún no agregan attendees)
//    if (!fallbackQuery) return false;
//    const hay = (s) => (s || '').toLowerCase().includes(fallbackQuery.toLowerCase());
//    return hay(ev.summary) || hay(ev.description) || hay(ev.location);
//  };


//  const coachEvents = candidates.filter(belongsToCoach);


//  // 3) Normalizar a intervalos busy
//  const busy = coachEvents.map(ev => {
//    const start = ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
//    const end   = ev.end?.dateTime   || (ev.end?.date   ? `${ev.end.date}T00:00:00Z`   : null);
//    return (start && end) ? { start, end } : null;
//  }).filter(Boolean);


//  return busy;
// }

// async function getBusyFromEventsList(cal, {
//   calendarId, timeMin, timeMax, coachEmail, fallbackQuery
// }) {
//   const items = [];
//   let pageToken = undefined;

//   do {
//     const resp = await cal.events.list({
//       calendarId,
//       timeMin: timeMin.toISOString(),
//       timeMax: timeMax.toISOString(),
//       singleEvents: true,
//       orderBy: 'startTime',
//       maxResults: 2500,
//       pageToken,
//     });
//     items.push(...(resp.data.items || []));
//     pageToken = resp.data.nextPageToken;
//   } while (pageToken);

//   const coachEvents = items.filter(ev => {
//     // 1. Ignorar cancelados
//     if (ev.status === 'cancelled') return false;
//     // 2. Ignorar si el evento está marcado como "Disponible" (Transparency: transparent)
//     if (ev.transparency === 'transparent') return false;

//     // 3. Verificar si el coach está realmente ocupado en este evento
//     const attendees = ev.attendees || [];
//     const coachAsAttendee = attendees.find(a => 
//       (a.email || '').toLowerCase() === coachEmail.toLowerCase()
//     );

//     // Si el coach es un invitado y RECHAZÓ, está LIBRE
//     if (coachAsAttendee && coachAsAttendee.responseStatus === 'declined') return false;

//     // Si el coach es el organizador o está en la lista de aceptados/pendientes
//     const isOrganizer = (ev.organizer?.email || '').toLowerCase() === coachEmail.toLowerCase();
//     const isAttendee = !!coachAsAttendee;
    
//     // Fallback de texto (summary)
//     const matchesText = fallbackQuery && (
//       (ev.summary || '').toLowerCase().includes(fallbackQuery.toLowerCase()) ||
//       (ev.description || '').toLowerCase().includes(fallbackQuery.toLowerCase())
//     );

//     return isOrganizer || isAttendee || matchesText;
//   });

//   return coachEvents.map(ev => {
//     // Manejo correcto de fechas "All-day" para evitar desfases de zona horaria
//     const start = ev.start.dateTime || dayjs.tz(ev.start.date, TIMEZONE).startOf('day').toISOString();
//     const end = ev.end.dateTime || dayjs.tz(ev.end.date, TIMEZONE).endOf('day').toISOString();
//     return { start, end };
//   });
// }

// async function getBusyFromEventsList(cal, {
//   calendarId, timeMin, timeMax, coachEmail, fallbackQuery
// }) {
//   const items = [];
//   let pageToken = undefined;

//   do {
//     const resp = await cal.events.list({
//       calendarId,
//       timeMin: timeMin.toISOString(),
//       timeMax: timeMax.toISOString(),
//       singleEvents: true,
//       orderBy: 'startTime',
//       maxResults: 2500,
//       pageToken,
//     });
//     items.push(...(resp.data.items || []));
//     pageToken = resp.data.nextPageToken;
//   } while (pageToken);

//   console.log(items)

//   console.log(`DEBUG: Se encontraron ${items.length} eventos totales en el rango.`);

//   const coachEvents = items.filter(ev => {
//     // 1. Ignorar cancelados
//     if (ev.status === 'cancelled') return false;
    
//     // 2. Ignorar si el evento está marcado explícitamente como "Disponible"
//     if (ev.transparency === 'transparent') return false;

//     // 3. Lógica inteligente: 
//     // Si el calendario es el personal del coach (calendarId === coachEmail), 
//     // TODO lo que hay ahí lo ocupa.
//     if (calendarId.toLowerCase() === coachEmail.toLowerCase()) return true;

//     // 4. Si es un calendario compartido (ej: el del Club), ahí sí filtramos:
//     const attendees = ev.attendees || [];
//     const isAttendee = attendees.some(a => (a.email || '').toLowerCase() === coachEmail.toLowerCase());
//     const isOrganizer = (ev.organizer?.email || '').toLowerCase() === coachEmail.toLowerCase();
//     const matchesText = fallbackQuery && (
//       (ev.summary || '').toLowerCase().includes(fallbackQuery.toLowerCase()) ||
//       (ev.description || '').toLowerCase().includes(fallbackQuery.toLowerCase())
//     );

//     return isOrganizer || isAttendee || matchesText;
//   });

//   return coachEvents.map(ev => {
//     const start = ev.start.dateTime || dayjs.tz(ev.start.date, TIMEZONE).startOf('day').toISOString();
//     const end = ev.end.dateTime || dayjs.tz(ev.end.date, TIMEZONE).endOf('day').toISOString();
//     return { start, end };
//   });
// }

// async function getBusyFromEventsList(cal, {
//   calendarId, timeMin, timeMax, coachEmail, fallbackQuery
// }) {
//   const items = [];
//   let pageToken = undefined;

//   do {
//     const resp = await cal.events.list({
//       calendarId, // Ahora sí consultará enzo@... o el ID que toque
//       timeMin: timeMin.toISOString(),
//       timeMax: timeMax.toISOString(),
//       singleEvents: true,
//       orderBy: 'startTime',
//       maxResults: 2500,
//       pageToken,
//     });
//     items.push(...(resp.data.items || []));
//     pageToken = resp.data.nextPageToken;
//   } while (pageToken);

//   console.log(`DEBUG: Se encontraron ${items.length} eventos en el calendario ${calendarId}`);

//   return items
//     .filter(ev => {
//       if (ev.status === 'cancelled') return false;
//       if (ev.transparency === 'transparent') return false; // "Disponible" en Google

//       // Si el calendario que estamos viendo es el personal del coach, 
//       // bloqueamos el tiempo sin importar el título.
//       const isPersonalCalendar = calendarId.toLowerCase() === coachEmail.toLowerCase();
//       if (isPersonalCalendar) return true;

//       // Si es un calendario grupal, buscamos al coach en el título o invitados
//       const summary = (ev.summary || '').toLowerCase();
//       const matchesCoach = fallbackQuery && summary.includes(fallbackQuery.toLowerCase());
//       const isAttendee = (ev.attendees || []).some(a => a.email?.toLowerCase() === coachEmail.toLowerCase());

//       return matchesCoach || isAttendee;
//     })
//     .map(ev => ({
//       start: ev.start.dateTime || ev.start.date,
//       end: ev.end.dateTime || ev.end.date
//     }));
// }

async function getBusyFromEventsList(cal, {
  calendarId, timeMin, timeMax, coachEmail, fallbackQuery
}) {
  const items = [];
  let pageToken = undefined;

  // 1. Traer todos los eventos del calendario seleccionado
  do {
    const resp = await cal.events.list({
      calendarId, 
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500,
      pageToken,
    });
    items.push(...(resp.data.items || []));
    pageToken = resp.data.nextPageToken;
  } while (pageToken);

  console.log(`DEBUG: Analizando ${items.length} eventos en el calendario: ${calendarId}`);

  return items
    .filter(ev => {
      // A. Ignorar eventos cancelados o marcados como "Disponible"
      if (ev.status === 'cancelled') return false;
      if (ev.transparency === 'transparent') return false; 

      // B. Caso especial: Si el calendario es el PERSONAL del coach, TODO lo ocupa.
      // (Esto es lo que hacía que te funcionara a ti con Enzo)
      const isPersonalCalendar = calendarId.toLowerCase() === coachEmail.toLowerCase();
      if (isPersonalCalendar) return true;

      // C. Caso Calendario Compartido (Tropical Padel):
      // El coach está ocupado si:
      
      // 1. Es el organizador del evento
      const isOrganizer = (ev.organizer?.email || '').toLowerCase() === coachEmail.toLowerCase();
      
      // 2. Está en la lista de invitados (attendees)
      const isAttendee = (ev.attendees || []).some(a => 
        (a.email || '').toLowerCase() === coachEmail.toLowerCase() && 
        a.responseStatus !== 'declined' // Si rechazó la invitación, está libre
      );

      // 3. Su nombre aparece en el título (fallback por si no lo invitaron formalmente)
      const summary = (ev.summary || '').toLowerCase();
      const matchesText = fallbackQuery && summary.includes(fallbackQuery.toLowerCase());

      return isOrganizer || isAttendee || matchesText;
    })
    .map(ev => {
      // Normalizar fechas para evitar errores entre Argentina y México
      // Si es un evento de todo el día (sin hora), le asignamos el día completo
      const start = ev.start.dateTime || ev.start.date;
      const end = ev.end.dateTime || ev.end.date;
      return { start, end };
    });
}

function pad2(s) { return String(s || '').padStart(2, '0'); }


function parseMesDia(s) {
 if (!s) return null;
 const m = String(s).match(/(\d{1,2})\D(\d{1,2})/); // 10-7, 10/07, 10.7
 if (!m) return null;
 return { month: pad2(m[1]), day: pad2(m[2]) };
}


function parseHoraMatch(s) {
 if (!s) return null;
 const m = String(s).match(/^(\d{1,2})(?::?(\d{1,2}))?$/); // 9, 09, 9:5, 09:05
 if (!m) return null;
 const hh = pad2(m[1]);
 const mm = pad2(m[2] ?? '0');
 return { hh, mm };
}


  // /** Si no viene start ISO, arma uno con mes_dia + hora_match (+year) */
  // function coerceStartISOFromPieces(q = {}) {
  // const md = parseMesDia(q.mes_dia);
  // const hm = parseHoraMatch(q.hora_match);
  // if (!md || !hm) return null;
  // const year = String(q.year || new Date().getUTCFullYear());
  // // Mantiene el contrato actual (UTC con Z). Si preferís zona local, lo cambiamos.
  // return `${year}-${md.month}-${md.day}T${hm.hh}:${hm.mm}:00Z`;
  // }

//   function coerceStartISOFromPieces(q = {}) {
//   const md = parseMesDia(q.mes_dia);
//   const hm = parseHoraMatch(q.hora_match);
//   if (!md || !hm) return null;
//   const year = String(q.year || new Date().getUTCFullYear());
  
//   // USAR TZ en lugar de Z
//   // Esto crea un objeto dayjs en la zona horaria de México antes de convertir a ISO
//   return dayjs.tz(`${year}-${md.month}-${md.day} ${hm.hh}:${hm.mm}:00`, TIMEZONE).toISOString();
// }

// --- Mejorada: Función de construcción de fecha ---
function coerceStartISOFromPieces(q = {}) {
  const md = parseMesDia(q.mes_dia);
  const hm = parseHoraMatch(q.hora_match);
  if (!md || !hm) return null;
  const year = String(q.year || new Date().getFullYear());
  
  // Creamos la fecha directamente en la zona horaria de México
  // Formato: YYYY-MM-DD HH:mm:ss
  const localStr = `${year}-${md.month}-${md.day} ${hm.hh}:${hm.mm}:00`;
  return dayjs.tz(localStr, TIMEZONE).toISOString(); 
}



console.log('COACH_MAP =>', COACH_MAP);




app.get('/availability', async (req, res) => {
 try {
   const q = req.method === 'GET' ? req.query : req.body;


   // const startISO = q.start;
   // const endISOFromClient = q.end;
   // const durationMin = q.durationMin ? parseInt(q.durationMin, 10) : undefined;


   // if (!startISO) {
   //   return res.status(400).json({ ok: false, error: 'Falta start' });
   // }
   // if (!endISOFromClient && !Number.isFinite(durationMin)) {
   //   return res.status(400).json({ ok: false, error: 'Falta end o durationMin' });
   // }


     // NUEVO: construir start si no vino en ISO
   const startISO = q.start || coerceStartISOFromPieces(q);
   const endISOFromClient = q.end;
   const durationMin = Number.isFinite(Number(q.durationMin))
     ? Number(q.durationMin) : undefined;


   if (!startISO) {
     return res.status(400).json({ ok: false, error: 'Falta start (o mes_dia/hora_match)' });
   }
   if (!endISOFromClient && !Number.isFinite(durationMin)) {
     return res.status(400).json({ ok: false, error: 'Falta end o durationMin' });
   }


   // Si no hay end, definimos ventana por defecto (72h o lo que tengas en .env)
   let endISO = endISOFromClient;
   if (!endISO) {
     const horizonH = Number(process.env.DEFAULT_LOOKAHEAD_HOURS || 72);
     endISO = new Date(new Date(startISO).getTime() + horizonH * 3600 * 1000).toISOString();
   }


   // ⬇️ Usar SIEMPRE las variables ya resueltas (no volver a req.query)
   const timeMin = new Date(startISO);
   const timeMax = new Date(endISO);
   if (isNaN(timeMin) || isNaN(timeMax)) {
     return res.status(400).json({ ok: false, error: 'Rango de fechas inválido (start/end)' });
   }


   const gran = Number(q.granularity || 30); // minutos
  //  const calendarId = resolveCalendarIdFromQuery(q);


   const cal = calendarClient();
   // (freebusy si no pides coach específico)
   // const coachEmail = resolveCoachEmail(q);
   const coachNameForDisplay = q.coach || 'Coach';


  //  let busy;
  //  if (coachEmail) {
  //    // Camino por eventos, filtrando por coach (attendees/creator/organizer)
  //    busy = await getBusyFromEventsList(cal, {
  //      calendarId: GOOGLE_CALENDAR_ID,
  //      timeMin, timeMax,
  //      coachEmail,
  //      fallbackQuery: q.coach
  //    });
  //  } else {
    // ... dentro de app.get('/availability' ...
const calendarId = resolveCalendarIdFromQuery(q); 
const coachEmail = resolveCoachEmail(q);

let busy;
if (coachEmail) {
  // CAMBIO: Pasar 'calendarId' (la variable) no el 'GOOGLE_CALENDAR_ID' fijo
  busy = await getBusyFromEventsList(cal, {
    calendarId: calendarId, // <--- CORREGIDO
    timeMin, 
    timeMax,
    coachEmail,
    fallbackQuery: q.coach
  });
} else {  
    const fb = await cal.freebusy.query({
       requestBody: {
         timeMin: timeMin.toISOString(),
         timeMax: timeMax.toISOString(),
         timeZone: TIMEZONE,
         items: [{ id: calendarId }],
       },
     });
     busy = (fb.data.calendars?.[calendarId]?.busy || []).map(b => ({ start: b.start, end: b.end }));
   }


   // ---- Slots libres
   const freeSlots = [];
   let cursor = dayjs(timeMin);
   const end = dayjs(timeMax);


   const overlaps = (aStart, aEnd, bStart, bEnd) =>
     dayjs(aStart).isBefore(bEnd) && dayjs(aEnd).isAfter(bStart);


   // Si piden starts + durationMin, validamos que desde el start haya "durationMin" libre
   const wantsStarts = (q.mode === 'starts');
   const spanToCheckMin = Number.isFinite(durationMin) && wantsStarts ? durationMin : gran;


   const TZ = process.env.TIMEZONE || 'America/Mexico_City';


   while (cursor.add(gran, 'minute').isSameOrBefore(end)) {
     const slotStart = cursor;
     const checkEnd = cursor.add(spanToCheckMin, 'minute'); // 👈 ventana a comprobar
     // Si la ventana a comprobar se sale del horizonte, corta
     if (checkEnd.isAfter(end)) break;


     // ⛔️ Fuera de horario del club => saltar
   if (!isWithinBusinessWindow(slotStart.toISOString(), checkEnd.toISOString(), TZ)) {
     cursor = cursor.add(gran, 'minute');
     continue;
   }


     const conflict = busy.some(b =>
       overlaps(slotStart, checkEnd, dayjs(b.start), dayjs(b.end))
     );


     if (!conflict) {
       // Dejamos el output en granularidad fija; el formateador hará 'starts' o 'ranges'
       freeSlots.push({ start: slotStart.toISOString(), end: slotStart.add(gran, 'minute').toISOString() });
     }
     cursor = cursor.add(gran, 'minute');
   }


   const wantsPretty = (q.pretty === 'chat' || req.headers['x-pretty'] === 'chat');
   if (wantsPretty) {
     const text = formatAvailabilityForChat(freeSlots, {
       coachName: coachNameForDisplay,
       timeZone: TIMEZONE,
       locale: 'es',
       mode: (q.mode === 'ranges') ? 'ranges' : 'starts',
       granularityMin: gran,
       markdown: q.md === '1',
       maxDays: Number(q.maxDays || 7)
     });


     if ((req.headers.accept || '').includes('text/plain') || q.format === 'text') {
       return res.type('text/plain; charset=utf-8').send(text);
     }
     return res.json({ busy, freeSlots, timeZone: TIMEZONE, pretty: { chat: text } });
   }


   return res.json({ busy, freeSlots, timeZone: TIMEZONE });
 } catch (err) {
   console.error(err);
   res.status(500).json({ ok: false, error: err.message });
 }
});




// === Auth Google (OAuth2) centralizado y reutilizable ========================
function buildOAuthClient() {
 const oAuth2Client = new google.auth.OAuth2(
   process.env.CLIENT_ID,
   process.env.CLIENT_SECRET,
   process.env.REDIRECT_URI || undefined // opcional
 );
 oAuth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });
 // opcional: set global (todas las llamadas usan este auth)
 google.options({ auth: oAuth2Client });
 return oAuth2Client;
}
const authClient = buildOAuthClient();
const calendar = google.calendar({ version: 'v3', auth: authClient });


// === Helpers mínimos =========================================================
async function resolveCalendarId({ coach_id }) {
 // Si tienes multi-coach, haz aquí el lookup (CONFIG.coaches[coach_id].calendarId)
 return coach_id ? /* tu lookup */ process.env.GOOGLE_CALENDAR_ID : process.env.GOOGLE_CALENDAR_ID;
}


async function findEventByExternalId(_calendarId, _externalId) {
 // Implementa si quieres idempotencia real. Por ahora no-op.
 return null;
}


function mapGoogleError(err) {
 // Intenta leer status/code de la librería googleapis
 const status = err?.code || err?.response?.status || 500;
 const reason =
   err?.errors?.[0]?.reason ||
   err?.response?.data?.error?.errors?.[0]?.reason ||
   err?.response?.data?.error?.status ||
   err?.message;


 // Normaliza algunos casos frecuentes
 if (status === 401) return { status, code: 'AUTH', message: 'Login Required (401). Revisa CLIENT_ID/SECRET/REFRESH_TOKEN.' };
 if (status === 403) return { status, code: 'AUTH', message: 'Insufficient permissions (403). Verifica acceso al calendar.' };
 if (status === 409) return { status, code: 'CONFLICT', message: 'Conflict (409).' };
 if (status === 412) return { status, code: 'CONFLICT_ETAG', message: 'Etag mismatch (412).' };
 return { status, code: 'GOOGLE_API', message: reason || 'Google API error' };
}


// === Endpoint /book ==========================================================
app.post('/book', async (req, res) => {
 const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();


 try {
   const {
    start: startISO_raw,
     end: endISOFromClient,      // opcional (compat)
     durationMin,                 // recomendado: si no hay 'end', se usa esto
     timeZone,                    // opcional; usa .env si no viene
     summary = 'Clase Tropical Padel',
     description,
     attendees = [],              // [{ email, displayName }]
     sendUpdates = process.env.DEFAULT_SEND_UPDATES || 'all',
     externalId,                  // opcional: idempotencia
     coach_id,
      mes_dia,
     hora_match,
     year                     // opcional: multi-coach
   } = req.body || {};


   const TZ = timeZone || process.env.TIMEZONE || 'America/Mexico_City';


   // NUEVO: si no vino start ISO, lo armamos desde piezas
   const startISO = startISO_raw || coerceStartISOFromPieces({ mes_dia, hora_match, year });
   if (!startISO) {
     return res.status(400).json({
       ok: false, data: null,
       error: { code: 'VALIDATION', message: 'start es requerido (o mes_dia/hora_match)' },
       meta: { correlationId, ts: new Date().toISOString() }
     });
   }


   // Validaciones
   if (!startISO) {
     return res.status(400).json({
       ok: false,
       data: null,
       error: { code: 'VALIDATION', message: 'start es requerido' },
       meta: { correlationId, ts: new Date().toISOString() }
     });
   }


   const start = dayjs.utc(startISO);
   if (!start.isValid()) {
     return res.status(400).json({
       ok: false,
       data: null,
       error: { code: 'VALIDATION', message: 'start inválido (ISO 8601 con Z, ej: 2025-10-10T18:00:00Z)' },
       meta: { correlationId, ts: new Date().toISOString() }
     });
   }


   // Si no recibimos 'end', lo calculamos con durationMin (default 60)
   const dur = Number.isFinite(Number(durationMin)) ? Number(durationMin) : 60;
   let endISO = endISOFromClient || start.add(dur, 'minute').toISOString();


   const end = dayjs.utc(endISO);
   if (!end.isValid() || !end.isAfter(start)) {
     return res.status(400).json({
       ok: false,
       data: null,
       error: { code: 'VALIDATION', message: 'end inválido o no posterior a start' },
       meta: { correlationId, ts: new Date().toISOString() }
     });
   }


   // ⛔️ Regla de negocio: solo permitir turnos dentro del horario del club.
 if (!isWithinBusinessWindow(start.toISOString(), end.toISOString(), TZ)) {
   return res.status(400).json({
     ok: false,
     data: null,
     error: {
       code: 'OUT_OF_BUSINESS_HOURS',
       message: 'El club atiende L–V 07:00–22:30 y S–D 08:00–14:00 (hora de Puerto Vallarta). Elige un horario dentro de esa ventana.'
     },
     meta: { correlationId, ts: new Date().toISOString() }
   });
 }


   // Calendar destino
   const calendarId = await resolveCalendarId({ coach_id });


   // Evento para Google
   const requestBody = {
     summary,
     description,
     start: { dateTime: start.toISOString(), timeZone: TZ },
     end:   { dateTime: end.toISOString(),   timeZone: TZ },
     attendees,
     extendedProperties: {
       private: { externalId: externalId || `tp-${crypto.randomUUID()}` }
     }
   };


   // Idempotencia básica (opcional)
   const maybeExisting = await findEventByExternalId(calendarId, requestBody.extendedProperties.private.externalId);
   if (maybeExisting) {
     return res.status(200).json({
       ok: true,
       data: { event: maybeExisting, idempotent: true },
       error: null,
       meta: { correlationId, ts: new Date().toISOString() }
     });
   }


   // Inserción con cliente autenticado
   const inserted = await calendar.events.insert({
     calendarId,
     sendUpdates,           // 'all' | 'externalOnly' | 'none'
     requestBody
   });


   return res.status(201).json({
     ok: true,
     data: { event: inserted.data },
     error: null,
     meta: { correlationId, ts: new Date().toISOString() }
   });


 } catch (err) {
   const mapped = mapGoogleError(err);
   // Log estructurado
   console.error(JSON.stringify({
     level: 'error',
     where: 'POST /book',
     correlationId,
     mapped,
     raw: { message: err?.message, stack: err?.stack }
   }));
   return res.status(mapped.status).json({
     ok: false,
     data: null,
     error: { code: mapped.code, message: mapped.message },
     meta: { correlationId, ts: new Date().toISOString() }
   });
 }
});


app.patch('/events/:id', async (req, res) => {
 try {
   if (!GOOGLE_CALENDAR_ID) throw new Error('Falta GOOGLE_CALENDAR_ID');
   const { id } = req.params;
   const {
     calendarId = GOOGLE_CALENDAR_ID,
     sendUpdates = DEFAULT_SEND_UPDATES,
     etag,
     ...partial // summary, description, location, start, end, attendees, reminders, conferenceData...
   } = req.body;


   const cal = calendarClient();


   const params = {
     calendarId,
     eventId: id,
     sendUpdates,
     requestBody: partial
   };


   // En googleapis podés pasar headers en el 2º argumento (options)
   const options = etag ? { headers: { 'If-Match': etag } } : {};


   const { data } = await cal.events.patch(params, options);
   // Docs: events.patch (patch semantics) + scopes; If-Match/ETag para modificación condicional. :contentReference[oaicite:3]{index=3}


   res.json({ ok: true, event: data });
 } catch (err) {
   // Si el ETag no coincide, la API puede responder 412 Precondition Failed.
   console.error(err);
   const code = err.code || err.status || 400;
   res.status(code).json({ ok: false, error: err.message });
 }
});


/**
* DELETE /events/:id
* Query:
*  - calendarId?=...
*  - sendUpdates?=all|externalOnly|none
*  - etag?="..."
*/
app.delete('/events/:id', async (req, res) => {
 try {
   if (!GOOGLE_CALENDAR_ID) throw new Error('Falta GOOGLE_CALENDAR_ID');
   const { id } = req.params;
   const {
     calendarId = GOOGLE_CALENDAR_ID,
     sendUpdates = DEFAULT_SEND_UPDATES,
     etag
   } = req.query;


   const cal = calendarClient();
   const params = {
     calendarId,
     eventId: id,
     sendUpdates
   };
   const options = etag ? { headers: { 'If-Match': etag } } : {};


   await cal.events.delete(params, options);
   // Docs: events.delete (acepta sendUpdates; cuerpo vacío si ok). Condicional con If-Match recomendado. :contentReference[oaicite:4]{index=4}


   res.json({ ok: true, deleted: id });
 } catch (err) {
   console.error(err);
   const code = err.code || err.status || 400;
   res.status(code).json({ ok: false, error: err.message });
 }
});


/**
* GET /calendars
* Dev helper: lista calendarios visibles para la identidad autenticada
*/
app.get('/calendars', async (_req, res) => {
 try {
   const cal = calendarClient();
   const r = await cal.calendarList.list();
   res.json(r.data.items?.map(c => ({
     id: c.id, summary: c.summary, primary: c.primary, timeZone: c.timeZone
   })) || []);
 } catch (err) {
   res.status(500).json({ ok: false, error: err.message });
 }
});


// === AUTH ===
// Reusar app de arriba o crear nueva instancia


const REDIRECT_URI = 'http://localhost:3000/oauth2callback'; // Debe ser EXACTO al de GCP
const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);


// 1) Pide URL de consentimiento
app.get('/auth/url', (req, res) => {
 const url = oauth2.generateAuthUrl({
   access_type: 'offline',      // <- NECESARIO para refresh_token
   prompt: 'consent',           // <- fuerza mostrar consentimiento y entregar refresh
   scope: ['https://www.googleapis.com/auth/calendar'],
   include_granted_scopes: true
 });
 res.send(`<a href="${url}">Autorizar con Google</a><br/><small>${url}</small>`);
});


// 2) Recibe el code y canjea por tokens (acá aparece el refresh_token)
app.get('/oauth2callback', async (req, res) => {
 try {
   const { code } = req.query;
   const { tokens } = await oauth2.getToken(code);
   // tokens = { access_token, refresh_token, scope, token_type, expiry_date }
   console.log('TOKENS =>', tokens);
   res.setHeader('Content-Type', 'text/plain');
   res.end(`Copiá tu REFRESH_TOKEN y pegalo en .env:\n\n${JSON.stringify(tokens, null, 2)}\n`);
 } catch (e) {
   console.error(e);
   res.status(500).send(e.message);
 }
});




/**
* GET /health
* Verifica acceso a Calendar y estado del token
*/
app.get('/health', async (_req, res) => {
 try {
   if (!GOOGLE_CALENDAR_ID) throw new Error('Falta GOOGLE_CALENDAR_ID');
   const auth = getAuth();
   const cal = google.calendar({ version: 'v3', auth });
   const { data } = await cal.calendars.get({ calendarId: GOOGLE_CALENDAR_ID });


   let tokenInfo = null;
   if (auth && typeof auth.getAccessToken === 'function') {
     try {
       const token = await auth.getAccessToken();
       tokenInfo = {
         has_access_token: Boolean(token && token.token),
         expiry_date: auth.credentials?.expiry_date || null
       };
     } catch {
       tokenInfo = { has_access_token: false };
     }
   }


   res.json({
     ok: true,
     calendarId: GOOGLE_CALENDAR_ID,
     calendarSummary: data.summary,
     timeZone: data.timeZone,
     token: tokenInfo
   });
 } catch (err) {
   console.error(err);
   res.status(500).json({ ok: false, error: err.message });
 }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Middleware listo en :${PORT}`));



