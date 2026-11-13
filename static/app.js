/* =====================================================================
   Sistema de Control de Comercialización de la Hoja de Coca  (versión 3)
   Interfaz en JavaScript puro, una sola página con rutas por hash (#/)
   Los permisos se validan en el servidor; aquí solo se adapta el menú.
   ===================================================================== */
'use strict';

let CONFIG = null;
let SESION = null;
let ULTIMO_ID = {};
const $app = document.getElementById('app');
const MOVIMIENTO = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ROLES_PANEL = ['admin', 'operador', 'supervisor'];
const ROLES_REGISTRO = ['admin', 'operador'];

/* ------------------------------------------------------------------ íconos */
const HOJA = (cls, estilo) => '<svg class="' + (cls || '') + '" viewBox="0 0 60 110"' + (estilo ? ' style="' + estilo + '"' : '') + ' aria-hidden="true"><use href="#hoja-coca"/></svg>';
const ICO = {
  entrada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
  venta: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9.5c-.5-1-1.6-1.5-3-1.5-1.7 0-3 .8-3 2s1.3 1.7 3 2 3 .8 3 2-1.3 2-3 2c-1.4 0-2.6-.6-3-1.6M12 6v2M12 16v2"/></svg>',
  camion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>',
  precio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  almacen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-5 9 5v11H3z"/><path d="M8 20v-6h8v6"/></svg>',
  buscar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  usuario: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>',
  candado: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3M21 14v7h-7"/></svg>',
  escudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
};

