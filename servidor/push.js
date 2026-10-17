/*
  Notificaciones en el teléfono (Web Push) · Puduhue Terreno
  ----------------------------------------------------------
  - Cada teléfono o computador que activa las notificaciones queda registrado aquí, asociado al correo
    de la cuenta Microsoft con que se usa la app (máximo 8 equipos por correo).
  - Los registros y las claves de envío (VAPID) se guardan en un Durable Object (almacenamiento del propio
    servidor en Cloudflare). Las claves se crean solas la primera vez; no hay que configurar nada.
  - El contenido de cada notificación va cifrado de punta a punta (RFC 8291, aes128gcm): el servicio de
    notificaciones de Google, Apple o Mozilla solo lo transporta.
*/
import { DurableObject } from "cloudflare:workers";
import { santiago, armarRecordatorios, validarAgenda, HORA_RECORDATORIOS } from "./recordatorios.js";

const te = new TextEncoder();
const b64u = {
  enc(buf) { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { str = String(str || "").replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; const s = atob(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
};
const unir = (...xs) => { const o = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
async function hkdf(salt, ikm, info, largo) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, largo * 8));
}

/* Cifrado del contenido para un equipo suscrito (RFC 8291 + RFC 8188, un solo registro) */
export async function cifrar(sub, texto) {
  const ua = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  if (ua.length !== 65 || auth.length !== 16) throw new Error("suscripción con claves inválidas");
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, unir(te.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, unir(te.encode(texto), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return unir(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/* Firma VAPID: identifica a este servidor ante el servicio de notificaciones */
export async function firmaVapid(claves, endpoint, sujeto) {
  const h = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujeto })));
  const k = await crypto.subtle.importKey("jwk", claves.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, te.encode(h + "." + p));
  return `vapid t=${h}.${p}.${b64u.enc(s)}, k=${claves.publica}`;
}

export async function enviarUno(claves, sub, datos, sujeto) {
  const body = await cifrar(sub, JSON.stringify(datos));
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: { Authorization: await firmaVapid(claves, sub.endpoint, sujeto), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "172800", Urgency: "normal" } });
  let detalle = ""; if (!r.ok) { try { detalle = (await r.text()).slice(0, 200); } catch (e) {} }
  return { estado: r.status, detalle };
}

const MAX_EQUIPOS = 8;
const okEndpoint = u => { try { const x = new URL(u); return x.protocol === "https:"; } catch (e) { return false; } };

/* Almacenamiento: un solo objeto para toda la empresa (el volumen es bajo) */
export class Avisos extends DurableObject {
  async claves() {
    let c = await this.ctx.storage.get("vapid");
    if (!c) {
      const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      c = { privada: await crypto.subtle.exportKey("jwk", k.privateKey), publica: b64u.enc(await crypto.subtle.exportKey("raw", k.publicKey)), creada: new Date().toISOString() };
      await this.ctx.storage.put("vapid", c);
    }
    return c;
  }
  async clavePublica() { return (await this.claves()).publica; }
  async equipos(correo) { return (await this.ctx.storage.get("s:" + correo)) || []; }
  async suscribir(correo, sub, equipo) {
    const l = (await this.equipos(correo)).filter(x => x.endpoint !== sub.endpoint);
    l.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, equipo: String(equipo || "").slice(0, 80), desde: new Date().toISOString() });
    while (l.length > MAX_EQUIPOS) l.shift();
    await this.ctx.storage.put("s:" + correo, l);
    return l.length;
  }
  async quitar(correo, endpoint) {
    const l = (await this.equipos(correo)).filter(x => x.endpoint !== endpoint);
    if (l.length) await this.ctx.storage.put("s:" + correo, l); else await this.ctx.storage.delete("s:" + correo);
    return l.length;
  }
  async enviar(correos, datos, sujeto) {
    const c = await this.claves(); const res = { enviadas: 0, sinEquipos: [], fallas: [] };
    for (const correo of correos) {
      const l = await this.equipos(correo); if (!l.length) { res.sinEquipos.push(correo); continue; }
      const quedan = [];
      for (const s of l) {
        let r; try { r = await enviarUno(c, s, datos, sujeto); } catch (e) { r = { estado: 0, detalle: String(e && e.message || e) }; }
        if (r.estado === 404 || r.estado === 410) continue;           // el equipo ya no existe: se borra
        quedan.push(s);
        if (r.estado >= 200 && r.estado < 300) res.enviadas++; else res.fallas.push({ correo, estado: r.estado, detalle: r.detalle });
      }
      if (quedan.length !== l.length) { if (quedan.length) await this.ctx.storage.put("s:" + correo, quedan); else await this.ctx.storage.delete("s:" + correo); }
    }
    return res;
  }
  /* v84: agenda de pendientes que deja la app y recordatorios diarios */
  async guardarAgenda(ag) { await this.ctx.storage.put("agenda", ag); return { aprobar: ag.aprobar.length, enviar: ag.enviar.length }; }
  async leerAgenda() { return (await this.ctx.storage.get("agenda")) || null; }
  async estadoRec() { const a = await this.leerAgenda(); return { agenda: a ? a.generado : null, ultimo: (await this.ctx.storage.get("rec:ultimo")) || null }; }
  async correrRecordatorios(sujeto, cuando, forzar) {
    const ahora = new Date(cuando || Date.now()), s = santiago(ahora);
    if (!forzar) {
      if (s.hora !== HORA_RECORDATORIOS) return { omitido: "fuera de horario" };
      const u = await this.ctx.storage.get("rec:ultimo"); if (u && u.fecha === s.fecha) return { omitido: "ya se enviaron hoy" };
    }
    const ag = await this.leerAgenda(); let res;
    if (!ag) res = { fecha: s.fecha, nota: "todavía no hay agenda" };
    else if (Date.now() - Date.parse(ag.generado) > 7 * 864e5) res = { fecha: s.fecha, nota: "agenda de hace más de 7 días: no se envió nada" };
    else {
      const { notificaciones } = armarRecordatorios(ag, ahora); let enviadas = 0, sinEquipos = 0;
      for (const n of notificaciones) { const r = await this.enviar([n.para], { titulo: n.titulo, texto: n.texto, url: n.url, etiqueta: n.etiqueta }, sujeto); enviadas += r.enviadas; sinEquipos += r.sinEquipos.length; }
      res = { fecha: s.fecha, notificaciones: notificaciones.length, enviadas, sinEquipos };
    }
    res.hora = new Date().toISOString(); await this.ctx.storage.put("rec:ultimo", res); return res;
  }
  /* lo que saldría el próximo día hábil a las 9:00 (hoy, si todavía no es esa hora) */
  async proximos() {
    const ag = await this.leerAgenda(); let t = Date.now();
    for (let k = 0; k < 8; k++) { const s = santiago(new Date(t)); if (s.dow <= 5 && (k > 0 || s.hora <= HORA_RECORDATORIOS)) break; t += 864e5; }
    const r = armarRecordatorios(ag, new Date(t));
    return { agenda: ag ? { generado: ag.generado, aprobar: ag.aprobar.length, enviar: ag.enviar.length } : null, fecha: r.hoy.fecha, notificaciones: r.notificaciones };
  }
}
export const sujetoDe = () => "https://puduhue.github.io/puduhue-terreno/"; /* contacto que ven los servicios de notificaciones */
export const objetoAvisos = env => env.AVISOS.get(env.AVISOS.idFromName("puduhue"));

