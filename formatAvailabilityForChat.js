formatAvailabilityForChat.js
const dayjs = require('dayjs');
require('dayjs/locale/es');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');


dayjs.extend(utc);
dayjs.extend(timezone);


function capitalize(s) {
 return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}


/**
* freeSlots: [{ start: ISOstring, end: ISOstring }, ...]
* options: {
*   coachName: 'Coach Enzo',
*   locale: 'es',
*   timeZone: 'America/Mexico_City',
*   mode: 'starts' | 'ranges',
*   granularityMin: 30,
*   maxDays: 7,
*   markdown: false,
*   emptyLabel: 'sin horarios disponibles',
*   headerEmoji: '🗓',
*   dayFormat: 'dddd DD/MM',
*   timeFormat: 'H:mm'
* }
*/
function formatAvailabilityForChat(
 freeSlots = [],
 options = {}
) {
 const {
   coachName = 'Coach',
   locale = 'es',
   timeZone = 'America/Mexico_City',
   mode = 'starts',
   granularityMin = 30,
   maxDays = 7,
   markdown = false,
   emptyLabel = 'sin horarios disponibles',
   headerEmoji = '🗓',
   dayFormat = 'dddd DD/MM',
   timeFormat = 'H:mm'
 } = options;


 dayjs.locale(locale);


 const title = markdown
   ? `**${headerEmoji} Disponibilidad de ${coachName}:**`
   : `${headerEmoji} Disponibilidad de ${coachName}:`;


 if (!Array.isArray(freeSlots) || freeSlots.length === 0) {
   return `${title}\n• ${emptyLabel}`;
 }


 // Agrupar por día local
 const byDay = new Map();
 for (const s of freeSlots) {
   const start = dayjs.utc(s.start).tz(timeZone);
   const end = dayjs.utc(s.end).tz(timeZone);
   const key = start.format('YYYY-MM-DD');
   const arr = byDay.get(key) || [];
   arr.push({ start: start.toISOString(), end: end.toISOString() });
   byDay.set(key, arr);
 }


 // Ordenar días y limitar
 const days = Array.from(byDay.entries())
   .sort(([a], [b]) => (a < b ? -1 : 1))
   .slice(0, maxDays);


 const lines = [title];


 for (const [isoDate, slots] of days) {
   const ordered = slots
     .map(r => ({ s: dayjs(r.start), e: dayjs(r.end) }))
     .sort((a, b) => a.s.valueOf() - b.s.valueOf());


   let displayPieces = [];


   if (mode === 'ranges') {
     // Unir bloques contiguos (mismo fin-inicio o separados exactamente por granularityMin)
     const merged = [];
     for (const blk of ordered) {
       const last = merged[merged.length - 1];
       if (!last) {
         merged.push({ s: blk.s, e: blk.e });
       } else {
         const gapMin = blk.s.diff(last.e, 'minute');
         if (gapMin === 0 || gapMin === granularityMin) {
           last.e = blk.e;
         } else {
           merged.push({ s: blk.s, e: blk.e });
         }
       }
     }
     displayPieces = merged.map(r => {
       const s = r.s.tz(timeZone).format(timeFormat);
       const e = r.e.tz(timeZone).format(timeFormat);
       return `${s}–${e}`;
     });
   } else {
     // "starts": solo los inicios
     displayPieces = ordered.map(r => r.s.tz(timeZone).format(timeFormat));
   }


   const dayLabel = dayjs.tz(isoDate, timeZone).format(dayFormat);
   const line = displayPieces.length
     ? `• ${capitalize(dayLabel)} — ${displayPieces.join(', ')}`
     : `• ${capitalize(dayLabel)} — ${emptyLabel}`;
   lines.push(line);
 }


 return lines.join('\n');
}


module.exports = { formatAvailabilityForChat };