/* ------------------------------------------------------------------ formato */
function fmtNum(n, dec) {
  n = Number(n) || 0;
  const neg = n < 0;
  const s = Math.abs(n).toFixed(dec === undefined ? 2 : dec);
  let [ent, frac] = s.split('.');
  ent = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + ent + (frac ? ',' + frac : '');
}
const tieneDec = n => Math.abs((Number(n) || 0) % 1) > 0.001;
const fmtLb = n => fmtNum(n, tieneDec(n) ? 1 : 0) + ' lb';
const fmtBs = n => 'Bs ' + fmtNum(n, 2);
const fmtPct = n => fmtNum(n, 1) + ' %';
const fmtTq = n => fmtNum(n, tieneDec(n) ? 1 : 0);
const FORMATOS = { lb: fmtLb, bs: fmtBs, n: v => fmtNum(v, 0), tq: fmtTq, pct: fmtPct };
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const fmtFecha = iso => { if (!iso) return ''; const [a, m, d] = iso.slice(0, 10).split('-'); return d + '/' + m + '/' + a; };
const fmtFH = s => s ? fmtFecha(s) + ' ' + s.slice(11, 16) : '';
const fmtFechaCorta = iso => { const [, m, d] = iso.split('-'); return d + '/' + m; };
const fmtFechaLarga = iso => { const [a, m, d] = iso.slice(0, 10).split('-'); return Number(d) + ' de ' + MESES[Number(m) - 1] + ' de ' + a; };
const fmtMes = ym => { const [a, m] = ym.split('-'); return MESES[Number(m) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + a; };
const mayus = s => String(s || '').replace(/^./, c => c.toUpperCase());
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const isoLocal = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hoyISO = () => isoLocal(new Date());
function qsString(obj) {
  const p = new URLSearchParams();
  Object.keys(obj).forEach(k => { if (obj[k] !== '' && obj[k] !== undefined && obj[k] !== null) p.set(k, obj[k]); });
  const s = p.toString();
  return s ? '?' + s : '';
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const opciones = (lista, sel, vacio) => (vacio !== undefined ? '<option value="">' + esc(vacio) + '</option>' : '') +
  lista.map(v => '<option' + (v === sel ? ' selected' : '') + '>' + esc(v) + '</option>').join('');
const iniciales = n => (n || '?').split(/\s+/).filter(Boolean).filter(p => !p.endsWith('.')).slice(0, 2).map(p => p[0].toUpperCase()).join('');
const espera = ms => new Promise(r => setTimeout(r, ms));
const calNombre = c => (CONFIG && CONFIG.calidades[String(c)]) || '—';
const calChip = c => '<span class="cal c' + (c || 2) + '">' + esc(calNombre(c)) + '</span>';
const estadoChip = e => '<span class="estado ' + e + '">' + e + '</span>';
const mercadoCorto = m => String(m || '').split(' (')[0];
const claveAleatoria = () => 'Coca' + Math.random().toString(36).slice(2, 7) + Math.floor(Math.random() * 90 + 10);
const leerLocal = (k, def) => { try { return localStorage.getItem(k) || def; } catch (e) { return def; } };
const guardarLocal = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
const leerSesion = (k, def) => { try { return sessionStorage.getItem(k) || def; } catch (e) { return def; } };
const guardarSesion = (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) { /* nada */ } };

/* ------------------------------------------------------------------ API */
let pendientes = 0;
const $prog = document.getElementById('progreso');
function progreso(delta) {
  pendientes = Math.max(0, pendientes + delta);
  if (pendientes > 0) { $prog.className = 'progreso'; void $prog.offsetWidth; $prog.className = 'progreso activo'; }
  else { $prog.className = 'progreso fin'; }
}
async function api(ruta, datos) {
  const opts = { credentials: 'same-origin' };
  if (datos) Object.assign(opts, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
  progreso(1);
  let r;
  try { r = await fetch(ruta, opts); }
  catch (e) { throw { errores: ['No se pudo conectar con el servidor. Revise su conexión e intente de nuevo.'] }; }
  finally { progreso(-1); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* sin JSON */ }
  if (r.status === 401 && ruta !== '/api/login') {
    const volver = location.hash.replace(/^#\/?/, '');
    SESION = null;
    if (j && j.motivo === 'inactividad') toast('aviso', 'Sesión cerrada', 'Pasaron ' + CONFIG.inactividad_min + ' minutos sin uso. Ingrese de nuevo.');
    if (!volver.startsWith('login')) location.hash = '#/login?volver=' + encodeURIComponent(volver);
    throw { errores: (j && j.errores) || ['Debe iniciar sesión.'], silencioso: true };
  }
  if (r.status === 403 && j && j.debe_cambiar) {
    SESION.debe_cambiar = true;
    location.hash = '#/cambiar-clave';
    throw { errores: j.errores, silencioso: true };
  }
  if (!r.ok) throw (j && j.errores) ? j : { errores: ['Error ' + r.status + ' del servidor.'] };
  return j;
}

/* ------------------------------------------------------------------ avisos */
function toast(tipo, titulo, detalle, ms) {
  ms = ms || (tipo === 'error' ? 7000 : tipo === 'aviso' ? 7000 : 4500);
  const ico = { ok: '✓', error: '!', aviso: '⚠' }[tipo] || 'i';
  const el = document.createElement('div');
  el.className = 'toast ' + tipo;
  el.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
  const cuerpo = Array.isArray(detalle) ? (detalle.length ? '<ul>' + detalle.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
    : (detalle ? '<p>' + esc(detalle) + '</p>' : '');
  el.innerHTML = '<span class="t-ico">' + ico + '</span><div><strong>' + esc(titulo) + '</strong>' + cuerpo + '</div>' +
    '<button class="cerrar" aria-label="Cerrar">×</button><span class="tiempo" style="animation-duration:' + ms + 'ms"></span>';
  const cerrar = () => { el.classList.add('salir'); setTimeout(() => el.remove(), 350); };
  el.querySelector('.cerrar').onclick = cerrar;
  document.getElementById('toasts').appendChild(el);
  setTimeout(cerrar, ms);
}
function mostrarMensaje(el, tipo, titulo, lista) {
  el.innerHTML = '<div class="mensaje ' + tipo + '"><strong>' + esc(titulo) + '</strong>' +
    (lista && lista.length ? '<ul>' + lista.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') + '</div>';
}
function sacudir(el) { if (!el) return; el.classList.remove('sacudir'); void el.offsetWidth; el.classList.add('sacudir'); }
function datosForm(form) {
  const o = {};
  new FormData(form).forEach((v, k) => { o[k] = typeof v === 'string' ? v.trim() : v; });
  return o;
}
function requeridos(form) {
  let ok = true;
  form.querySelectorAll('[data-req]').forEach(i => {
    const vacio = !String(i.value).trim();
    i.classList.toggle('invalido', vacio);
    if (vacio) ok = false;
  });
  form.querySelectorAll('[data-req-radio]').forEach(g => {
    const marcado = g.querySelector('input:checked');
    g.classList.toggle('invalido', !marcado);
    if (!marcado) ok = false;
  });
  if (!ok) { sacudir(form); toast('error', 'Faltan datos', 'Complete los campos marcados en rojo.'); }
  return ok;
}
function quitarInvalido(form) {
  const f = e => { e.target.classList && e.target.classList.remove('invalido'); const g = e.target.closest && e.target.closest('[data-req-radio]'); if (g) g.classList.remove('invalido'); };
  form.addEventListener('input', f);
  form.addEventListener('change', f);
}
function botonCargando(btn, si, texto) {
  if (si) { btn.dataset.txt = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + esc(texto || 'Guardando…'); }
  else { btn.disabled = false; if (btn.dataset.txt) btn.innerHTML = btn.dataset.txt; }
}
function errorEn(e, msg, titulo) {
  if (e && e.silencioso) return;
  mostrarMensaje(msg, 'error', titulo || 'No se pudo registrar:', e.errores);
  toast('error', titulo || 'Revise los datos', e.errores);
}

/* ------------------------------------------------------------------ ventana modal */
function modal(html, alAbrir) {
  const fondo = document.getElementById('modal');
  fondo.innerHTML = '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>';
  fondo.hidden = false;
  const cerrar = () => { fondo.hidden = true; fondo.innerHTML = ''; };
  fondo.onclick = e => { if (e.target === fondo) cerrar(); };
  fondo.querySelectorAll('[data-cerrar]').forEach(b => { b.onclick = cerrar; });
  const primero = fondo.querySelector('input, textarea, select');
  if (primero) primero.focus();
  if (alAbrir) alAbrir(fondo.querySelector('.modal'), cerrar);
  return cerrar;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') { const f = document.getElementById('modal'); if (!f.hidden) { f.hidden = true; f.innerHTML = ''; } } });

/* ------------------------------------------------------------------ animaciones de hojas */
function flor(el, chica) {
  let h = '';
  for (let i = 0; i < 8; i++) h += '<div class="petalo" style="--a:' + (i * 45) + 'deg;--d:' + (i * 0.07).toFixed(2) + 's;--r:' + (chica ? -56 : -74) + 'px">' + HOJA() + '</div>';
  for (let i = 0; i < 8; i++) h += '<div class="petalo chico" style="--a:' + (22.5 + i * 45) + 'deg;--d:' + (0.3 + i * 0.05).toFixed(2) + 's;--r:' + (chica ? -38 : -48) + 'px">' + HOJA() + '</div>';
  el.innerHTML = h + '<div class="flor-centro"></div>';
}
// Pantalla de carga (1,5 a 2 s, se puede saltar con un clic)
function pantallaCarga() {
  return new Promise(resolver => {
    if (!MOVIMIENTO || leerSesion('splashVisto', '')) { resolver(); return; }
    guardarSesion('splashVisto', '1');
    const s = document.getElementById('splash');
    flor(document.getElementById('florSplash'));
    s.hidden = false;
    let listo = false;
    const fin = () => { if (listo) return; listo = true; s.classList.add('saliendo'); setTimeout(() => { s.hidden = true; s.classList.remove('saliendo'); }, 600); resolver(); };
    s.onclick = fin;
    setTimeout(fin, 1900);
  });
}
// Animación corta al iniciar sesión (1 s)
function animacionIngreso() {
  return new Promise(resolver => {
    if (!MOVIMIENTO) { resolver(); return; }
    const s = document.getElementById('splash');
    s.classList.add('mini');
    flor(document.getElementById('florSplash'), true);
    s.hidden = false;
    setTimeout(() => {
      s.classList.add('saliendo');
      resolver();
      setTimeout(() => { s.hidden = true; s.classList.remove('saliendo', 'mini'); }, 600);
    }, 1000);
  });
}
// Hojas que caen y giran
function hojasCayendo(cantidad, opMin, opMax, durMin, durMax, tamMin, tamMax) {
  if (!MOVIMIENTO) return '';
  let h = '';
  for (let i = 0; i < cantidad; i++) {
    const tam = tamMin + Math.random() * (tamMax - tamMin);
    const dur = durMin + Math.random() * (durMax - durMin);
    h += '<div class="cae' + (Math.random() < 0.18 ? ' oro' : '') + '" style="left:' + (Math.random() * 100).toFixed(1) + '%;width:' + tam.toFixed(0) + 'px;height:' + (tam * 1.8).toFixed(0) +
      'px;--dur:' + dur.toFixed(1) + 's;--del:-' + (Math.random() * dur).toFixed(1) + 's;--op:' + (opMin + Math.random() * (opMax - opMin)).toFixed(2) +
      ';--dx:' + ((Math.random() - 0.5) * 220).toFixed(0) + 'px;--giro:' + ((Math.random() < 0.5 ? -1 : 1) * (180 + Math.random() * 360)).toFixed(0) +
      'deg;--bal:' + (2 + Math.random() * 3).toFixed(1) + 's">' + HOJA() + '</div>';
  }
  return h;
}
function fondoSuave() {
  const f = document.getElementById('fondoHojas');
  if (!f.innerHTML) f.innerHTML = hojasCayendo(4, 0.05, 0.09, 38, 60, 22, 38);
}

/* ------------------------------------------------------------------ animación de cifras y gráficos */
function contar(el) {
  const fin = Number(el.dataset.contar) || 0;
  const fmt = FORMATOS[el.dataset.fmt] || FORMATOS.n;
  if (!MOVIMIENTO) { el.textContent = fmt(fin); return; }
  const dur = 1100, t0 = performance.now();
  const paso = t => {
    const p = Math.max(0, Math.min(1, (t - t0) / dur)), e = 1 - Math.pow(1 - p, 3);
    el.textContent = p < 1 ? fmt(el.dataset.fmt === 'bs' ? fin * e : Math.round(fin * e * 2) / 2) : fmt(fin);
    if (p < 1) requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
  setTimeout(() => { el.textContent = fmt(fin); }, dur + 200);  // asegura el valor final
}
function animar(raiz) {
  raiz = raiz || $app;
  raiz.querySelectorAll('[data-contar]').forEach(contar);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    raiz.querySelectorAll('[data-ancho]').forEach(el => { el.style.width = el.dataset.ancho + '%'; });
    raiz.querySelectorAll('.dona .seg').forEach(c => { c.style.strokeDasharray = c.dataset.dash; c.style.strokeDashoffset = c.dataset.off; });
    raiz.querySelectorAll('.grafico').forEach(g => {
      g.querySelectorAll('.linea, .linea-c').forEach(l => {
        if (!l.getTotalLength) return;
        const L = l.getTotalLength(); l.style.strokeDasharray = L; l.style.strokeDashoffset = MOVIMIENTO ? L : 0;
      });
      g.classList.add('listo');
    });
  }));
}
document.addEventListener('click', e => {
  const b = e.target.closest('.btn');
  if (!b || !MOVIMIENTO) return;
  const r = b.getBoundingClientRect(), d = Math.max(r.width, r.height);
  const s = document.createElement('span');
  s.className = 'onda';
  s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
  b.appendChild(s);
  setTimeout(() => s.remove(), 650);
});
const $tip = document.createElement('div');
$tip.className = 'tip';
document.body.appendChild($tip);
document.addEventListener('mousemove', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { $tip.classList.remove('ver'); return; }
  $tip.innerHTML = t.dataset.tip;
  const w = $tip.offsetWidth;
  $tip.style.left = Math.min(window.innerWidth - w - 10, Math.max(10, e.clientX - w / 2)) + 'px';
  $tip.style.top = (e.clientY - 56) + 'px';
  $tip.classList.add('ver');
});

/* ------------------------------------------------------------------ componentes */
function kpi(etq, valor, fmt, det, ico, cls, i) {
  return '<div class="tarjeta kpi elevar esc ' + (cls || '') + '" style="--i:' + (i || 0) + '"><span class="ico">' + (ICO[ico] || '') + '</span>' +
    '<div class="etq">' + esc(etq) + '</div><div class="val" data-contar="' + valor + '" data-fmt="' + fmt + '">' + FORMATOS[fmt](0) + '</div>' +
    '<div class="det">' + det + '</div></div>';
}
function barras(lista, campoNombre, campoValor, fmt, tipFn) {
  const max = Math.max(1, ...lista.map(d => d[campoValor]));
  return '<div class="barras">' + lista.map(d =>
    '<div class="barra-fila"' + (tipFn ? ' data-tip="' + esc(tipFn(d)) + '"' : '') + '><span>' + esc(d[campoNombre]) + '</span>' +
    '<div class="pista"><div class="relleno" data-ancho="' + (d[campoValor] * 100 / max).toFixed(1) + '"></div></div>' +
    '<span class="cifra"><strong>' + fmt(d[campoValor]) + '</strong>' + (d.porcentaje !== undefined ? '<small>' + fmtPct(d.porcentaje) + '</small>' : '') + '</span></div>').join('') + '</div>';
}
const barrasDepartamentos = lista => barras(lista, 'departamento', 'libras', fmtLb, d => '<b>' + d.departamento + '</b><br>' + fmtLb(d.libras) + ' · ' + d.hojas_ruta + ' hojas de ruta');
function donaInventario(inv) {
  const t = inv.total_en_mercado || 0, r = 70, C = 2 * Math.PI * r;
  const a = t ? inv.sin_vender / t * C : 0, b = t ? inv.vendida_sin_salir / t * C : 0;
  return '<div class="dona-box"><div class="dona"><svg viewBox="0 0 170 170">' +
    '<circle class="fondo" cx="85" cy="85" r="' + r + '"/>' +
    '<circle class="seg" cx="85" cy="85" r="' + r + '" stroke="#2E7D32" style="stroke-dasharray:0 ' + C + '" data-dash="' + a + ' ' + C + '" data-off="0"/>' +
    '<circle class="seg" cx="85" cy="85" r="' + r + '" stroke="#D9A441" style="stroke-dasharray:0 ' + C + ';stroke-dashoffset:0" data-dash="' + b + ' ' + C + '" data-off="' + (-a) + '"/>' +
    '</svg><div class="centro"><strong data-contar="' + t + '" data-fmt="lb">0 lb</strong><small>en el galpón<br>≈ ' + fmtTq(inv.taques_equivalentes) + ' taques</small></div></div>' +
    '<div class="inv-lista">' +
    '<div class="inv-item"><span><i class="punto" style="background:#2E7D32"></i>Sin vender</span><strong data-contar="' + inv.sin_vender + '" data-fmt="lb">0 lb</strong></div>' +
    '<div class="inv-item"><span><i class="punto" style="background:#D9A441"></i>Vendida, por despachar</span><strong data-contar="' + inv.vendida_sin_salir + '" data-fmt="lb">0 lb</strong></div>' +
    '<p class="muted" style="margin:0;font-size:.82rem">Saldo físico actual: lo que entró al galpón y todavía no salió hacia los departamentos.</p>' +
    '</div></div>';
}
function graficoDiario(dias) {
  const W = 640, H = 220, pl = 44, pb = 24, pt = 8, n = dias.length;
  const max = Math.max(1, ...dias.map(d => Math.max(d.libras, d.salidas_lb || 0)));
  const paso = Math.pow(10, Math.floor(Math.log10(max)));
  const tope = Math.ceil(max / paso) * paso;
  const ah = H - pb - pt, slot = (W - pl) / n, bw = slot * 0.62;
  const y = v => pt + ah - v / tope * ah;
  let s = '<svg class="grafico" viewBox="0 0 ' + W + ' ' + H + '" style="height:auto" role="img" aria-label="Entradas y salidas por día">';
  for (let i = 0; i <= 4; i++) {
    const v = tope * i / 4, yy = y(v);
    s += '<line class="guia" x1="' + pl + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"/><text class="eje" x="' + (pl - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + fmtNum(v, 0) + '</text>';
  }
  const pts = [];
  dias.forEach((d, i) => {
    const x = pl + i * slot + (slot - bw) / 2;
    s += '<rect class="col" style="--i:' + i + '" x="' + x.toFixed(1) + '" y="' + y(d.libras).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, d.libras / tope * ah).toFixed(1) + '" rx="3"/>';
    pts.push([pl + i * slot + slot / 2, y(d.salidas_lb || 0)]);
    if (i % 5 === 0 || i === n - 1) s += '<text class="eje" x="' + (pl + i * slot + slot / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtFechaCorta(d.fecha) + '</text>';
  });
  s += '<polyline class="linea" points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
  pts.forEach((p, i) => { s += '<circle class="pt" style="--i:' + i + '" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3"/>'; });
  dias.forEach((d, i) => {
    s += '<rect class="zona" x="' + (pl + i * slot).toFixed(1) + '" y="' + pt + '" width="' + slot.toFixed(1) + '" height="' + ah + '" data-tip="<b>' +
      DIAS[new Date(d.fecha + 'T12:00:00').getDay()] + ' ' + fmtFecha(d.fecha) + '</b><br>Entradas: ' + fmtLb(d.libras) + ' (' + d.entradas + ')<br>Salidas: ' + fmtLb(d.salidas_lb || 0) + '"/>';
  });
  return s + '</svg><div class="leyenda" style="margin-top:6px"><span><i style="background:#2E7D32"></i>Entradas (lb)</span><span><i style="background:#D9A441;height:3px;vertical-align:3px"></i>Salidas a departamentos (lb)</span></div>';
}
const COLOR_CAL = { 1: '#D9A441', 2: '#2E7D32', 3: '#8D7A62' };
function graficoPrecios(dias) {
  const W = 640, H = 230, pl = 48, pb = 24, pt = 10, n = dias.length;
  const vals = []; dias.forEach(d => [d.p1, d.p2, d.p3].forEach(v => { if (v) vals.push(v); }));
  if (!vals.length) return '<p class="vacio">Sin ventas en el período.</p>';
  const mn = Math.floor(Math.min(...vals) / 5) * 5, mx = Math.ceil(Math.max(...vals) / 5) * 5 || mn + 5;
  const ah = H - pb - pt, slot = (W - pl) / Math.max(1, n - 1);
  const x = i => pl + i * slot, y = v => pt + ah - (v - mn) / (mx - mn) * ah;
  let s = '<svg class="grafico" viewBox="0 0 ' + W + ' ' + H + '" style="height:auto" role="img" aria-label="Precio promedio diario por calidad">';
  for (let i = 0; i <= 4; i++) {
    const v = mn + (mx - mn) * i / 4, yy = y(v);
    s += '<line class="guia" x1="' + pl + '" x2="' + W + '" y1="' + yy + '" y2="' + yy + '"/><text class="eje" x="' + (pl - 6) + '" y="' + (yy + 3) + '" text-anchor="end">Bs ' + fmtNum(v, 0) + '</text>';
  }
  dias.forEach((d, i) => { if (i % 5 === 0 || i === n - 1) s += '<text class="eje" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + fmtFechaCorta(d.fecha) + '</text>'; });
  [1, 2, 3].forEach(c => {
    let dpath = '', puntos = '';
    dias.forEach((d, i) => {
      const v = d['p' + c];
      if (!v) return;  // día sin ventas de esta calidad: la línea continúa hasta el siguiente día con ventas
      dpath += (dpath ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1);
      puntos += '<circle class="pt" style="--i:' + i + ';stroke:' + COLOR_CAL[c] + '" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="2.6"/>';
    });
    if (dpath) s += '<path class="linea-c" stroke="' + COLOR_CAL[c] + '" d="' + dpath + '"/>' + puntos;
  });
  dias.forEach((d, i) => {
    s += '<rect class="zona" x="' + (x(i) - slot / 2).toFixed(1) + '" y="' + pt + '" width="' + slot.toFixed(1) + '" height="' + ah + '" data-tip="<b>' + fmtFecha(d.fecha) + '</b>' +
      [1, 2, 3].map(c => '<br>' + esc(calNombre(c)) + ': ' + (d['p' + c] ? fmtBs(d['p' + c]) : '—')).join('') + '"/>';
  });
  return s + '</svg><div class="leyenda">' + [1, 2, 3].map(c => '<span><i style="background:' + COLOR_CAL[c] + ';height:3px;vertical-align:3px"></i>' + esc(calNombre(c)) + '</span>').join('') + '</div>';
}
function preciosHoy(lista) {
  return '<div class="precios-hoy">' + lista.map((p, i) =>
    '<div class="precio-cal c' + p.calidad + ' esc" style="--i:' + i + '">' + HOJA() + calChip(p.calidad) +
    '<div class="v">' + (p.precio ? fmtBs(p.precio) : '—') + '</div><small>' +
    (p.precio ? (p.es_hoy ? 'hoy · ' + fmtLb(p.libras) + ' vendidas' : 'sin ventas hoy · último: ' + fmtFecha(p.fecha)) : 'sin ventas registradas') +
    '</small></div>').join('') + '</div><p class="muted" style="font-size:.8rem;margin:10px 0 0">Promedio ponderado por libras de las ventas. Es solo una referencia: el precio lo acuerdan productor y comprador.</p>';
}
function pasos(actual) {
  const ps = [['entradas', 'Entrada'], ['ventas', 'Venta'], ['salidas', 'Salida'], ['hoja', 'Hoja de ruta']];
  const idx = ps.findIndex(p => p[0] === actual);
  return '<nav class="pasos" aria-label="Circuito">' + ps.map((p, i) =>
    '<a href="#/' + (p[0] === 'hoja' ? 'salidas' : p[0]) + '" class="' + (i === idx ? 'activo' : i < idx ? 'hecho' : '') + '"><span class="n">' + (i < idx ? '✓' : i + 1) + '</span><span class="txt">' + p[1] + '</span></a>').join('') + '</nav>';
}
const buscador = (id, ph) => '<div class="buscador">' + ICO.buscar + '<input id="' + id + '" type="search" placeholder="' + esc(ph) + '"></div>';
function selectorMercado(id, sel) {
  return '<select id="' + id + '"><option value="">Todos los mercados</option>' +
    Object.keys(CONFIG.mercados).map(m => '<option' + (m === sel ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select>';
}
const filaAnim = (i, id, tipo) => ' class="' + (i < 40 ? 'fila-anim' : '') + (ULTIMO_ID[tipo] === id ? ' nuevo' : '') + '" style="--i:' + i + '"';
const esqueleto = h => '<div class="esqueleto" style="height:' + (h || 120) + 'px"></div>';
const quien = r => r.registrado_por ? '<small class="muted" title="' + esc(r.registrado_por) + '">' + esc(String(r.registrado_por).replace(/.*\((.*)\)$/, '$1')) + '</small>' : '';

/* ------------------------------------------------------------------ barra superior y menú por rol */
function itemsMenu() {
  const r = SESION.rol, it = [];
  if (ROLES_PANEL.includes(r)) it.push(['', 'Panel']);
  if (ROLES_REGISTRO.includes(r)) it.push(['entradas', 'Entradas'], ['ventas', 'Ventas'], ['salidas', 'Salidas']);
  if (['admin', 'supervisor'].includes(r)) it.push(['hojas', 'Hojas de ruta']);
  if (['admin', 'controlador'].includes(r)) it.push(['verificar', 'Verificar']);
  if (['admin', 'supervisor'].includes(r)) it.push(['reportes', 'Reportes']);
  if (r === 'admin') it.push(['usuarios', 'Administración']);
  return it;
}
function pintarBarra(modo) {
  const nav = document.getElementById('menu');
  document.body.classList.toggle('sin-sesion', !SESION && modo !== 'publico');
  document.body.classList.toggle('publico', modo === 'publico');
  if (!SESION) {
    nav.innerHTML = modo === 'publico'
      ? '<a href="#/?ir=precios" data-ir="sec-precios">Precio del día</a><a href="#/?ir=consulta" data-ir="sec-consulta">Consultar mi hoja de ruta</a>' +
        '<a class="btn-entrar" href="#/login">' + ICO.candado.replace('<svg', '<svg width="15" height="15" style="vertical-align:-2px;margin-right:5px"') + 'Ingreso del personal</a>'
      : '';
    enlazarIr(nav);
    return;
  }
  fondoSuave();
  nav.innerHTML = itemsMenu().map(([r, t]) => '<a href="#/' + r + '" data-r="' + r + '">' + t + '</a>').join('') +
    '<div class="zona-usuario"><button class="chip-usuario" id="chipU" aria-haspopup="true"><span class="avatar">' + esc(iniciales(SESION.nombre)) + '</span>' +
    '<span class="info"><span>' + esc(SESION.nombre.split(' ').slice(0, 2).join(' ')) + '<span class="chip-rol">' + esc(SESION.rol_nombre) + '</span></span>' +
    '<small>' + esc(SESION.mercado || (SESION.rol === 'controlador' ? 'Control en carretera' : 'Todos los mercados')) + '</small></span> ▾</button>' +
    '<div class="menu-usuario" id="menuU"><div class="cab"><strong>' + esc(SESION.nombre) + '</strong><small>@' + esc(SESION.usuario) + ' · ' + esc(SESION.rol_nombre) +
    (SESION.mercado ? ' · ' + esc(SESION.mercado) : '') + '</small></div>' +
    '<a href="#/cuenta">Mi cuenta y contraseña</a><a href="#/inicio">Ver la página pública</a>' +
    (SESION.rol === 'admin' ? '<a href="#/usuarios">Usuarios</a><a href="#/bitacora">Bitácora</a><a href="#/configuracion">Configuración</a>' : '') +
    '<button class="salir" id="btnSalir">Cerrar sesión</button></div></div>';
  const menu = document.getElementById('menuU');
  document.getElementById('chipU').onclick = e => { e.stopPropagation(); menu.classList.toggle('abierto'); };
  document.getElementById('btnSalir').onclick = async () => {
    try { await api('/api/logout', {}); } catch (e) { /* nada */ }
    SESION = null;
    toast('ok', 'Sesión cerrada', 'Hasta pronto.');
    location.hash = '#/';
  };
}
document.addEventListener('click', () => { const m = document.getElementById('menuU'); if (m) m.classList.remove('abierto'); });
const inicio = () => SESION && SESION.rol === 'controlador' ? 'verificar' : '';

/* ------------------------------------------------------------------ efectos de la página pública */
// Aparece al desplazarse (y anima gráficos y cifras la primera vez que se ve)
let observador = null;
function revelar(raiz) {
  const els = (raiz || document).querySelectorAll('.revelar:not(.visible)');
  const mostrar = el => { el.classList.add('visible'); if (el.hasAttribute('data-animar')) animar(el); };
  if (!MOVIMIENTO || !('IntersectionObserver' in window)) { els.forEach(mostrar); return; }
  if (!observador) {
    observador = new IntersectionObserver(entradas => entradas.forEach(e => {
      if (e.isIntersecting) { observador.unobserve(e.target); mostrar(e.target); }
    }), { threshold: 0.12 });
  }
  els.forEach(el => observador.observe(el));
}
// Tarjetas que se inclinan en 3D siguiendo el puntero, con un brillo
function inclinar(raiz) {
  if (!MOVIMIENTO || !window.matchMedia('(hover: hover)').matches) return;
  raiz.querySelectorAll('.inclinar').forEach(el => {
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.style.transform = 'perspective(700px) rotateX(' + ((0.5 - y) * 10).toFixed(2) + 'deg) rotateY(' + ((x - 0.5) * 12).toFixed(2) + 'deg) translateY(-4px)';
      el.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
      el.style.setProperty('--my', (y * 100).toFixed(1) + '%');
    });
    el.addEventListener('mouseleave', () => { el.style.transform = ''; });
  });
}
// Minigráfico de la tendencia del precio
function sparkline(serie, color) {
  if (!serie || serie.length < 2) return '<div class="spark-vacio">Sin historial suficiente</div>';
  const W = 160, H = 40, p = serie.map(s => s.precio), mn = Math.min(...p), mx = Math.max(...p), rango = (mx - mn) || 1;
  const pts = p.map((v, i) => [i * W / (p.length - 1), 4 + (H - 8) * (1 - (v - mn) / rango)]);
  const linea = pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');
  const ult = pts[pts.length - 1];
  return '<svg class="grafico spark" viewBox="-2 0 ' + (W + 6) + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
    '<polygon class="spark-area" fill="' + color + '" points="0,' + H + ' ' + linea + ' ' + W + ',' + H + '"/>' +
    '<polyline class="linea-c" stroke="' + color + '" points="' + linea + '"/>' +
    '<line class="spark-pt" x1="' + ult[0].toFixed(1) + '" y1="' + ult[1].toFixed(1) + '" x2="' + ult[0].toFixed(1) + '" y2="' + ult[1].toFixed(1) + '" stroke="' + color + '" vector-effect="non-scaling-stroke"/></svg>';
}
function variacionHtml(v) {
  if (v === null || v === undefined) return '<span class="var neutra">—</span>';
  if (Math.abs(v) < 0.05) return '<span class="var neutra">= 0 %</span>';
  return '<span class="var ' + (v > 0 ? 'sube' : 'baja') + '" title="Frente al día anterior con ventas">' + (v > 0 ? '▲ ' : '▼ ') + fmtNum(Math.abs(v), 1) + ' %</span>';
}
const fechaDe = s => new Date(String(s).replace(' ', 'T'));
function textoRestante(ms) {
  const neg = ms < 0; ms = Math.abs(ms);
  const d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
  const t = (d ? d + ' d ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  return neg ? 'Venció hace ' + t : 'Vence en ' + t;
}

/* ------------------------------------------------------------------ Página pública (sin iniciar sesión) */
function enlazarIr(raiz) {
  raiz.querySelectorAll('[data-ir]').forEach(a => {
    a.addEventListener('click', e => {
      const destino = document.getElementById(a.dataset.ir);
      if (!destino) return;
      e.preventDefault();
      document.getElementById('menu').classList.remove('abierto');
      destino.scrollIntoView({ behavior: MOVIMIENTO ? 'smooth' : 'auto', block: 'start' });
      if (a.dataset.ir === 'sec-consulta') setTimeout(() => { const c = document.getElementById('pCodigo'); if (c) c.focus({ preventScroll: true }); }, MOVIMIENTO ? 600 : 0);
    });
  });
}
async function vistaPublica(params) {
  const pasosPub = [
    ['entrada', 'Entrada', 'El productor llega al galpón; se pesa la hoja y se registra su calidad.'],
    ['venta', 'Venta', 'Productor y comprador acuerdan el precio por libra.'],
    ['camion', 'Salida', 'Se emite la hoja de ruta con QR, destino, libras y vencimiento.'],
    ['escudo', 'Verificación', 'La policía escanea el QR en la tranca y compara con la carga.'],
  ];
  $app.innerHTML = '<div class="publica">' +
    '<section class="heroe-pub" id="heroePub"><div class="lluvia-hero" aria-hidden="true">' + hojasCayendo(14, 0.1, 0.32, 11, 22, 14, 40) + '</div><div class="brillo-cursor"></div>' +
    '<div class="heroe-pub-txt"><div class="chips"><span class="chip-h"><span class="punto-vivo"></span>Información pública</span><span class="chip-h reloj" id="relojPub"></span></div>' +
    '<h1>Precio del día de la <span class="resalte">hoja de coca</span></h1>' +
    '<p>Precio promedio por libra en los mercados autorizados de Villa Fátima (La Paz) y Sacaba (Cochabamba). Si compró hoja de coca, consulte aquí su hoja de ruta.</p>' +
    '<div class="acciones-heroe"><a class="btn ocre" href="#/?ir=consulta" data-ir="sec-consulta">' + ICO.qr + ' Consultar mi hoja de ruta</a>' +
    '<a class="btn claro" href="#/login">' + ICO.candado + ' Ingreso del personal</a></div></div>' +
    '<div class="heroe-flor" aria-hidden="true"><div class="flor" id="florPub"></div></div></section>' +
    '<div class="cinta" aria-hidden="true"><div class="cinta-pista" id="cinta"><span>Cargando precios del día…</span></div></div>' +

    '<section class="seccion-pub revelar" id="sec-precios"><div class="tarjeta-cab"><div><h2>Precio del día</h2>' +
    '<p class="sub" style="margin:0" id="notaPrecios">Promedio ponderado por libras de las ventas de hoy en cada mercado.</p></div></div>' +
    '<div id="precios"><div class="precios-grid">' + [1, 2, 3].map(() => esqueleto(190)).join('') + '</div></div></section>' +

    '<section class="seccion-pub revelar" id="sec-consulta"><div class="consulta-grid"><div>' +
    '<h2>Consultar mi hoja de ruta</h2><p class="sub">Escriba el código impreso en su hoja de ruta y su número de CI (el del comprador). Podrá ver su estado y volver a imprimirla con su código QR.</p>' +
    '<form id="fConsulta" class="form-consulta" autocomplete="off" novalidate>' +
    '<label for="pCodigo">Código de la hoja de ruta</label><input id="pCodigo" name="codigo" class="input-codigo" placeholder="HR-' + new Date().getFullYear() + '-000001" autocapitalize="characters" data-req>' +
    '<label for="pCi">CI del comprador</label><input id="pCi" name="ci" placeholder="Ej. 4567890 o 4567890-1A" inputmode="text" data-req>' +
    '<button class="btn ancho" type="submit">' + ICO.buscar + ' Consultar</button>' +
    '<p class="muted" style="font-size:.8rem;margin:10px 0 0">Por seguridad, solo se muestra si el código y el CI coinciden.</p></form></div>' +
    '<div id="resConsulta" class="res-consulta"><div class="consulta-vacia">' + HOJA('hoja-grande') + '<p>Aquí aparecerá su hoja de ruta.</p></div></div></div></section>' +

    '<section class="seccion-pub revelar"><h2>¿Cómo funciona el control?</h2><div class="pasos-pub">' +
    pasosPub.map((p, i) => '<div class="paso-pub revelar" style="--i:' + i + '"><span class="paso-ico">' + ICO[p[0]] + '<b>' + (i + 1) + '</b></span><strong>' + p[1] + '</strong><p>' + p[2] + '</p></div>').join('') +
    '</div></section>' +
    '<p class="pie-publico">¿Es personal autorizado? <a href="#/login">Ingrese aquí</a></p>' +
    '</div><div id="guiaImprimible" class="guia-imprimible"></div>';

  enlazarIr($app);
  flor(document.getElementById('florPub'));
  revelar($app);
  // Reloj y brillo que sigue al cursor
  const reloj = document.getElementById('relojPub');
  const tic = () => { if (!document.body.contains(reloj)) return clearInterval(tRel); const d = new Date(); reloj.textContent = mayus(DIAS[d.getDay()]) + ', ' + fmtFecha(isoLocal(d)) + ' · ' + d.toTimeString().slice(0, 5); };
  const tRel = setInterval(tic, 10000); tic();
  const heroe = document.getElementById('heroePub');
  if (MOVIMIENTO) heroe.addEventListener('mousemove', e => {
    const r = heroe.getBoundingClientRect();
    heroe.style.setProperty('--cx', (e.clientX - r.left) + 'px');
    heroe.style.setProperty('--cy', (e.clientY - r.top) + 'px');
  });

  // Consulta de la hoja de ruta
  const f = document.getElementById('fConsulta');
  quitarInvalido(f);
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]'), res = document.getElementById('resConsulta');
    botonCargando(btn, true, 'Buscando…');
    res.innerHTML = '<div class="escaner">Buscando ' + esc(f.codigo.value.trim().toUpperCase()) + '…</div>';
    const [r] = await Promise.allSettled([api('/api/publico/hoja', { codigo: f.codigo.value, ci: f.ci.value }), espera(MOVIMIENTO ? 650 : 0)]);
    botonCargando(btn, false);
    if (r.status !== 'fulfilled') {
      res.innerHTML = '<div class="resultado invalida"><div class="sello-wrap"><span class="icono">✕</span><span class="sello">NO ENCONTRADA</span></div><p>' + esc(((r.reason || {}).errores || ['Error']).join(' ')) + '</p></div>';
      sacudir(f);
      return;
    }
    mostrarGuia(r.value, res);
  };

  // Precios del día
  let datos;
  try { datos = await api('/api/publico/precios'); }
  catch (e) { document.getElementById('precios').innerHTML = '<div class="mensaje error">' + esc((e.errores || []).join(' ')) + '</div>'; return; }
  const todosHoy = datos.mercados.every(m => m.calidades.every(c => c.es_hoy));
  document.getElementById('notaPrecios').innerHTML = (todosHoy ? 'Precios de hoy, ' : 'Hoy, ') + fmtFechaLarga(datos.hoy) +
    (todosHoy ? '.' : '. Donde todavía no hubo ventas hoy se muestra el último día con ventas.') + ' Promedio ponderado por libras: es una referencia, el precio final lo acuerdan productor y comprador.';
  document.getElementById('precios').innerHTML = datos.mercados.map((m, im) =>
    '<div class="mercado-precios revelar" data-animar style="--i:' + im + '"><h3>' + ICO.almacen + esc(m.mercado) + '</h3><div class="precios-grid">' +
    m.calidades.map((c, i) =>
      '<div class="precio-card c' + c.calidad + ' inclinar esc" style="--i:' + (i + im * 3) + '">' + HOJA('pc-hoja') +
      '<div class="pc-cab">' + calChip(c.calidad) + variacionHtml(c.variacion) + '</div>' +
      '<div class="pc-valor"' + (c.precio ? ' data-contar="' + c.precio + '" data-fmt="bs">Bs 0,00' : '>—') + '</div><div class="pc-unidad">por libra</div>' +
      sparkline(c.serie, COLOR_CAL[c.calidad]) +
      '<div class="pc-fecha ' + (c.es_hoy ? 'hoy' : '') + '">' + (c.precio ? (c.es_hoy ? '<span class="punto-vivo"></span>Hoy · ' + fmtLb(c.libras) + ' vendidas' : 'Último día con ventas: <strong>' + fmtFecha(c.fecha) + '</strong>') : 'Sin ventas registradas') + '</div>' +
      '</div>').join('') + '</div></div>').join('');
  revelar(document.getElementById('precios'));
  inclinar(document.getElementById('precios'));
  // Cinta de precios en movimiento (contenido duplicado para un recorrido continuo)
  const items = datos.mercados.flatMap(m => m.calidades.filter(c => c.precio).map(c =>
    '<span class="cinta-item">' + HOJA() + '<b>' + esc(mercadoCorto(m.mercado)) + '</b> ' + esc(c.nombre) + ' <strong>' + fmtBs(c.precio) + '</strong> ' + variacionHtml(c.variacion) + '</span>')).join('');
  document.getElementById('cinta').innerHTML = MOVIMIENTO ? items + items : items;
  if (params.get('ir')) { const d = document.getElementById('sec-' + params.get('ir')); if (d) d.scrollIntoView({ behavior: MOVIMIENTO ? 'smooth' : 'auto' }); }
}

function mostrarGuia(h, res) {
  const offset = fechaDe(h.ahora) - Date.now();   // diferencia con el reloj del servidor (hora de Bolivia)
  const vence = fechaDe(h.vence);
  res.innerHTML = '<div class="guia-res ' + h.estado + '">' +
    '<div class="gr-cab"><div><small>Hoja de ruta</small><strong class="codigo">' + esc(h.hoja_ruta) + '</strong></div><span class="estado grande ' + h.estado + '">' + h.estado + '</span></div>' +
    (h.estado === 'ANULADA' ? '<div class="aviso-anulada">Esta hoja de ruta fue ANULADA. Motivo: ' + esc(h.motivo_anulacion) + '. Consulte en el mercado.</div>' : '') +
    '<div class="gr-destino"><div><small>Destino</small><strong>' + esc(h.departamento) + '</strong></div><div><small>Cantidad</small><strong>' + fmtLb(h.libras) + '</strong></div></div>' +
    '<dl class="dl"><dt>Calidad</dt><dd>' + calChip(h.calidad) + '</dd>' +
    '<dt>Placa</dt><dd>' + esc(h.placa || 'Sin vehículo registrado') + '</dd>' +
    '<dt>Transportista</dt><dd>' + esc(h.transportista) + '</dd>' +
    '<dt>Emitida</dt><dd>' + fmtFH(h.emitida) + '</dd>' +
    '<dt>Vence</dt><dd>' + fmtFH(h.vence) + '</dd></dl>' +
    (h.estado !== 'ANULADA' ? '<div class="cuenta-regresiva ' + h.estado + '" id="cuentaReg"></div>' : '') +
    '<button class="btn ancho" id="imprimirGuia">🖨 Imprimir mi hoja de ruta</button></div>';
  const cr = document.getElementById('cuentaReg');
  if (cr) {
    const tic = () => {
      if (!document.body.contains(cr)) return clearInterval(t);
      const resta = vence - (Date.now() + offset);
      cr.textContent = textoRestante(resta);
      cr.classList.toggle('VENCIDA', resta < 0);
    };
    const t = setInterval(tic, 1000); tic();
  }
  // Documento imprimible (solo se ve al imprimir)
  const g = document.getElementById('guiaImprimible');
  g.innerHTML = '<article class="hoja' + (h.estado === 'ANULADA' ? ' anulada' : '') + '"><span class="sello-emitida ' + h.estado + '">' + h.estado + '</span>' +
    '<div class="hoja-cab"><div><div class="inst">Sistema de Control de Comercialización de la Hoja de Coca</div><h1>HOJA DE RUTA</h1>' +
    '<div class="cod">' + esc(h.hoja_ruta) + '</div><div class="vigencia"><span>Emitida: <strong>' + fmtFH(h.emitida) + '</strong></span><span>Vence: <strong>' + fmtFH(h.vence) + '</strong></span></div>' +
    '<div class="ayuda">Mercado ' + esc(h.mercado) + '</div></div><div class="qr" id="qrGuia"></div></div>' +
    (h.estado === 'ANULADA' ? '<div class="aviso-anulada">ANULADA. Motivo: ' + esc(h.motivo_anulacion) + '</div>' : '') +
    '<div class="destaque"><div><div class="etq">Departamento de destino</div><div class="grande">' + esc(h.departamento).toUpperCase() + '</div><div class="det">Calidad ' + esc(h.calidad_nombre) + '</div></div>' +
    '<div><div class="etq">Cantidad autorizada</div><div class="grande">' + fmtLb(h.libras) + '</div><div class="det">≈ ' + fmtTq(h.libras / CONFIG.libras_por_taque) + ' taques</div></div></div>' +
    '<div class="datos"><section><h3>Transporte</h3><dl class="dl"><dt>Transportista</dt><dd>' + esc(h.transportista) + '</dd><dt>CI</dt><dd>' + esc(h.ci_transportista) + '</dd>' +
    '<dt>Placa</dt><dd>' + esc(h.placa || 'Sin vehículo registrado') + '</dd><dt>Comprador</dt><dd>' + esc(h.comprador) + '</dd></dl></section>' +
    '<section><h3>Origen de la hoja</h3><dl class="dl"><dt>Mercado</dt><dd>' + esc(h.mercado) + '</dd><dt>Procedencia</dt><dd>' + esc(h.procedencia) + '</dd>' +
    '<dt>Calidad</dt><dd>' + esc(h.calidad_nombre) + '</dd></dl></section></div>' +
    '<div class="firmas"><div>Responsable del galpón</div><div>Transportista</div><div>Control en ruta</div></div>' +
    '<div class="hoja-pie">Copia impresa por el comprador el ' + fmtFH(h.ahora) + '. La policía verifica este documento escaneando el código QR. Válido solo para el destino, la cantidad y el plazo indicados.</div></article>';
  const qr = document.getElementById('qrGuia'), url = location.origin + '/#/verificar/' + h.hoja_ruta;
  if (window.QRCode) { try { new QRCode(qr, { text: url, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); } catch (e) { qr.innerHTML = '<div class="qr-texto">' + esc(h.hoja_ruta) + '</div>'; } }
  else qr.innerHTML = '<div class="qr-texto"><strong>Código:</strong><br>' + esc(h.hoja_ruta) + '<br><br>' + esc(url) + '<br><small>(QR no disponible sin internet)</small></div>';
  document.getElementById('imprimirGuia').onclick = () => {
    document.body.classList.add('solo-guia');
    window.print();
    setTimeout(() => document.body.classList.remove('solo-guia'), 500);
  };
  if (MOVIMIENTO) res.querySelector('.guia-res').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ------------------------------------------------------------------ Login */
async function vistaLogin(params) {
  const volver = params.get('volver') || '';
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  $app.innerHTML = '<div class="login-pantalla"><div class="lluvia">' + hojasCayendo(18, 0.15, 0.5, 9, 20, 16, 46) + '</div>' +
    '<div class="login-caja"><div class="login-marca">' + HOJA() + '<div><strong>Control de la Hoja de Coca</strong><small>Mercados autorizados de Villa Fátima y Sacaba</small></div></div>' +
    '<form class="login-tarjeta" id="form" autocomplete="on" novalidate>' +
    '<div class="login-cab">' + HOJA('hoja-logo') + '<h1>Iniciar sesión</h1><p>Solo personal autorizado.</p></div>' +
    '<div class="login-cuerpo">' +
    (volver && !volver.startsWith('login') ? '<div class="mensaje info" style="margin:0 0 6px">Ingrese para continuar' + (volver.startsWith('verificar/') ? ' con la verificación de la hoja de ruta <strong>' + esc(decodeURIComponent(volver.slice(10))) + '</strong>' : '') + '.</div>' : '') +
    '<label for="usuario">Usuario</label><div class="campo-icono">' + ICO.usuario + '<input id="usuario" name="usuario" autocomplete="username" autocapitalize="off" data-req></div>' +
    '<label for="clave">Contraseña</label><div class="campo-icono">' + ICO.candado + '<input id="clave" name="clave" type="password" autocomplete="current-password" data-req>' +
    '<button type="button" class="ver-clave" id="verClave">ver</button></div>' +
    '<button class="btn ancho" type="submit">Entrar</button>' +
    '<p class="login-nota">Las cuentas las crea el administrador. Tras 5 intentos fallidos el usuario se bloquea 5 minutos.' +
    (local ? '<br><br><strong>Solo para la demostración:</strong> admin / admin123 · operador_vf, operador_sc, supervisor1, control1 / prueba123' : '') + '</p>' +
    '</div></form><p style="text-align:center;margin-top:16px"><a href="#/" class="volver-publico">← Volver a la página pública</a></p></div></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  setTimeout(() => f.usuario.focus(), 50);
  document.getElementById('verClave').onclick = e => {
    const c = f.clave; c.type = c.type === 'password' ? 'text' : 'password'; e.target.textContent = c.type === 'password' ? 'ver' : 'ocultar';
  };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true, 'Verificando…');
    try {
      const r = await api('/api/login', datosForm(f));
      SESION = r.usuario;
      await animacionIngreso();
      pintarBarra();
      toast('ok', '¡Bienvenido, ' + SESION.nombre.split(' ')[0] + '!', SESION.rol_nombre + (SESION.mercado ? ' · ' + SESION.mercado : ''));
      location.hash = '#/' + (SESION.debe_cambiar ? 'cambiar-clave?volver=' + encodeURIComponent(volver) : (volver && !volver.startsWith('login') ? volver : inicio()));
    } catch (e) {
      botonCargando(btn, false);
      sacudir(f.querySelector('.login-cuerpo'));
      toast('error', 'No se pudo iniciar sesión', e.errores);
      f.clave.value = ''; f.clave.focus();
    }
  };
}

/* ------------------------------------------------------------------ Cambio de contraseña (obligatorio o voluntario) */
async function vistaClave(params, obligatorio) {
  $app.innerHTML = '<div class="vista" style="max-width:520px;margin:0 auto">' +
    '<div><h1>' + (obligatorio ? 'Cambie su contraseña' : 'Mi cuenta') + '</h1><p class="sub">@' + esc(SESION.usuario) + ' · ' + esc(SESION.rol_nombre) + (SESION.mercado ? ' · ' + esc(SESION.mercado) : '') + '</p></div>' +
    (obligatorio ? '<div class="mensaje aviso" style="margin:0 0 16px"><strong>Por seguridad debe elegir una contraseña nueva</strong> antes de usar el sistema (primer ingreso o contraseña restablecida).</div>' : '') +
    '<form class="tarjeta" id="form" novalidate><h2>Cambiar contraseña</h2>' +
    '<label for="actual">Contraseña actual</label><input id="actual" name="actual" type="password" autocomplete="current-password" data-req>' +
    '<label for="nueva">Nueva contraseña</label><input id="nueva" name="nueva" type="password" autocomplete="new-password" data-req>' +
    '<div class="ayuda">Mínimo 8 caracteres y distinta de la actual.</div>' +
    '<label for="repite">Repita la nueva contraseña</label><input id="repite" type="password" autocomplete="new-password" data-req>' +
    '<button class="btn ancho" type="submit">Guardar contraseña</button><div id="msg"></div></form>' +
    (obligatorio ? '<p style="text-align:center"><button class="link-btn" id="salir">Cerrar sesión</button></p>' : '') + '</div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  if (obligatorio) document.getElementById('salir').onclick = async () => { try { await api('/api/logout', {}); } catch (e) { /* nada */ } SESION = null; location.hash = '#/login'; };
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg');
    if (f.nueva.value !== f.repite.value) { f.repite.classList.add('invalido'); sacudir(f); mostrarMensaje(msg, 'error', 'Las contraseñas nuevas no coinciden.'); return; }
    const btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const r = await api('/api/clave', { actual: f.actual.value, nueva: f.nueva.value });
      toast('ok', r.mensaje);
      f.reset(); msg.innerHTML = '';
      if (obligatorio) {
        SESION.debe_cambiar = false;
        const v = params.get('volver') || '';
        location.hash = '#/' + (v && !v.startsWith('login') && !v.startsWith('cambiar') ? v : inicio());
      }
    } catch (e) { sacudir(f); errorEn(e, msg, 'No se pudo cambiar'); }
    finally { botonCargando(btn, false); }
  };
}

/* ------------------------------------------------------------------ 1. Panel */
async function vistaPanel() {
  const filtra = SESION.rol !== 'operador';
  const mercado = filtra ? leerSesion('panelMercado', '') : '';
  const hoy = new Date();
  const saludo = hoy.getHours() < 12 ? 'Buenos días' : hoy.getHours() < 19 ? 'Buenas tardes' : 'Buenas noches';
  const acciones = ROLES_REGISTRO.includes(SESION.rol)
    ? '<a class="btn ocre" href="#/entradas">+ Registrar entrada</a><a class="btn claro" href="#/ventas">Vender</a><a class="btn claro" href="#/salidas">Despachar</a>'
    : '<a class="btn ocre" href="#/reportes">Ver reportes</a><a class="btn claro" href="#/hojas">Hojas de ruta</a>';
  $app.innerHTML = '<div class="vista">' +
    '<section class="heroe"><div class="hojas-deco" aria-hidden="true">' + HOJA() + HOJA() + HOJA() + HOJA() + '</div><div class="heroe-texto">' +
    '<div class="chips"><span class="chip-h"><span class="punto-vivo"></span>En línea</span>' +
    '<span class="chip-h">' + mayus(DIAS[hoy.getDay()]) + ', ' + fmtFechaLarga(hoyISO()) + '</span>' +
    '<span class="chip-h">' + esc(SESION.mercado || (mercado || 'Todos los mercados')) + '</span><span class="chip-h" id="chipBD">…</span></div>' +
    '<h1>' + saludo + ', ' + esc(SESION.nombre.split(' ').filter(p => !p.endsWith('.'))[0]) + '</h1>' +
    '<p>Movimiento de la hoja de coca en ' + (SESION.mercado ? 'el galpón de <strong>' + esc(SESION.mercado) + '</strong>' : 'los mercados autorizados') + ': lo que entra, lo que se vende y lo que sale hacia cada departamento.</p>' +
    '<div class="acciones-heroe">' + acciones + '<span style="flex:1"></span>' + (filtra ? selectorMercado('fMercado', mercado) : '') + '</div></div></section>' +
    '<div id="panel"><div class="kpis">' + [1, 2, 3, 4, 5].map(() => esqueleto(108)).join('') + '</div>' + esqueleto(320) + '</div></div>';
  if (filtra) {
    const sel = document.getElementById('fMercado');
    sel.style.cssText = 'width:auto;min-width:210px;background:rgba(255,255,255,.95)';
    sel.onchange = () => { guardarSesion('panelMercado', sel.value); vistaPanel(); };
  }
  const r = await api('/api/resumen' + qsString({ mercado }));
  document.getElementById('chipBD').textContent = '🗄 ' + r.base_datos;
  document.getElementById('panel').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas al galpón', r.entradas.libras, 'lb', fmtNum(r.entradas.cantidad, 0) + ' ingresos · ' + fmtTq(r.entradas.taques) + ' taques', 'entrada', '', 0) +
    kpi('Vendido', r.ventas.libras, 'lb', fmtBs(r.ventas.monto) + ' · ' + fmtNum(r.ventas.cantidad, 0) + ' ventas', 'venta', '', 1) +
    kpi('Salidas a departamentos', r.salidas.libras, 'lb', fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta', 'camion', '', 2) +
    kpi('Saldo en el galpón', r.inventario.total_en_mercado, 'lb', '≈ ' + fmtTq(r.inventario.taques_equivalentes) + ' taques', 'almacen', 'ocre', 3) +
    kpi('Precio promedio', r.precio_promedio, 'bs', 'por libra (todo el período)', 'precio', 'ocre', 4) +
    '</div>' +
    '<div class="tarjeta esc" style="--i:2;margin-bottom:18px"><h2>Precio promedio de hoy por calidad</h2>' + preciosHoy(r.precio_hoy) + '</div>' +
    '<div class="grid-2">' +
    '<div class="tarjeta esc" style="--i:3"><h2>Coca enviada a cada departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div>' +
    '<div class="tarjeta esc" style="--i:4"><h2>Inventario actual</h2>' + donaInventario(r.inventario) + '</div>' +
    '</div>' +
    '<div class="grid-2">' +
    '<div class="tarjeta esc" style="--i:5"><h2>Entradas y salidas por día <small class="muted" style="font-weight:400">· últimos 30 días</small></h2>' + graficoDiario(r.por_dia) + '</div>' +
    '<div class="tarjeta esc" style="--i:6"><h2>Últimas hojas de ruta</h2><div class="ultimas">' + (r.ultimas_salidas.length ? r.ultimas_salidas.map((s, i) =>
      '<a class="ultima esc" style="--i:' + (i + 6) + '" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '"><span class="camion">' + ICO.camion + '</span>' +
      '<span><strong class="codigo">' + esc(s.hoja_ruta) + '</strong> ' + estadoChip(s.estado) + '<small>' + fmtFecha(s.fecha) + ' · ' + esc(mercadoCorto(s.mercado)) + ' → ' + esc(s.departamento) + '</small></span>' +
      '<strong class="num">' + fmtLb(s.libras) + '</strong></a>').join('') : '<p class="vacio">Todavía no hay salidas.</p>') + '</div></div>' +
    '</div>';
  animar();
}

/* ------------------------------------------------------------------ 2. Entradas */
function selectorCalidad(nombre) {
  return '<div class="selector-calidad" data-req-radio>' + [1, 2, 3].map(c =>
    '<label><input type="radio" name="' + nombre + '" value="' + c + '"><span class="q' + c + '">' + HOJA() + esc(calNombre(c)) + '</span></label>').join('') + '</div>';
}
function textoReferencia(ref, c) {
  if (!ref || !ref.precio) return 'Sin ventas previas de calidad <strong>' + esc(calNombre(c)) + '</strong>: no hay precio de referencia.';
  return 'Precio de referencia de <strong>' + esc(calNombre(c)) + '</strong>: <strong>' + fmtBs(ref.precio) + '</strong>/lb ' +
    (ref.es_hoy ? '(promedio de hoy)' : '(último día con ventas: ' + fmtFecha(ref.fecha) + ')') + '. El precio final lo acuerdan productor y comprador.';
}
async function vistaEntradas() {
  const esOp = SESION.rol === 'operador';
  const mercados = Object.keys(CONFIG.mercados);
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Entradas al galpón</h1><p class="sub">Registro de la hoja de coca que trae cada productor</p></div></div>' +
    pasos('entradas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva entrada</h2>' +
    '<label>Fecha y hora</label><div class="campo-fijo"><span id="reloj"></span> <small class="muted">· automáticas</small></div>' +
    '<label for="mercado">Mercado</label>' + (esOp ? '<div class="campo-fijo">' + esc(SESION.mercado) + '</div><input type="hidden" name="mercado" id="mercado" value="' + esc(SESION.mercado) + '">'
      : '<select name="mercado" id="mercado" data-req>' + opciones(mercados, mercados[0]) + '</select>') +
    '<label for="procedencia">Procedencia (provincia)</label><select name="procedencia" id="procedencia" data-req></select>' +
    '<label for="productor">Productor</label><input name="productor" id="productor" placeholder="Nombre completo" data-req>' +
    '<div class="fila"><div><label for="ci">CI del productor</label><input name="ci" id="ci" placeholder="1234567 o 1234567-1A" data-req></div>' +
    '<div><label for="telefono">Teléfono <small class="muted">(opcional)</small></label><input name="telefono" id="telefono" inputmode="tel" placeholder="71234567"></div></div>' +
    '<label>Calidad de la hoja</label>' + selectorCalidad('calidad') +
    '<div class="ref-precio" id="refPrecio">Elija la calidad para ver el precio de referencia del día.</div>' +
    '<div class="fila"><div><label for="taques">Taques</label><input type="number" name="taques" id="taques" min="0" step="0.5" value="1" data-req></div>' +
    '<div><label for="libras">Libras <button type="button" class="link-btn" id="recalc">recalcular</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" value="' + CONFIG.libras_por_taque + '" data-req></div></div>' +
    '<div class="ayuda" id="ayudaPeso"></div>' +
    '<label for="observacion">Observación</label><textarea name="observacion" id="observacion" placeholder="Opcional"></textarea>' +
    '<button class="btn ancho" type="submit">Registrar entrada</button><div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Entradas registradas <span class="contador" id="cnt"></span></h2>' + buscador('buscar', 'Buscar productor, CI, procedencia, Nº…') + '</div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  const reloj = document.getElementById('reloj');
  const tic = () => { if (!document.body.contains(reloj)) return clearInterval(tReloj); const d = new Date(); reloj.textContent = fmtFecha(isoLocal(d)) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const tReloj = setInterval(tic, 15000); tic();
  const selM = f.mercado, selP = f.procedencia, inT = f.taques, inL = f.libras;
  let librasEditadas = false;
  const llenarProc = () => { selP.innerHTML = opciones(CONFIG.mercados[selM.value] || [], null, '— Elija la procedencia —'); };
  const verificarPeso = () => {
    const t = parseFloat(inT.value) || 0, l = parseFloat(inL.value) || 0, esp = t * CONFIG.libras_por_taque;
    const a = document.getElementById('ayudaPeso');
    if (t > 0 && Math.abs(l - esp) > esp * CONFIG.tolerancia_peso) {
      a.className = 'ayuda alerta';
      a.textContent = '⚠ ' + fmtLb(l) + ' se aleja más del 20 % de lo esperado para ' + fmtTq(t) + ' taques (' + fmtLb(esp) + '). Verifique el peso.';
    } else {
      a.className = 'ayuda';
      a.textContent = '1 taque ≈ ' + fmtNum(CONFIG.libras_por_taque, 0) + ' lb (referencial). Esperado: ' + fmtLb(esp) + '. Puede corregir con el peso real.';
    }
  };
  const actualizarRef = async () => {
    const c = (f.querySelector('input[name=calidad]:checked') || {}).value;
    if (!c) return;
    const box = document.getElementById('refPrecio');
    try { box.innerHTML = textoReferencia(await api('/api/precio-referencia' + qsString({ calidad: c, mercado: selM.value })), c); }
    catch (e) { box.textContent = ''; }
  };
  const recalcular = () => { inL.value = (parseFloat(inT.value) || 0) * CONFIG.libras_por_taque; librasEditadas = false; verificarPeso(); };
  selM.onchange = () => { llenarProc(); actualizarRef(); };
  f.querySelectorAll('input[name=calidad]').forEach(r => { r.onchange = actualizarRef; });
  inT.oninput = () => { if (!librasEditadas) inL.value = (parseFloat(inT.value) || 0) * CONFIG.libras_por_taque; verificarPeso(); };
  inL.oninput = () => { librasEditadas = true; verificarPeso(); };
  document.getElementById('recalc').onclick = recalcular;
  llenarProc();
  verificarPeso();

  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const res = await api('/api/entradas', datosForm(f));
      toast('ok', res.mensaje, 'Ahora puede registrar su venta.');
      if (res.avisos.length) toast('aviso', 'Aviso de peso', res.avisos);
      msg.innerHTML = '<div class="mensaje ok"><strong>' + esc(res.mensaje) + '</strong><br><a href="#/ventas?entrada=' + res.id + '">Registrar una venta de esta entrada →</a></div>';
      ULTIMO_ID.entrada = res.id;
      ['productor', 'ci', 'telefono', 'observacion'].forEach(k => { f[k].value = ''; });
      f.taques.value = 1; recalcular();
      cargar();
    } catch (e) { sacudir(f); errorEn(e, msg); }
    finally { botonCargando(btn, false); }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/entradas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th>' + (esOp ? '' : '<th>Mercado</th>') + '<th>Productor</th><th>CI</th><th>Procedencia</th><th>Calidad</th>' +
      '<th class="num">Taques</th><th class="num">Libras</th><th class="num">Sin vender</th><th>Registró</th><th></th></tr></thead><tbody>' +
      filas.map((e, i) => '<tr' + filaAnim(i, e.id, 'entrada') + '><td>' + e.id + '</td><td>' + fmtFecha(e.fecha) + ' <small class="muted">' + esc(e.hora) + '</small></td>' +
        (esOp ? '' : '<td>' + esc(mercadoCorto(e.mercado)) + '</td>') +
        '<td>' + esc(e.productor) + (e.observacion ? ' <span title="' + esc(e.observacion) + '">📝</span>' : '') + (e.telefono ? '<br><small class="muted">☎ ' + esc(e.telefono) + '</small>' : '') + '</td><td>' + esc(e.ci) + '</td>' +
        '<td>' + esc(e.procedencia) + '</td><td>' + calChip(e.calidad) + '</td><td class="num">' + fmtTq(e.taques) + '</td><td class="num">' + fmtLb(e.libras) + '</td>' +
        '<td class="num"><span class="chip ' + (e.saldo > 0 ? '' : 'cero') + '">' + fmtLb(e.saldo) + '</span></td><td>' + quien(e) + '</td>' +
        '<td>' + (e.saldo > 0 ? '<a class="btn mini sec" href="#/ventas?entrada=' + e.id + '">Vender</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay entradas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 280);
  await cargar();
}

/* ------------------------------------------------------------------ 3. Ventas */
async function vistaVentas(partes, params) {
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Ventas</h1><p class="sub">El precio lo acuerdan el productor y el comprador; el sistema solo muestra una referencia</p></div></div>' +
    pasos('ventas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva venta</h2>' +
    '<label for="entrada_id">Entrada (lote) con saldo</label><select name="entrada_id" id="entrada_id" data-req><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div><div class="saldo-barra" id="saldoBarra" hidden><div style="width:0"></div></div>' +
    '<div class="ref-precio" id="refPrecio" hidden></div>' +
    '<label for="comprador">Comprador</label><input name="comprador" id="comprador" placeholder="Nombre completo" data-req>' +
    '<label for="ci_comprador">CI del comprador</label><input name="ci_comprador" id="ci_comprador" placeholder="Ej. 4567890" data-req>' +
    '<div class="fila"><div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo el saldo</button></label>' +
    '<input type="number" name="libras" id="libras" min="0" step="0.5" data-req></div>' +
    '<div><label for="precio_libra">Precio acordado (Bs/lb)</label><input type="number" name="precio_libra" id="precio_libra" min="0" step="0.5" data-req></div></div>' +
    '<div class="ayuda" id="avisoPrecio"></div>' +
    '<div class="total-vivo"><span>Total a pagar</span><strong id="total">Bs 0,00</strong></div>' +
    '<button class="btn ancho" type="submit">Registrar venta</button><div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Ventas registradas <span class="contador" id="cnt"></span></h2>' + buscador('buscar', 'Buscar comprador, CI, productor, Nº…') + '</div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  let entradas = [], ref = null;
  const sel = f.entrada_id, info = document.getElementById('saldoInfo'), barra = document.getElementById('saldoBarra');
  const totalEl = document.getElementById('total'), refBox = document.getElementById('refPrecio'), avisoP = document.getElementById('avisoPrecio');
  const actual = () => entradas.find(e => String(e.id) === sel.value);
  const actualizar = () => {
    const l = parseFloat(f.libras.value) || 0, p = parseFloat(f.precio_libra.value) || 0;
    const nuevo = fmtBs(l * p);
    if (totalEl.textContent !== nuevo) { totalEl.textContent = nuevo; totalEl.classList.add('pulso'); setTimeout(() => totalEl.classList.remove('pulso'), 150); }
    const e = actual();
    if (e) {
      barra.hidden = false;
      barra.classList.toggle('exceso', l > e.saldo);
      barra.firstChild.style.width = Math.min(100, l / e.saldo * 100) + '%';
      if (l > e.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ La cantidad supera el saldo: quedan ' + fmtLb(e.saldo) + ' sin vender.'; }
      else { info.className = 'ayuda'; info.innerHTML = calChip(e.calidad) + ' Quedan <strong>' + fmtLb(e.saldo) + '</strong> sin vender · ' + esc(e.procedencia) + ' · ' + esc(mercadoCorto(e.mercado)); }
    } else { barra.hidden = true; info.className = 'ayuda'; info.textContent = ''; }
    if (ref && ref.precio && p > 0) {
      const dif = (p - ref.precio) / ref.precio;
      if (Math.abs(dif) > CONFIG.tolerancia_precio) {
        avisoP.className = 'ayuda alerta';
        avisoP.textContent = '⚠ El precio está ' + fmtNum(Math.abs(dif) * 100, 0) + ' % ' + (dif > 0 ? 'por encima' : 'por debajo') + ' de la referencia (' + fmtBs(ref.precio) + '). Se registrará igual, con aviso.';
        return;
      }
    }
    avisoP.className = 'ayuda'; avisoP.textContent = '';
  };
  const elegir = async () => {
    const e = actual();
    ref = null; refBox.hidden = true;
    if (e) {
      try {
        ref = await api('/api/precio-referencia' + qsString({ calidad: e.calidad, mercado: e.mercado }));
        refBox.innerHTML = textoReferencia(ref, e.calidad); refBox.hidden = false;
        if (!f.precio_libra.value && ref.precio) f.precio_libra.value = Math.round(ref.precio * 2) / 2;
      } catch (err) { /* sin referencia */ }
    }
    actualizar();
  };
  async function cargarEntradas(preferida) {
    entradas = await api('/api/entradas?con_saldo=1');
    sel.innerHTML = '<option value="">— Elija una entrada (' + entradas.length + ' con saldo) —</option>' + entradas.map(e =>
      '<option value="' + e.id + '">Nº ' + e.id + ' · ' + fmtFecha(e.fecha) + ' · ' + esc(e.productor) + ' · ' + esc(calNombre(e.calidad)) + ' — quedan ' + fmtLb(e.saldo) + '</option>').join('');
    if (preferida && entradas.some(e => String(e.id) === String(preferida))) sel.value = preferida;
    await elegir();
  }
  sel.onchange = elegir;
  f.libras.oninput = actualizar;
  f.precio_libra.oninput = actualizar;
  document.getElementById('todo').onclick = () => { const e = actual(); if (e) { f.libras.value = e.saldo; actualizar(); } };

  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const res = await api('/api/ventas', datosForm(f));
      toast('ok', res.mensaje, 'Total: ' + fmtBs(res.total));
      if (res.avisos.length) toast('aviso', 'Precio fuera del rango habitual', res.avisos);
      msg.innerHTML = '<div class="mensaje ok"><strong>' + esc(res.mensaje) + '</strong> Total ' + fmtBs(res.total) + '<br><a href="#/salidas?venta=' + res.id + '">Despachar esta venta a un departamento →</a></div>';
      ULTIMO_ID.venta = res.id;
      ['comprador', 'ci_comprador', 'libras', 'precio_libra'].forEach(k => { f[k].value = ''; });
      await cargarEntradas(sel.value);
      cargar();
    } catch (e) { sacudir(f); errorEn(e, msg, 'Venta rechazada'); }
    finally { botonCargando(btn, false); }
  };

  const buscar = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/ventas' + qsString({ q: buscar.value.trim() }));
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Nº</th><th>Fecha</th><th>Entrada</th><th>Calidad</th><th>Comprador</th><th>CI</th><th class="num">Libras</th>' +
      '<th class="num">Precio/lb</th><th class="num">Total</th><th class="num">Sin despachar</th><th>Registró</th><th></th></tr></thead><tbody>' +
      filas.map((v, i) => '<tr' + filaAnim(i, v.id, 'venta') + '><td>' + v.id + '</td><td>' + fmtFecha(v.fecha) + ' <small class="muted">' + esc(v.hora) + '</small></td>' +
        '<td title="' + esc(v.productor + ' · ' + v.procedencia) + '">Nº ' + v.entrada_id + '</td><td>' + calChip(v.calidad) + '</td>' +
        '<td>' + esc(v.comprador) + '</td><td>' + esc(v.ci_comprador) + '</td><td class="num">' + fmtLb(v.libras) + '</td>' +
        '<td class="num">' + fmtBs(v.precio_libra) + '</td><td class="num">' + fmtBs(v.total) + '</td>' +
        '<td class="num"><span class="chip ' + (v.saldo > 0 ? 'ocre' : 'cero') + '">' + fmtLb(v.saldo) + '</span></td><td>' + quien(v) + '</td>' +
        '<td>' + (v.saldo > 0 ? '<a class="btn mini sec" href="#/salidas?venta=' + v.id + '">Despachar</a>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay ventas que coincidan con la búsqueda.</p>';
  }
  buscar.oninput = debounce(cargar, 280);
  await cargarEntradas(params.get('entrada'));
  await cargar();
}

/* ------------------------------------------------------------------ 4. Salidas */
async function vistaSalidas(partes, params) {
  $app.innerHTML = '<div class="vista">' +
    '<div class="encabezado"><div><h1>Salidas a departamentos</h1><p class="sub">Despacho de la coca vendida, con hoja de ruta y código QR</p></div></div>' +
    pasos('salidas') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nueva salida</h2>' +
    '<label for="venta_id">Venta con saldo en el galpón</label><select name="venta_id" id="venta_id" data-req><option value="">Cargando…</option></select>' +
    '<div class="ayuda" id="saldoInfo"></div><div class="saldo-barra" id="saldoBarra" hidden><div style="width:0"></div></div>' +
    '<div class="fila"><div><label for="departamento">Destino</label><select name="departamento" id="departamento" data-req>' + opciones(CONFIG.departamentos, null, '— Departamento —') + '</select></div>' +
    '<div><label for="libras">Libras <button type="button" class="link-btn" id="todo">todo</button></label><input type="number" name="libras" id="libras" min="0" step="0.5" data-req></div></div>' +
    '<label for="transportista">Transportista (quien lleva la coca)</label><input name="transportista" id="transportista" placeholder="Nombre completo" data-req>' +
    '<div class="fila"><div><label for="ci_transportista">CI del transportista</label><input name="ci_transportista" id="ci_transportista" placeholder="Ej. 3344556" data-req></div>' +
    '<div><label for="placa">Placa <small class="muted">(opcional)</small></label><input name="placa" id="placa" placeholder="2345ABC" maxlength="9" style="text-transform:uppercase"></div></div>' +
    '<div class="ayuda">La hoja de ruta tendrá un código único y vencerá en <strong>' + CONFIG.vigencia_horas + ' horas</strong>.</div>' +
    '<button class="btn ancho" type="submit">Registrar salida y emitir hoja de ruta</button><div id="msg"></div></form>' +
    '<div class="tarjeta"><div class="tarjeta-cab"><h2>Salidas registradas <span class="contador" id="cnt"></span></h2>' +
    '<select id="fDepto" style="max-width:220px">' + opciones(CONFIG.departamentos, null, 'Todos los destinos') + '</select></div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div>' +
    '</div></div>';

  const f = document.getElementById('form');
  quitarInvalido(f);
  const sel = f.venta_id, info = document.getElementById('saldoInfo'), barra = document.getElementById('saldoBarra');
  let ventas = [];
  const actual = () => ventas.find(v => String(v.id) === sel.value);
  const actualizar = () => {
    const v = actual(), l = parseFloat(f.libras.value) || 0;
    if (!v) { info.textContent = ''; info.className = 'ayuda'; barra.hidden = true; return; }
    barra.hidden = false;
    barra.classList.toggle('exceso', l > v.saldo);
    barra.firstChild.style.width = Math.min(100, l / v.saldo * 100) + '%';
    if (l > v.saldo) { info.className = 'ayuda alerta'; info.textContent = '⚠ Supera lo vendido que sigue en el galpón: ' + fmtLb(v.saldo) + '.'; }
    else { info.className = 'ayuda'; info.innerHTML = calChip(v.calidad) + ' Quedan <strong>' + fmtLb(v.saldo) + '</strong> por despachar · comprador ' + esc(v.comprador); }
  };
  const fDepto = document.getElementById('fDepto');
  async function cargar() {
    const filas = await api('/api/salidas' + qsString({ departamento: fDepto.value }));
    const tot = filas.reduce((s, x) => s + x.libras, 0);
    document.getElementById('cnt').textContent = '· ' + filas.length + (filas.length >= 500 ? '+' : '');
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Hoja de ruta</th><th>Estado</th><th>Emitida</th><th>Destino</th><th class="num">Libras</th><th>Transportista</th><th>Placa</th><th>Registró</th></tr></thead><tbody>' +
      filas.map((s, i) => '<tr' + filaAnim(i, s.id, 'salida') + '><td><a class="codigo" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '">' + esc(s.hoja_ruta) + '</a></td><td>' + estadoChip(s.estado) + '</td>' +
        '<td>' + fmtFH(s.emitida) + '</td><td><strong>' + esc(s.departamento) + '</strong></td><td class="num">' + fmtLb(s.libras) + '</td>' +
        '<td>' + esc(s.transportista) + '</td><td>' + esc(s.placa || '—') + '</td><td>' + quien(s) + '</td></tr>').join('') +
      '</tbody><tfoot><tr><td colspan="4">' + filas.length + ' salidas' + (filas.length >= 500 ? ' (últimas 500)' : '') + '</td><td class="num">' + fmtLb(tot) + '</td><td colspan="3"></td></tr></tfoot></table>'
      : '<p class="vacio">No hay salidas para este destino.</p>';
  }
  fDepto.onchange = cargar;
  ventas = await api('/api/ventas?con_saldo=1');
  sel.innerHTML = '<option value="">— Elija una venta (' + ventas.length + ' pendientes) —</option>' + ventas.map(v =>
    '<option value="' + v.id + '">Venta Nº ' + v.id + ' · ' + fmtFecha(v.fecha) + ' · ' + esc(v.comprador) + ' · ' + esc(calNombre(v.calidad)) + ' — quedan ' + fmtLb(v.saldo) + '</option>').join('');
  const pref = params.get('venta');
  if (pref && ventas.some(v => String(v.id) === pref)) { sel.value = pref; f.libras.value = actual().saldo; }
  sel.onchange = () => { const v = actual(); if (v) f.libras.value = v.saldo; actualizar(); };
  f.libras.oninput = actualizar;
  document.getElementById('todo').onclick = () => { const v = actual(); if (v) { f.libras.value = v.saldo; actualizar(); } };
  actualizar();
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const msg = document.getElementById('msg'), btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true, 'Emitiendo hoja de ruta…');
    try {
      const res = await api('/api/salidas', datosForm(f));
      toast('ok', 'Hoja de ruta emitida', res.hoja_ruta + ' · ' + f.departamento.value);
      location.hash = '#/hoja-ruta/' + encodeURIComponent(res.hoja_ruta);
    } catch (e) { sacudir(f); errorEn(e, msg, 'Salida rechazada'); botonCargando(btn, false); }
  };
  await cargar();
}

/* ------------------------------------------------------------------ anular hoja (solo administrador) */
function dialogoAnular(codigo, alTerminar) {
  modal('<h2>Anular hoja de ruta</h2><p class="muted">' + esc(codigo) + ' dejará de ser válida en los puestos de control. Esta acción queda en la bitácora.</p>' +
    '<form id="fAnular" novalidate><label for="motivo">Motivo (obligatorio)</label><textarea id="motivo" name="motivo" data-req placeholder="Ej. Error en la placa; se emitió una nueva hoja"></textarea>' +
    '<div id="mAnular"></div><div class="modal-acciones"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn peligro" type="submit">Anular hoja de ruta</button></div></form>',
  (caja, cerrar) => {
    const f = caja.querySelector('#fAnular');
    quitarInvalido(f);
    f.onsubmit = async ev => {
      ev.preventDefault();
      if (!requeridos(f)) return;
      const btn = f.querySelector('button[type=submit]');
      botonCargando(btn, true, 'Anulando…');
      try {
        const r = await api('/api/hojas/' + encodeURIComponent(codigo) + '/anular', { motivo: f.motivo.value });
        cerrar(); toast('ok', r.mensaje); alTerminar();
      } catch (e) { botonCargando(btn, false); sacudir(f); errorEn(e, caja.querySelector('#mAnular'), 'No se pudo anular'); }
    };
  });
}

/* ------------------------------------------------------------------ 5. Hoja de ruta */
async function vistaHojaRuta(partes) {
  const codigo = partes[1] || '';
  $app.innerHTML = '<div class="cargador"><div class="hoja-giro"></div><p>Cargando hoja de ruta…</p></div>';
  let h;
  try { h = await api('/api/hoja-ruta/' + encodeURIComponent(codigo)); }
  catch (e) {
    if (e.silencioso) return;
    $app.innerHTML = '<div class="verif-wrap"><div class="resultado invalida"><div class="sello-wrap"><span class="icono">✕</span><span class="sello">NO DISPONIBLE</span></div><p>' +
      esc((e.errores || [])[0]) + '</p><a class="btn sec" href="#/' + inicio() + '">Volver</a></div></div>';
    return;
  }
  const urlVerif = location.origin + '/#/verificar/' + h.hoja_ruta;
  const anulable = SESION.rol === 'admin' && h.estado !== 'ANULADA';
  $app.innerHTML =
    '<div class="acciones no-print"><button class="btn" id="imprimir">🖨 Imprimir</button>' +
    (ROLES_REGISTRO.includes(SESION.rol) ? '<a class="btn sec" href="#/salidas">Nueva salida</a>' : '<a class="btn sec" href="#/hojas">Lista de hojas</a>') +
    (anulable ? '<button class="btn peligro" id="anular">Anular</button>' : '') + '</div>' +
    '<article class="hoja' + (h.estado === 'ANULADA' ? ' anulada' : '') + '">' +
    '<span class="sello-emitida ' + h.estado + '">' + h.estado + '</span>' +
    '<div class="hoja-cab"><div><div class="inst">Sistema de Control de Comercialización de la Hoja de Coca</div>' +
    '<h1>HOJA DE RUTA</h1><div class="cod">' + esc(h.hoja_ruta) + '</div>' +
    '<div class="vigencia"><span>Emitida: <strong>' + fmtFH(h.emitida) + '</strong></span><span>Vence: <strong>' + fmtFH(h.vence) + '</strong></span></div>' +
    '<div class="ayuda">Mercado ' + esc(h.mercado) + '</div></div>' +
    '<div class="qr" id="qr"></div></div>' +
    (h.estado === 'ANULADA' ? '<div class="aviso-anulada">ANULADA el ' + fmtFH(h.anulada_en) + ' por ' + esc(h.anulada_por) + '. Motivo: ' + esc(h.motivo_anulacion) + '</div>' : '') +
    '<div class="destaque"><div><div class="etq">Departamento de destino</div><div class="grande">' + esc(h.departamento).toUpperCase() + '</div><div class="det">' + calChip(h.calidad) + '</div></div>' +
    '<div><div class="etq">Cantidad autorizada</div><div class="grande">' + fmtLb(h.libras) + '</div><div class="det">≈ ' + fmtTq(h.libras / CONFIG.libras_por_taque) + ' taques</div></div></div>' +
    '<div class="datos">' +
    '<section><h3>Transporte</h3><dl class="dl"><dt>Transportista</dt><dd>' + esc(h.transportista) + '</dd><dt>CI</dt><dd>' + esc(h.ci_transportista) + '</dd>' +
    '<dt>Placa</dt><dd>' + esc(h.placa || 'Sin vehículo registrado') + '</dd><dt>Comprador</dt><dd>' + esc(h.comprador) + '</dd><dt>CI comprador</dt><dd>' + esc(h.ci_comprador) + '</dd></dl></section>' +
    '<section><h3>Origen de la hoja</h3><dl class="dl"><dt>Mercado</dt><dd>' + esc(h.mercado) + '</dd><dt>Procedencia</dt><dd>' + esc(h.procedencia) + '</dd>' +
    '<dt>Calidad</dt><dd>' + esc(h.calidad_nombre) + '</dd><dt>Vendedor</dt><dd>' + esc(h.productor) + ' (CI ' + esc(h.ci_productor) + ')</dd>' +
    '<dt>Venta / entrada</dt><dd>Nº ' + h.venta_id + ' / Nº ' + h.entrada_id + '</dd></dl></section>' +
    '</div>' +
    '<p class="ayuda" style="margin:0">Registrado por: ' + esc(h.registrado_por || '—') + '</p>' +
    '<div class="firmas"><div>Responsable del galpón</div><div>Transportista</div><div>Control en ruta</div></div>' +
    '<div class="hoja-pie">La policía verifica este documento escaneando el código QR. Válido solo para el destino, la cantidad y el plazo indicados.</div>' +
    '</article>' +
    '<div class="tarjeta no-print" style="max-width:840px;margin:18px auto 0"><h2>Verificaciones en carretera <span class="contador">· ' + h.verificaciones + '</span></h2>' +
    (h.historial.length ? '<div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Fecha y hora</th><th>Controlador</th><th>Puesto</th><th>Resultado</th></tr></thead><tbody>' +
      h.historial.map(v => '<tr><td>' + fmtFH(v.fecha_hora) + '</td><td>' + esc(v.usuario) + '</td><td>' + esc(v.puesto || '—') + '</td><td>' + esc(v.resultado) + '</td></tr>').join('') + '</tbody></table></div>'
      : '<p class="vacio">Todavía no fue verificada en ningún puesto de control.</p>') + '</div>';
  document.getElementById('imprimir').onclick = () => window.print();
  if (anulable) document.getElementById('anular').onclick = () => dialogoAnular(h.hoja_ruta, () => vistaHojaRuta(partes));
  const qr = document.getElementById('qr');
  if (window.QRCode) {
    try { new QRCode(qr, { text: urlVerif, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); }
    catch (e) { qr.innerHTML = '<div class="qr-texto">' + esc(h.hoja_ruta) + '<br><br>' + esc(urlVerif) + '</div>'; }
  } else {
    qr.innerHTML = '<div class="qr-texto"><strong>Código:</strong><br>' + esc(h.hoja_ruta) + '<br><br>' + esc(urlVerif) + '<br><small>(QR no disponible sin internet)</small></div>';
  }
}

/* ------------------------------------------------------------------ 6. Verificar (tranca) */
async function vistaVerificar(partes) {
  const codigo = (partes[1] || '').toUpperCase();
  const puesto = leerLocal('puestoControl', '');
  $app.innerHTML = '<div class="vista tranca">' +
    '<div style="text-align:center"><h1>Verificar hoja de ruta</h1><p class="sub">Escanee el QR con la cámara del celular o escriba el código</p></div>' +
    '<form class="verif-form" id="form" autocomplete="off"><input id="codigo" placeholder="HR-' + new Date().getFullYear() + '-000001" value="' + esc(codigo) + '" aria-label="Código de hoja de ruta" autocapitalize="characters">' +
    '<input id="puesto" class="puesto" placeholder="Puesto de control (opcional), ej. Tranca Senkata" value="' + esc(puesto) + '" style="font-size:1rem;text-align:left;padding:12px">' +
    '<button class="btn btn-grande" type="submit">' + ICO.escudo + ' Verificar</button></form><div id="res"></div></div>';
  const f = document.getElementById('form'), inp = document.getElementById('codigo'), inPuesto = document.getElementById('puesto');
  inPuesto.onchange = () => guardarLocal('puestoControl', inPuesto.value.trim());
  f.onsubmit = ev => {
    ev.preventDefault();
    const c = inp.value.trim().toUpperCase();
    if (!c) { sacudir(f); inp.focus(); return; }
    guardarLocal('puestoControl', inPuesto.value.trim());
    if ('#/verificar/' + encodeURIComponent(c) === location.hash) enrutar(); else location.hash = '#/verificar/' + encodeURIComponent(c);
  };
  if (!codigo) { inp.focus(); return; }
  const res = document.getElementById('res');
  res.innerHTML = '<div class="escaner">Verificando ' + esc(codigo) + '…</div>';
  const [r] = await Promise.allSettled([api('/api/verificar', { codigo, puesto: inPuesto.value.trim() }), espera(MOVIMIENTO ? 700 : 0)]);
  if (r.status !== 'fulfilled') {
    if (r.reason && r.reason.silencioso) return;
    res.innerHTML = '<div class="mensaje error">' + esc(((r.reason || {}).errores || ['Error']).join(' ')) + '</div>';
    return;
  }
  const v = r.value, h = v.hoja;
  const titulo = v.valida ? 'HOJA DE RUTA VÁLIDA' : 'NO VÁLIDA';
  res.innerHTML = '<div class="resultado grande ' + (v.valida ? 'valida' : 'invalida') + '">' +
    '<div class="sello-wrap"><span class="icono">' + (v.valida ? '✓' : '✕') + '</span><span class="sello">' + titulo + '</span></div>' +
    '<p class="motivo">' + esc(v.motivo) + '</p>' +
    (h ? '<div class="cifras-tranca"><div><small>Destino</small><strong>' + esc(h.departamento) + '</strong></div><div><small>Cantidad</small><strong>' + fmtLb(h.libras) + '</strong></div></div>' +
      '<dl class="dl"><dt>Código</dt><dd class="codigo">' + esc(h.hoja_ruta) + ' ' + estadoChip(h.estado) + '</dd>' +
      '<dt>Calidad</dt><dd>' + calChip(h.calidad) + '</dd>' +
      '<dt>Transportista</dt><dd>' + esc(h.transportista) + ' · CI ' + esc(h.ci_transportista) + '</dd>' +
      '<dt>Placa</dt><dd style="font-size:1.2rem">' + esc(h.placa || 'Sin vehículo registrado') + '</dd>' +
      '<dt>Comprador</dt><dd>' + esc(h.comprador) + '</dd>' +
      '<dt>Origen</dt><dd>' + esc(h.mercado) + ' · ' + esc(h.procedencia) + '</dd>' +
      '<dt>Emitida</dt><dd>' + fmtFH(h.emitida) + '</dd><dt>Vence</dt><dd>' + fmtFH(h.vence) + '</dd>' +
      (h.estado === 'ANULADA' ? '<dt>Motivo de anulación</dt><dd>' + esc(h.motivo_anulacion) + '</dd>' : '') +
      '<dt>Verificaciones</dt><dd>' + h.verificaciones + '</dd></dl>' : '') +
    '<p style="margin:16px 0 0"><a class="btn sec btn-grande" href="#/verificar">Verificar otra hoja de ruta</a></p></div>';
  if (navigator.vibrate && MOVIMIENTO) navigator.vibrate(v.valida ? 80 : [120, 60, 120]);
}

/* ------------------------------------------------------------------ 7. Reportes */
async function vistaReportes() {
  let filtros = null;
  try { filtros = JSON.parse(leerSesion('filtrosRep', 'null')); } catch (e) { filtros = null; }
  if (!filtros) { const d = new Date(); d.setDate(d.getDate() - 59); filtros = { desde: isoLocal(d), hasta: hoyISO(), mercado: '', calidad: '' }; }
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Reportes</h1><p class="sub">Movimiento por departamento, calidad, mes y procedencia; hojas de ruta y verificaciones</p></div>' +
    '<form class="tarjeta filtros" id="form" style="margin-bottom:18px">' +
    '<div><label for="desde">Desde</label><input type="date" id="desde" value="' + filtros.desde + '"></div>' +
    '<div><label for="hasta">Hasta</label><input type="date" id="hasta" value="' + filtros.hasta + '"></div>' +
    '<div style="min-width:200px"><label for="fMercado">Mercado</label>' + selectorMercado('fMercado', filtros.mercado) + '</div>' +
    '<div><label for="fCal">Calidad</label><select id="fCal"><option value="">Todas</option>' + [1, 2, 3].map(c => '<option value="' + c + '"' + (String(filtros.calidad) === String(c) ? ' selected' : '') + '>' + esc(calNombre(c)) + '</option>').join('') + '</select></div>' +
    '<button class="btn" type="submit">Aplicar</button><span style="flex:1"></span>' +
    '<a class="btn ocre mini" id="csvDep">⬇ Departamentos</a><a class="btn ocre mini" id="csvCal">⬇ Calidad</a><a class="btn ocre mini" id="csvSal">⬇ Salidas</a>' +
    '</form><div id="rep">' + esqueleto(110) + '<br>' + esqueleto(360) + '</div></div>';
  const f = document.getElementById('form');
  f.onsubmit = ev => {
    ev.preventDefault();
    guardarSesion('filtrosRep', JSON.stringify({ desde: f.desde.value, hasta: f.hasta.value, mercado: document.getElementById('fMercado').value, calidad: document.getElementById('fCal').value }));
    vistaReportes();
  };
  const q = qsString(filtros);
  document.getElementById('csvDep').href = '/api/exportar/departamentos.csv' + q;
  document.getElementById('csvCal').href = '/api/exportar/calidad.csv' + q;
  document.getElementById('csvSal').href = '/api/exportar/salidas.csv' + q;

  const r = await api('/api/resumen' + q);
  const totS = r.salidas.libras, tot = { e: 0, v: 0, s: 0, m: 0, h: 0 };
  r.por_mes.forEach(m => { tot.e += m.entradas_lb; tot.v += m.ventas_lb; tot.s += m.salidas_lb; tot.m += m.monto; tot.h += m.hojas_ruta; });
  const vr = r.verificaciones.por_resultado;
  const fila = (i, celdas) => '<tr class="fila-anim" style="--i:' + i + '">' + celdas + '</tr>';
  document.getElementById('rep').innerHTML =
    '<div class="kpis">' +
    kpi('Entradas', r.entradas.libras, 'lb', fmtNum(r.entradas.cantidad, 0) + ' ingresos', 'entrada', '', 0) +
    kpi('Ventas', r.ventas.libras, 'lb', fmtBs(r.ventas.monto), 'venta', '', 1) +
    kpi('Salidas', totS, 'lb', fmtNum(r.salidas.hojas_ruta, 0) + ' hojas de ruta', 'camion', '', 2) +
    kpi('Precio promedio', r.precio_promedio, 'bs', 'por libra', 'precio', 'ocre', 3) +
    kpi('Verificaciones', r.verificaciones.total, 'n', fmtNum(vr.VALIDA || 0, 0) + ' válidas · ' + fmtNum((r.verificaciones.total || 0) - (vr.VALIDA || 0), 0) + ' rechazadas', 'qr', 'ocre', 4) +
    '</div>' +
    '<div class="grid-iguales">' +
    '<div class="tarjeta esc" style="--i:2"><h2>Salidas por departamento</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Departamento</th><th class="num">Libras</th><th class="num">Hojas</th><th class="num">%</th></tr></thead><tbody>' +
    r.por_departamento.map((d, i) => fila(i, '<td>' + esc(d.departamento) + '</td><td class="num">' + fmtLb(d.libras) + '</td><td class="num">' + d.hojas_ruta + '</td><td class="num">' + fmtPct(d.porcentaje) + '</td>')).join('') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(totS) + '</td><td class="num">' + r.salidas.hojas_ruta + '</td><td class="num">' + (totS ? '100 %' : '0 %') + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta esc" style="--i:3"><h2>Distribución por departamento</h2>' + barrasDepartamentos(r.por_departamento) + '</div></div>' +
    '<div class="grid-iguales">' +
    '<div class="tarjeta esc" style="--i:4"><h2>Libras por calidad</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Calidad</th><th class="num">Entradas</th><th class="num">Vendidas</th><th class="num">Monto</th><th class="num">Precio prom.</th></tr></thead><tbody>' +
    r.por_calidad.map((c, i) => fila(i, '<td>' + calChip(c.calidad) + '</td><td class="num">' + fmtLb(c.entradas_lb) + '</td><td class="num">' + fmtLb(c.ventas_lb) + '</td><td class="num">' + fmtBs(c.monto) + '</td><td class="num">' + (c.precio_promedio ? fmtBs(c.precio_promedio) : '—') + '</td>')).join('') +
    '</tbody></table></div><div style="margin-top:14px">' + barras(r.por_calidad.map(c => Object.assign({}, c, { nombre: calNombre(c.calidad) })), 'nombre', 'ventas_lb', fmtLb) + '</div></div>' +
    '<div class="tarjeta esc" style="--i:5"><h2>Precio promedio diario por calidad <small class="muted" style="font-weight:400">· 30 días</small></h2>' + graficoPrecios(r.por_dia) + '</div></div>' +
    '<div class="grid-iguales">' +
    '<div class="tarjeta esc" style="--i:6"><h2>Hojas de ruta por estado</h2><div class="tiles-estado">' +
    ['VIGENTE', 'VENCIDA', 'ANULADA'].map(e => '<a class="tile ' + e + '" href="#/hojas?estado=' + e + '" style="text-decoration:none"><strong data-contar="' + r.hojas_estado[e] + '" data-fmt="n">0</strong>' + mayus(e.toLowerCase()) + 's</a>').join('') + '</div>' +
    '<h3 style="margin-top:18px">Verificaciones por resultado</h3><div class="tiles-estado">' +
    [['VALIDA', 'VIGENTE', 'Válidas'], ['VENCIDA', 'VENCIDA', 'Vencidas'], ['ANULADA', 'ANULADA', 'Anuladas']].map(x => '<div class="tile ' + x[1] + '"><strong>' + fmtNum(vr[x[0]] || 0, 0) + '</strong>' + x[2] + '</div>').join('') + '</div>' +
    '<p class="muted" style="font-size:.82rem">Códigos inexistentes presentados en trancas: <strong>' + fmtNum(vr.NO_EXISTE || 0, 0) + '</strong></p></div>' +
    '<div class="tarjeta esc" style="--i:7"><h2>Últimas verificaciones</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Fecha</th><th>Código</th><th>Puesto</th><th>Resultado</th></tr></thead><tbody>' +
    (r.verificaciones.ultimas.length ? r.verificaciones.ultimas.map((v, i) => fila(i, '<td>' + fmtFH(v.fecha_hora) + '</td><td class="codigo">' + esc(v.codigo) + '</td><td>' + esc(v.puesto || '—') + '</td><td><span class="estado ' + ({ VALIDA: 'VIGENTE', NO_EXISTE: 'ANULADA' }[v.resultado] || v.resultado) + '">' + esc(v.resultado.replace('_', ' ')) + '</span></td>')).join('')
      : '<tr><td colspan="4" class="vacio">Sin verificaciones en el período.</td></tr>') + '</tbody></table></div></div></div>' +
    '<div class="tarjeta esc" style="--i:8;margin-bottom:18px"><h2>Movimiento por mes</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mes</th><th class="num">Entradas</th><th class="num">Ventas</th><th class="num">Salidas</th><th class="num">Hojas de ruta</th><th class="num">Monto vendido</th></tr></thead><tbody>' +
    (r.por_mes.length ? r.por_mes.map((m, i) => fila(i, '<td>' + fmtMes(m.mes) + '</td><td class="num">' + fmtLb(m.entradas_lb) + '</td><td class="num">' + fmtLb(m.ventas_lb) + '</td><td class="num">' + fmtLb(m.salidas_lb) + '</td><td class="num">' + m.hojas_ruta + '</td><td class="num">' + fmtBs(m.monto) + '</td>')).join('')
      : '<tr><td colspan="6" class="vacio">Sin movimientos en el período.</td></tr>') +
    '</tbody><tfoot><tr><td>Total</td><td class="num">' + fmtLb(tot.e) + '</td><td class="num">' + fmtLb(tot.v) + '</td><td class="num">' + fmtLb(tot.s) + '</td><td class="num">' + tot.h + '</td><td class="num">' + fmtBs(tot.m) + '</td></tr></tfoot></table></div></div>' +
    '<div class="tarjeta esc" style="--i:9"><h2>Entradas por procedencia</h2><div class="tabla-box" style="margin-top:0"><table><thead><tr><th>Mercado</th><th>Procedencia</th><th class="num">Ingresos</th><th class="num">Taques</th><th class="num">Libras</th><th class="num">%</th></tr></thead><tbody>' +
    (r.por_procedencia.length ? r.por_procedencia.map((p, i) => fila(i, '<td>' + esc(p.mercado) + '</td><td>' + esc(p.procedencia) + '</td><td class="num">' + p.entradas + '</td><td class="num">' + fmtTq(p.taques) + '</td><td class="num">' + fmtLb(p.libras) + '</td><td class="num">' + fmtPct(p.porcentaje) + '</td>')).join('')
      : '<tr><td colspan="6" class="vacio">Sin entradas en el período.</td></tr>') + '</tbody></table></div></div>';
  animar();
}

/* ------------------------------------------------------------------ 8. Hojas de ruta (lista) */
async function vistaHojas(partes, params) {
  const esAdmin = SESION.rol === 'admin';
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Hojas de ruta</h1><p class="sub">Estado de cada hoja, verificaciones en carretera' + (esAdmin ? ' y anulación' : '') + '</p></div>' +
    '<div class="tarjeta"><div class="filtros" style="margin-bottom:6px">' +
    '<div><label for="fEstado">Estado</label><select id="fEstado"><option value="">Todos</option>' + ['VIGENTE', 'VENCIDA', 'ANULADA'].map(e => '<option' + (params.get('estado') === e ? ' selected' : '') + '>' + e + '</option>').join('') + '</select></div>' +
    '<div style="flex:1;min-width:220px"><label for="buscar">Buscar</label>' + buscador('buscar', 'Código, placa, transportista o comprador') + '</div></div>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div></div>';
  const fE = document.getElementById('fEstado'), b = document.getElementById('buscar');
  async function cargar() {
    const filas = await api('/api/hojas' + qsString({ estado: fE.value, q: b.value.trim() }));
    document.getElementById('tabla').innerHTML = filas.length ?
      '<table><thead><tr><th>Código</th><th>Estado</th><th>Emitida</th><th>Vence</th><th>Mercado</th><th>Destino</th><th class="num">Libras</th><th>Transportista</th><th>Placa</th><th class="num">Verif.</th><th></th></tr></thead><tbody>' +
      filas.map((s, i) => '<tr' + filaAnim(i, s.id, 'hoja') + '><td><a class="codigo" href="#/hoja-ruta/' + esc(s.hoja_ruta) + '">' + esc(s.hoja_ruta) + '</a></td><td>' + estadoChip(s.estado) + '</td>' +
        '<td>' + fmtFH(s.emitida) + '</td><td>' + fmtFH(s.vence) + '</td><td>' + esc(mercadoCorto(s.mercado)) + '</td><td>' + esc(s.departamento) + '</td><td class="num">' + fmtLb(s.libras) + '</td>' +
        '<td>' + esc(s.transportista) + '</td><td>' + esc(s.placa || '—') + '</td><td class="num">' + s.verificaciones + '</td>' +
        '<td>' + (esAdmin && s.estado !== 'ANULADA' ? '<button class="btn mini peligro" data-anular="' + esc(s.hoja_ruta) + '">Anular</button>' : '') + '</td></tr>').join('') +
      '</tbody></table>' : '<p class="vacio">No hay hojas de ruta con ese filtro.</p>';
    document.querySelectorAll('[data-anular]').forEach(btn => { btn.onclick = () => dialogoAnular(btn.dataset.anular, cargar); });
  }
  fE.onchange = cargar;
  b.oninput = debounce(cargar, 280);
  await cargar();
}

/* ------------------------------------------------------------------ 9. Administración */
const pestanasAdmin = actual => '<nav class="pasos" style="max-width:560px">' +
  [['usuarios', 'Usuarios'], ['bitacora', 'Bitácora'], ['configuracion', 'Configuración']].map(([r, t]) =>
    '<a href="#/' + r + '" class="' + (r === actual ? 'activo' : '') + '"><span class="txt" style="display:inline">' + t + '</span></a>').join('') + '</nav>';
const opcionesRol = sel => Object.keys(CONFIG.roles).map(r => '<option value="' + r + '"' + (r === sel ? ' selected' : '') + '>' + esc(CONFIG.roles[r]) + '</option>').join('');
function camposUsuario(u) {
  u = u || { rol: 'operador' };
  return '<label for="u_nombre">Nombre completo</label><input id="u_nombre" name="nombre" value="' + esc(u.nombre || '') + '" data-req>' +
    '<div class="fila"><div><label for="u_rol">Rol</label><select id="u_rol" name="rol">' + opcionesRol(u.rol) + '</select></div>' +
    '<div class="campo-mercado"><label for="u_mercado">Mercado</label><select id="u_mercado" name="mercado">' + opciones(Object.keys(CONFIG.mercados), u.mercado, '— Elija —') + '</select></div></div>' +
    '<div class="ayuda" id="u_ayuda"></div>';
}
const AYUDA_ROL = {
  admin: 'Gerente: todo, más usuarios, bitácora, configuración y anular hojas de ruta.',
  operador: 'Registra entradas, ventas y salidas solo de su mercado.',
  supervisor: 'Ve panel y reportes de todos los mercados y descarga Excel. No registra.',
  controlador: 'Policía en la tranca: solo verifica hojas de ruta.',
};
function enlazarRol(raiz) {
  const r = raiz.querySelector('[name=rol]'), m = raiz.querySelector('.campo-mercado'), a = raiz.querySelector('#u_ayuda');
  const act = () => { m.style.visibility = r.value === 'operador' ? 'visible' : 'hidden'; a.textContent = AYUDA_ROL[r.value]; };
  r.onchange = act; act();
}
async function vistaUsuarios() {
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Administración</h1><p class="sub">Personal autorizado. Productores y compradores no tienen cuenta.</p></div>' + pestanasAdmin('usuarios') +
    '<div class="grid-form">' +
    '<form class="tarjeta" id="form" autocomplete="off" novalidate><h2>Nuevo usuario</h2>' + camposUsuario() +
    '<label for="u_usuario">Usuario</label><input id="u_usuario" name="usuario" placeholder="ej. jmamani" data-req autocapitalize="off">' +
    '<label for="u_clave">Contraseña temporal</label><input id="u_clave" name="clave" data-req>' +
    '<div class="ayuda">Deberá cambiarla en su primer ingreso.</div>' +
    '<button class="btn ancho" type="submit">Crear usuario</button><div id="msg"></div></form>' +
    '<div class="tarjeta"><h2>Usuarios registrados</h2><div class="tabla-box" id="tabla">' + esqueleto(300) + '</div></div></div></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  enlazarRol(f);
  f.clave.value = claveAleatoria();
  async function cargar() {
    const us = await api('/api/usuarios');
    document.getElementById('tabla').innerHTML = '<table><thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Mercado</th><th>Estado</th><th></th></tr></thead><tbody>' +
      us.map((u, i) => '<tr class="fila-anim' + (ULTIMO_ID.usuario === u.id ? ' nuevo' : '') + '" style="--i:' + i + '"><td><span class="avatar" style="display:inline-grid;width:26px;height:26px;font-size:.72rem;vertical-align:middle;margin-right:6px">' + esc(iniciales(u.nombre)) + '</span>@' + esc(u.usuario) + '</td>' +
        '<td>' + esc(u.nombre) + '</td><td><span class="rol ' + (u.rol === 'admin' ? 'admin' : '') + '">' + esc(u.rol_nombre) + '</span></td><td>' + esc(u.mercado ? mercadoCorto(u.mercado) : '—') + '</td>' +
        '<td>' + (u.activo ? (u.bloqueado ? '<span class="chip rojo">Bloqueado</span>' : u.debe_cambiar ? '<span class="chip ocre">Clave temporal</span>' : '<span class="chip">Activo</span>') : '<span class="chip cero">Inactivo</span>') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn mini sec" data-editar="' + u.id + '">Editar</button> <button class="btn mini sec" data-clave="' + u.id + '">Restablecer clave</button></td></tr>').join('') + '</tbody></table>';
    document.querySelectorAll('[data-editar]').forEach(b => { b.onclick = () => editar(us.find(u => u.id === Number(b.dataset.editar))); });
    document.querySelectorAll('[data-clave]').forEach(b => { b.onclick = () => restablecer(us.find(u => u.id === Number(b.dataset.clave))); });
  }
  function editar(u) {
    modal('<h2>Editar @' + esc(u.usuario) + '</h2><form id="fEd" novalidate>' + camposUsuario(u) +
      '<label style="display:flex;align-items:center;gap:10px;margin-top:16px"><span class="interruptor"><input type="checkbox" name="activo"' + (u.activo ? ' checked' : '') + (u.id === SESION.id ? ' disabled' : '') + '><span></span></span> Usuario activo</label>' +
      '<div id="mEd"></div><div class="modal-acciones"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Guardar cambios</button></div></form>',
    (caja, cerrar) => {
      const fe = caja.querySelector('#fEd');
      enlazarRol(fe);
      quitarInvalido(fe);
      fe.onsubmit = async ev => {
        ev.preventDefault();
        if (!requeridos(fe)) return;
        try {
          const r = await api('/api/usuarios/' + u.id, { nombre: fe.nombre.value, rol: fe.rol.value, mercado: fe.mercado.value, activo: u.id === SESION.id ? true : fe.activo.checked });
          cerrar(); toast('ok', r.mensaje); cargar();
        } catch (e) { sacudir(fe); errorEn(e, caja.querySelector('#mEd'), 'No se pudo guardar'); }
      };
    });
  }
  function restablecer(u) {
    const temporal = claveAleatoria();
    modal('<h2>Restablecer contraseña</h2><p>@' + esc(u.usuario) + ' · ' + esc(u.nombre) + '</p><form id="fCl" novalidate><label for="nclave">Contraseña temporal</label><input id="nclave" name="clave" value="' + temporal + '" data-req>' +
      '<div class="ayuda">Entréguela al usuario; deberá cambiarla al ingresar. Sus sesiones abiertas se cerrarán.</div><div id="mCl"></div>' +
      '<div class="modal-acciones"><button type="button" class="btn sec" data-cerrar>Cancelar</button><button class="btn" type="submit">Restablecer</button></div></form>',
    (caja, cerrar) => {
      const fc = caja.querySelector('#fCl');
      fc.onsubmit = async ev => {
        ev.preventDefault();
        try { const r = await api('/api/usuarios/' + u.id + '/clave', { clave: fc.clave.value }); cerrar(); toast('ok', r.mensaje, 'Contraseña temporal: ' + fc.clave.value, 9000); cargar(); }
        catch (e) { errorEn(e, caja.querySelector('#mCl'), 'No se pudo restablecer'); }
      };
    });
  }
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]'), msg = document.getElementById('msg'), datos = datosForm(f);
    botonCargando(btn, true);
    try {
      const r = await api('/api/usuarios', datos);
      ULTIMO_ID.usuario = r.id;
      toast('ok', r.mensaje);
      msg.innerHTML = '<div class="mensaje ok"><strong>Entregue estos datos:</strong><br>usuario <code>' + esc(datos.usuario) + '</code> · contraseña temporal <code>' + esc(datos.clave) + '</code></div>';
      f.nombre.value = ''; f.usuario.value = ''; f.clave.value = claveAleatoria();
      cargar();
    } catch (e) { sacudir(f); errorEn(e, msg, 'No se pudo crear'); }
    finally { botonCargando(btn, false); }
  };
  await cargar();
}

async function vistaBitacora() {
  const hoy = new Date(), hace = new Date(); hace.setDate(hace.getDate() - 7);
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Administración</h1><p class="sub">Bitácora: quién hizo qué y cuándo</p></div>' + pestanasAdmin('bitacora') +
    '<div class="tarjeta"><form class="filtros" id="form">' +
    '<div><label for="bU">Usuario</label><select id="bU"><option value="">Todos</option></select></div>' +
    '<div><label for="bA">Acción</label><select id="bA"><option value="">Todas</option></select></div>' +
    '<div><label for="bD">Desde</label><input type="date" id="bD" value="' + isoLocal(hace) + '"></div>' +
    '<div><label for="bH">Hasta</label><input type="date" id="bH" value="' + isoLocal(hoy) + '"></div>' +
    '<button class="btn" type="submit">Filtrar</button></form>' +
    '<div class="tabla-box" id="tabla">' + esqueleto(400) + '</div></div></div>';
  const f = document.getElementById('form');
  let primera = true;
  async function cargar() {
    const r = await api('/api/bitacora' + qsString({ usuario: f.bU.value, accion: f.bA.value, desde: f.bD.value, hasta: f.bH.value }));
    if (primera) {
      f.bU.innerHTML = '<option value="">Todos</option>' + r.usuarios.map(u => '<option>' + esc(u) + '</option>').join('');
      f.bA.innerHTML = '<option value="">Todas</option>' + r.acciones.map(a => '<option>' + esc(a) + '</option>').join('');
      primera = false;
    }
    document.getElementById('tabla').innerHTML = r.registros.length ?
      '<table><thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Detalle</th><th>IP</th></tr></thead><tbody>' +
      r.registros.map((x, i) => '<tr' + (i < 40 ? ' class="fila-anim" style="--i:' + i + '"' : '') + '><td style="white-space:nowrap">' + fmtFH(x.fecha_hora) + '</td><td>' + esc(x.usuario || '—') + '</td>' +
        '<td><span class="bitacora-accion ' + esc(x.accion) + '">' + esc(x.accion) + '</span></td><td>' + esc(x.detalle) + '</td><td><small class="muted">' + esc(x.ip) + '</small></td></tr>').join('') +
      '</tbody></table>' + (r.registros.length >= 500 ? '<p class="muted" style="padding:8px">Se muestran los últimos 500 registros.</p>' : '')
      : '<p class="vacio">Sin registros con esos filtros.</p>';
  }
  f.onsubmit = ev => { ev.preventDefault(); cargar(); };
  await cargar();
}

async function vistaConfiguracion() {
  const cfg = await api('/api/config');
  $app.innerHTML = '<div class="vista">' +
    '<div><h1>Administración</h1><p class="sub">Configuración general del sistema</p></div>' + pestanasAdmin('configuracion') +
    '<form class="tarjeta" id="form" novalidate style="max-width:560px"><h2>Calidades de la hoja</h2>' +
    [1, 2, 3].map(c => '<label for="c' + c + '">Calidad ' + c + '</label><input id="c' + c + '" value="' + esc(cfg.calidades[String(c)]) + '" maxlength="30" data-req>').join('') +
    '<h2 style="margin-top:22px">Referencias</h2>' +
    '<div class="fila"><div><label for="lpt">Libras por taque</label><input id="lpt" type="number" min="1" step="0.5" value="' + cfg.libras_por_taque + '" data-req></div>' +
    '<div><label for="vig">Vigencia de la hoja de ruta (horas)</label><input id="vig" type="number" min="1" max="720" value="' + cfg.vigencia_horas + '" data-req></div></div>' +
    '<div class="ayuda">Los cambios aplican a los registros nuevos. Las hojas ya emitidas conservan su vencimiento.</div>' +
    '<button class="btn ancho" type="submit">Guardar configuración</button><div id="msg"></div></form></div>';
  const f = document.getElementById('form');
  quitarInvalido(f);
  f.onsubmit = async ev => {
    ev.preventDefault();
    if (!requeridos(f)) return;
    const btn = f.querySelector('button[type=submit]');
    botonCargando(btn, true);
    try {
      const r = await api('/api/config', { calidades: [f.c1.value, f.c2.value, f.c3.value], libras_por_taque: f.lpt.value, vigencia_horas: f.vig.value });
      CONFIG = await api('/api/config');
      toast('ok', r.mensaje);
      document.getElementById('msg').innerHTML = '';
    } catch (e) { sacudir(f); errorEn(e, document.getElementById('msg'), 'No se pudo guardar'); }
    finally { botonCargando(btn, false); }
  };
}

/* ------------------------------------------------------------------ enrutador */
const VISTAS = {
  '': { roles: ROLES_PANEL, fn: vistaPanel },
  'entradas': { roles: ROLES_REGISTRO, fn: vistaEntradas },
  'ventas': { roles: ROLES_REGISTRO, fn: vistaVentas },
  'salidas': { roles: ROLES_REGISTRO, fn: vistaSalidas },
  'hoja-ruta': { roles: ['admin', 'operador', 'supervisor'], fn: vistaHojaRuta },
  'hojas': { roles: ['admin', 'supervisor'], fn: vistaHojas },
  'verificar': { roles: ['admin', 'controlador'], fn: vistaVerificar },
  'reportes': { roles: ['admin', 'supervisor'], fn: vistaReportes },
  'usuarios': { roles: ['admin'], fn: vistaUsuarios },
  'bitacora': { roles: ['admin'], fn: vistaBitacora },
  'configuracion': { roles: ['admin'], fn: vistaConfiguracion },
  'cuenta': { roles: ['admin', 'operador', 'supervisor', 'controlador'], fn: p => vistaClave(p, false) },
};
const MENU_ACTIVO = { 'hoja-ruta': 'salidas', 'bitacora': 'usuarios', 'configuracion': 'usuarios' };

async function enrutar() {
  const h = location.hash.replace(/^#\/?/, '');
  const [ruta, query] = h.split('?');
  const partes = ruta.split('/').map(p => { try { return decodeURIComponent(p); } catch (e) { return p; } });
  const params = new URLSearchParams(query || '');
  document.getElementById('modal').hidden = true;
  document.getElementById('menu').classList.remove('abierto');
  document.getElementById('menuBtn').setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  try {
    // Página pública: se ve sin iniciar sesión (y el personal también puede abrirla en #/inicio)
    if (partes[0] === 'inicio' || (!SESION && partes[0] === '')) {
      pintarBarra('publico');
      await vistaPublica(params);
      return;
    }
    if (!SESION) {
      pintarBarra();
      if (partes[0] !== 'login') { location.replace('#/login' + (h ? '?volver=' + encodeURIComponent(h) : '')); return; }
      await vistaLogin(params);
      return;
    }
    if (partes[0] === 'login') { location.replace('#/' + inicio()); return; }
    if (SESION.debe_cambiar && partes[0] !== 'cambiar-clave') { location.replace('#/cambiar-clave?volver=' + encodeURIComponent(h)); return; }
    pintarBarra();
    if (partes[0] === 'cambiar-clave') { await vistaClave(params, SESION.debe_cambiar); return; }
    const v = VISTAS[partes[0]];
    if (!v) { $app.innerHTML = '<div class="vista"><h1>Página no encontrada</h1><p><a href="#/' + inicio() + '">Volver al inicio</a></p></div>'; return; }
    if (!v.roles.includes(SESION.rol)) {
      if (partes[0] !== '') toast('aviso', 'Sin acceso', 'Su rol (' + SESION.rol_nombre + ') no puede usar esta sección.');
      location.replace('#/' + inicio());
      return;
    }
    const activo = MENU_ACTIVO[partes[0]] !== undefined ? MENU_ACTIVO[partes[0]] : partes[0];
    document.querySelectorAll('#menu > a').forEach(a => a.classList.toggle('activo', a.dataset.r === activo));
    await v.fn(partes, params);
  } catch (e) {
    if (e && e.silencioso) return;
    $app.innerHTML = '<div class="mensaje error"><strong>Error:</strong> ' + esc((e && e.errores) ? e.errores.join(' ') : String(e)) +
      ' <button class="btn mini sec" onclick="enrutar()">Reintentar</button></div>';
  }
}

async function iniciar() {
  const btn = document.getElementById('menuBtn');
  btn.onclick = () => {
    const m = document.getElementById('menu');
    m.classList.toggle('abierto');
    btn.setAttribute('aria-expanded', m.classList.contains('abierto') ? 'true' : 'false');
  };
  const datos = Promise.all([api('/api/config'), api('/api/sesion')]);
  await pantallaCarga();
  try {
    const [cfg, ses] = await datos;
    CONFIG = cfg;
    SESION = ses.usuario;
  } catch (e) {
    document.body.classList.remove('sin-sesion');
    $app.innerHTML = '<div class="mensaje error"><strong>No se pudo conectar con el servidor.</strong> Si el sitio estaba inactivo puede tardar hasta un minuto en despertar. ' +
      '<button class="btn mini sec" onclick="location.reload()">Reintentar</button></div>';
    return;
  }
  window.addEventListener('hashchange', enrutar);
  enrutar();
}
iniciar();