/* Rutas /push/... (la sesión Microsoft ya fue verificada: llega el correo de quien pide) */
export async function rutasPush(req, env, url, correo, json, admin) {
  if (!url.pathname.startsWith("/push/")) return null;
  if (!env.AVISOS) return json({ error: "Las notificaciones no están configuradas en el servidor." }, 500);
  const obj = objetoAvisos(env);
  const dominio = "@" + (env.DOMINIO || "puduhue.cl").toLowerCase();
  const sujeto = sujetoDe(env);
  const cuerpo = async () => { try { return await req.json(); } catch (e) { return null; } };
  const p = url.pathname.slice(6);
  if (p === "clave") return json({ ok: true, clave: await obj.clavePublica() });
  if (p === "recordatorios" && req.method === "GET") { if (!admin) return json({ error: "Solo el administrador de la app." }, 403); return json({ ok: true, estado: await obj.estadoRec(), proximos: await obj.proximos() }); }
  if (p === "estado") return json({ ok: true, equipos: (await obj.equipos(correo)).map(x => ({ equipo: x.equipo, desde: x.desde, endpoint: x.endpoint })) });
  if (req.method !== "POST") return json({ error: "Método no permitido." }, 405);
  const b = await cuerpo(); if (!b) return json({ error: "Cuerpo inválido." }, 400);
  if (p === "suscribir") {
    const s = b.suscripcion || {};
    if (!okEndpoint(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "Suscripción inválida." }, 400);
    return json({ ok: true, equipos: await obj.suscribir(correo, s, b.equipo) });
  }
  if (p === "agenda") return json({ ok: true, ...(await obj.guardarAgenda(validarAgenda(b, dominio))) });
  if (p === "recordatorios") {
    if (!admin) return json({ error: "Solo el administrador de la app." }, 403);
    const pr = await obj.proximos(); let enviadas = 0;
    for (const n of pr.notificaciones.slice(0, 6)) { const r = await obj.enviar([correo], { titulo: "Prueba · " + n.titulo, texto: n.texto, url: n.url, etiqueta: "prueba-" + n.etiqueta + "-" + enviadas }, sujeto); enviadas += r.enviadas; }
    return json({ ok: true, fecha: pr.fecha, notificaciones: pr.notificaciones.length, enviadas });
  }
  if (p === "quitar") return json({ ok: true, equipos: await obj.quitar(correo, String(b.endpoint || "")) });
  if (p === "prueba") {
    const r = await obj.enviar([correo], { titulo: "Notificaciones activadas", texto: "Así te avisará Puduhue Terreno cuando tengas algo por revisar.", url: "./", etiqueta: "prueba" }, sujeto);
    return json({ ok: true, ...r });
  }
  if (p === "enviar") {
    const para = [...new Set((Array.isArray(b.para) ? b.para : []).map(x => String(x || "").trim().toLowerCase()).filter(x => x.endsWith(dominio)))].slice(0, 15);
    if (!para.length) return json({ ok: true, enviadas: 0, sinEquipos: [], fallas: [] });
    const titulo = String(b.titulo || "").slice(0, 80), texto = String(b.texto || "").slice(0, 240);
    if (!titulo) return json({ error: "Falta el título." }, 400);
    const u = String(b.url || "./"); const destino = /^\.\/(\?[\w=&%.-]*)?$/.test(u) ? u : "./";
    const r = await obj.enviar(para, { titulo, texto, url: destino, etiqueta: String(b.etiqueta || "").slice(0, 60), de: correo }, sujeto);
    return json({ ok: true, ...r });
  }
  return json({ error: "Ruta no encontrada." }, 404);
}
