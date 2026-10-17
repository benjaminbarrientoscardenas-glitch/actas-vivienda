/*
  Recordatorios automáticos de rendiciones · Puduhue Terreno (v84)
  -----------------------------------------------------------------
  La app le deja al servidor una "agenda" con lo pendiente cada vez que alguien sincroniza o hace
  una acción (no hace falta que el servidor lea OneDrive). El servidor revisa la agenda una vez al
  día, en días hábiles a las 9:00 de Santiago, y manda las notificaciones:
    - Jefatura: rendiciones que esperan su aprobación hace 3 días o más.
    - Contabilidad: rendiciones en revisión contable hace 3 días o más.
    - Cada persona: rendición devuelta sin corregir hace 3 días o más; rendición del mes sin enviar
      en los últimos 3 días hábiles del mes; rendiciones de meses anteriores sin enviar en los
      primeros 3 días hábiles del mes y cada lunes.
  Una sola notificación por persona y tipo (si hay varias pendientes, van juntas).
*/
export const HORA_RECORDATORIOS = 9;
export const DIAS_ESPERA = 3;
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/* fecha y hora en Santiago (con horario de verano incluido) */
export function santiago(t = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(t).map(x => [x.type, x.value]));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { fecha: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, hora: +p.hour, dow, periodo: `${p.year}-${p.month}` };
}
const dowDe = (y, m, d) => { const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; };
const habil = (y, m, d) => dowDe(y, m, d) <= 5;
function habilesDelMes(y, m) { const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); const L = []; for (let d = 1; d <= n; d++) if (habil(y, m, d)) L.push(d); return L; }
export const mesTxt = periodo => { const [y, m] = String(periodo).split("-").map(Number); return m ? `${MESES[m - 1]} de ${y}` : String(periodo); };
const dias = (desde, ahora) => { const t = Date.parse(desde); return isNaN(t) ? 0 : Math.floor((ahora - t) / 864e5); };
const haceTxt = n => n === 1 ? "hace 1 día" : `hace ${n} días`;
const listaNombres = (L, max = 2) => L.length <= max ? (L.length === 2 ? `${L[0]} y ${L[1]}` : L[0]) : `${L.slice(0, max).join(", ")} y ${L.length - max} más`;
const docsTxt = (n, total) => `${n} ${n === 1 ? "documento" : "documentos"}${total ? ` (${total})` : ""}`;

/* limpia lo que manda la app: solo correos de la empresa y textos acotados */
export function validarAgenda(b, dominio) {
  const corr = L => [...new Set((Array.isArray(L) ? L : []).map(x => String(x || "").trim().toLowerCase()).filter(x => x.endsWith(dominio)))].slice(0, 6);
  const txt = (x, n) => String(x == null ? "" : x).slice(0, n);
  const fecha = x => { const s = txt(x, 40); return isNaN(Date.parse(s)) ? "" : s; };
  const aprobar = (Array.isArray(b.aprobar) ? b.aprobar : []).slice(0, 400).map(x => ({ para: corr(x.para), rid: txt(x.rid, 40), rol: x.rol === "cont" ? "cont" : "jef", persona: txt(x.persona, 80), periodo: txt(x.periodo, 7), total: txt(x.total, 20), desde: fecha(x.desde) })).filter(x => x.para.length && x.rid && x.desde);
  const enviar = (Array.isArray(b.enviar) ? b.enviar : []).slice(0, 600).map(x => ({ para: corr(x.para), rid: txt(x.rid, 40), estado: x.estado === "observada" ? "observada" : "borrador", persona: txt(x.persona, 80), periodo: txt(x.periodo, 7), docs: Math.max(0, Math.min(999, +x.docs || 0)), total: txt(x.total, 20), desde: fecha(x.desde) })).filter(x => x.para.length && x.rid && /^\d{4}-\d{2}$/.test(x.periodo));
  return { generado: new Date().toISOString(), aprobar, enviar };
}

/* qué notificaciones corresponden hoy */
export function armarRecordatorios(agenda, ahora = new Date()) {
  const s = santiago(ahora), out = [];
  if (!agenda || s.dow > 5) return { hoy: s, notificaciones: out };
  const t = ahora.getTime();
  /* 1) aprobaciones atrasadas, por persona y rol */
  const porRol = {};
  for (const x of agenda.aprobar || []) {
    const n = dias(x.desde, t); if (n < DIAS_ESPERA) continue;
    for (const c of x.para) { const k = c + "|" + x.rol; (porRol[k] = porRol[k] || { para: c, rol: x.rol, L: [] }).L.push({ ...x, n }); }
  }
  for (const g of Object.values(porRol)) {
    const L = g.L.sort((a, b) => b.n - a.n), cont = g.rol === "cont";
    if (L.length === 1) {
      const x = L[0];
      out.push({ para: g.para, tipo: g.rol, titulo: cont ? "Rendición esperando revisión contable" : "Rendición esperando tu aprobación", texto: `${x.persona} · ${mesTxt(x.periodo).replace(/^./, c => c.toUpperCase())}${x.total ? " · " + x.total : ""} · ${cont ? "espera" : "enviada"} ${haceTxt(x.n)}.`, url: `./?rd=${encodeURIComponent(x.rid)}`, etiqueta: "rec-" + g.rol });
    } else {
      out.push({ para: g.para, tipo: g.rol, titulo: cont ? `${L.length} rendiciones esperando revisión contable` : `${L.length} rendiciones esperando tu aprobación`, texto: `Esperan ${DIAS_ESPERA} días o más: ${listaNombres(L.map(x => `${x.persona} (${x.n} días)`))}.`, url: `./?rdtab=${g.rol}`, etiqueta: "rec-" + g.rol });
    }
  }
  /* 2) lo propio: devueltas sin corregir y rendiciones sin enviar */
  const hab = habilesDelMes(s.y, s.m), pos = hab.indexOf(s.d), quedan = pos < 0 ? -1 : hab.length - pos; /* días hábiles que quedan, contando hoy */
  const finDeMes = quedan >= 1 && quedan <= 3, inicioDeMes = pos >= 0 && pos < 3, lunes = s.dow === 1;
  const porPersona = {};
  for (const x of agenda.enviar || []) {
    let motivo = null;
    if (x.estado === "observada") { const n = dias(x.desde, t); if (n >= DIAS_ESPERA) motivo = { k: "dev", n }; }
    else if (x.docs > 0 && x.periodo === s.periodo && finDeMes) motivo = { k: "fin" };
    else if (x.docs > 0 && x.periodo < s.periodo && (inicioDeMes || lunes)) motivo = { k: "ant" };
    if (!motivo) continue;
    for (const c of x.para) (porPersona[c] = porPersona[c] || []).push({ ...x, motivo });
  }
  for (const [c, L] of Object.entries(porPersona)) {
    if (L.length === 1) {
      const x = L[0], mes = mesTxt(x.periodo);
      if (x.motivo.k === "dev") out.push({ para: c, tipo: "propia", titulo: "Tu rendición devuelta sigue pendiente", texto: `La rendición de ${mes} espera tu corrección ${haceTxt(x.motivo.n)}. Revisa las observaciones y vuelve a enviarla.`, url: `./?rd=${encodeURIComponent(x.rid)}`, etiqueta: "rec-propia" });
      else if (x.motivo.k === "fin") out.push({ para: c, tipo: "propia", titulo: quedan === 1 ? `Hoy cierra ${mes}` : `Quedan ${quedan} días hábiles para cerrar ${mes}`, texto: `Tu rendición tiene ${docsTxt(x.docs, x.total)} sin enviar.${quedan === 1 ? " Envíala hoy." : " Envíala a tiempo."}`, url: `./?rd=${encodeURIComponent(x.rid)}`, etiqueta: "rec-propia" });
      else out.push({ para: c, tipo: "propia", titulo: `Rendición de ${mes} sin enviar`, texto: `Tiene ${docsTxt(x.docs, x.total)}. Envíala para que Contabilidad pueda cerrar ese mes.`, url: `./?rd=${encodeURIComponent(x.rid)}`, etiqueta: "rec-propia" });
    } else {
      const dev = L.filter(x => x.motivo.k === "dev").length;
      out.push({ para: c, tipo: "propia", titulo: `Tienes ${L.length} rendiciones pendientes`, texto: [dev ? `${dev} ${dev === 1 ? "devuelta" : "devueltas"} por corregir` : "", L.length - dev ? `${L.length - dev} sin enviar` : ""].filter(Boolean).join(" y ") + ". Ábrelas para enviarlas.", url: "./?rdtab=mias", etiqueta: "rec-propia" });
    }
  }
  return { hoy: s, notificaciones: out };
}
